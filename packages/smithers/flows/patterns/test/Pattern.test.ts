/**
 * `Pattern` on `@smthrs/flow` declarations.
 *
 * Every assertion is the one it was: which slot bindings are accepted, the
 * exact refusal each incompatible pair produces, what a decorator chain is
 * named, and what authority it clips. What moved is where the four facts a
 * decorator reads live: `@smthrs/core` carried `name`, `capabilities`,
 * `effects`, `input` and `output` as fields, and `@smthrs/flow` carries the tag
 * and the two schemas as fields and the ceiling and the envelope in the
 * annotation bag `Graph.build` consults.
 */
import { describe, it } from "@effect/vitest"
import { Flow } from "@smthrs/flow"
import * as Effects from "@smthrs/plan/Effects"
import * as Node from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Decorate from "../src/internal/Decorate.ts"
import * as Pattern from "../src/Pattern.ts"
import { PatternError } from "../src/PatternError.ts"

const effect = (
  reads: ReadonlyArray<string>,
  writes: ReadonlyArray<string> = []
): Effects.Declaration =>
  Effects.make({
    reads,
    writes,
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  })

/**
 * A declaration carrying exactly the pair of schemas a case needs.
 *
 * `Pattern.bind` and `Pattern.decorate` compare a slot's declared pair against
 * the pair a flow states, and that comparison is schema-shape agnostic: it
 * walks two JSON Schema documents. `@smthrs/flow`'s TYPE requires a payload to
 * be a struct, so the cast is what lets this suite keep comparing scalar
 * schemas and keep every refusal message it asserted before. No case here
 * builds a graph from one of these.
 */
const declaring = (input: Schema.Top, output: Schema.Top): Flow.Any =>
  Flow.make("pattern/probe", {
    payload: input as Flow.AnyStructSchema,
    success: output,
    error: Schema.Never,
    body: (value: unknown) => Node.succeed(value)
  }) as unknown as Flow.Any

/** The same, with a tag, a ceiling and an envelope the decorator cases read. */
const declaringAs = (
  tag: string,
  options: {
    readonly input: Schema.Top
    readonly output: Schema.Top
    readonly capabilities?: ReadonlyArray<string> | undefined
    readonly effects?: Effects.Declaration | undefined
  }
): Flow.Any =>
  Flow.make(tag, {
    payload: options.input as Flow.AnyStructSchema,
    success: options.output,
    error: Schema.Never,
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    ...(options.effects === undefined ? {} : { effects: options.effects }),
    body: (value: unknown) => Node.succeed(value)
  }) as unknown as Flow.Any

const bindInput = (expected: Schema.Top, actual: Schema.Top): Flow.Any =>
  Pattern.bind(
    Pattern.slot({ input: expected, output: Schema.Unknown }),
    declaring(actual, Schema.Unknown)
  )

describe("Pattern", () => {
  it("fails typed when a required slot has no binding", () => {
    const required = Pattern.slot({ input: Schema.String, output: Schema.String })

    try {
      Pattern.bind(required)
      throw new Error("expected Pattern.bind to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(PatternError)
      expect(error).toMatchObject({
        code: "missing_slot",
        message: "A required flow slot was not bound and has no default"
      })
    }
  })

  it("uses a compatible default and rejects incompatible bindings", () => {
    const fallback = declaringAs("fallback", { input: Schema.String, output: Schema.String })
    const declaration = Pattern.slot({
      input: Schema.String,
      output: Schema.String,
      default: fallback
    })

    expect(Pattern.bind(declaration)).toBe(fallback)
    expect(() => Pattern.bind(declaration, declaring(Schema.Number, Schema.String))).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "The bound flow has an incompatible input schema: expected String, received Number"
      })
    )
  })

  it("returns a frozen snapshot of the slot declaration", () => {
    const fallback = declaringAs("fallback", { input: Schema.String, output: Schema.String })
    const options: { input: typeof Schema.String; output: typeof Schema.String; default: Flow.Any | undefined } = {
      input: Schema.String,
      output: Schema.String,
      default: fallback
    }
    const declaration = Pattern.slot(options)

    // Dropping the default after the call must not turn the slot required.
    options.default = undefined

    expect(declaration).not.toBe(options)
    expect(Object.isFrozen(declaration)).toBe(true)
    expect(Pattern.bind(declaration)).toBe(fallback)
  })

  it("refuses a slot default that violates its own schemas", () => {
    const incompatible = declaring(Schema.Number, Schema.Number)

    expect(() => Pattern.slot({ input: Schema.String, output: Schema.String, default: incompatible })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "The slot default has an incompatible input schema: expected String, received Number"
      })
    )
  })

  it("reports a schema conversion failure separately from incompatibility", () => {
    const NonProjectable = Schema.String.pipe(
      Schema.check(
        Schema.makeFilter(() => true, {
          toJsonSchema: () => {
            throw new Error("no JSON Schema representation")
          }
        })
      )
    )
    const declaration = Pattern.slot({ input: Schema.String, output: Schema.String })

    expect(() => Pattern.bind(declaration, declaring(NonProjectable, Schema.String))).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message:
          "The bound flow input schemas cannot be compared because the actual input schema (String) has no JSON Schema form"
      })
    )

    expect(() =>
      Pattern.slot({
        input: NonProjectable,
        output: Schema.String,
        default: declaring(Schema.String, Schema.String)
      })
    ).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message:
          "The slot default input schemas cannot be compared because the expected input schema (String) has no JSON Schema form"
      })
    )
  })

  it("names the first JSON Schema path when Struct field types differ", () => {
    const expected = Schema.Struct({ name: Schema.String, age: Schema.String })
    const actual = Schema.Struct({ name: Schema.String, age: Schema.Number })

    expect(() => bindInput(expected, actual)).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message:
          "The bound flow has an incompatible input schema: both schemas are Objects and they first differ at schema.properties.age.anyOf"
      })
    )
  })

  it("names a Struct field present on only one side in either direction", () => {
    const narrow = Schema.Struct({ name: Schema.String })
    const wide = Schema.Struct({ name: Schema.String, extra: Schema.String })
    const refusal = {
      code: "invalid_decorator",
      message:
        "The bound flow has an incompatible input schema: both schemas are Objects and they first differ at schema.properties.extra"
    }

    expect(() => bindInput(narrow, wide)).toThrow(expect.objectContaining(refusal))
    expect(() => bindInput(wide, narrow)).toThrow(expect.objectContaining(refusal))
  })

  it("names ordered-array length and element differences", () => {
    const two = Schema.Union([Schema.Literal("a"), Schema.Literal("b")])
    const three = Schema.Union([Schema.Literal("a"), Schema.Literal("b"), Schema.Literal("c")])
    const changed = Schema.Union([Schema.Literal("a"), Schema.Literal("c")])

    expect(() => bindInput(two, three)).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message:
          "The bound flow has an incompatible input schema: both schemas are Union and they first differ at schema.enum"
      })
    )
    expect(() => bindInput(two, changed)).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message:
          "The bound flow has an incompatible input schema: both schemas are Union and they first differ at schema.enum[1]"
      })
    )
  })

  it("names a same-tag scalar leaf difference", () => {
    expect(() => bindInput(Schema.Literal("a"), Schema.Literal("b"))).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message:
          "The bound flow has an incompatible input schema: both schemas are Literal and they first differ at schema.enum[0]"
      })
    )
  })

  it("accepts distinct schemas with identical JSON Schema documents", () => {
    const expected = Schema.Struct({ value: Schema.Null, name: Schema.String })
    const actual = Schema.Struct({ value: Schema.Null, name: Schema.String })

    expect(() => bindInput(expected, actual)).not.toThrow()
  })

  it("ignores object-key declaration order when schemas are otherwise identical", () => {
    const expected = Schema.Struct({
      alpha: Schema.optionalKey(Schema.String),
      beta: Schema.optionalKey(Schema.Number)
    })
    const actual = Schema.Struct({
      beta: Schema.optionalKey(Schema.Number),
      alpha: Schema.optionalKey(Schema.String)
    })

    expect(() => bindInput(expected, actual)).not.toThrow()
  })

  it("binds the struct payload a real @smthrs/flow declaration states", () => {
    // Every flow this package composes states a STRUCT payload, so the slot a
    // caller writes over one is the case the port has to keep working.
    const Request = Schema.Struct({ query: Schema.String })
    const supplied = Flow.make("pattern/search", {
      payload: Request,
      success: Schema.String,
      error: Schema.Never,
      body: ({ query }) => Node.succeed(query)
    })
    const slot = Pattern.slot({ input: Request, output: Schema.String })

    expect(Pattern.bind(slot, supplied as unknown as Flow.Any)).toBe(supplied)
    expect(() => Pattern.bind(slot, declaring(Schema.Struct({ query: Schema.Number }), Schema.String))).toThrow(
      expect.objectContaining({ code: "invalid_decorator" })
    )
  })

  it("checks input contravariance and output covariance against an independent seeded oracle", () => {
    type Kind = "never" | "top" | "string" | "number"
    interface SchemaCase {
      readonly kind: Kind
      readonly schema: Schema.Top
    }
    const cases: ReadonlyArray<SchemaCase> = [
      { kind: "never", schema: Schema.Never },
      { kind: "top", schema: Schema.Unknown },
      { kind: "top", schema: Schema.Any },
      { kind: "string", schema: Schema.String },
      {
        kind: "string",
        schema: Schema.String.pipe(Schema.check(Schema.makeFilter(() => true)))
      },
      { kind: "number", schema: Schema.Number }
    ]
    const acceptedInputs: Readonly<Record<Kind, ReadonlyArray<Kind>>> = {
      never: ["never", "top", "string", "number"],
      top: ["top"],
      string: ["top", "string"],
      number: ["top", "number"]
    }
    const acceptedOutputs: Readonly<Record<Kind, ReadonlyArray<Kind>>> = {
      never: ["never"],
      top: ["never", "top", "string", "number"],
      string: ["never", "string"],
      number: ["never", "number"]
    }
    let seed = 0x5eedc0de
    const pick = (): SchemaCase => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      return cases[seed % cases.length]!
    }
    const generated = Array.from({ length: 128 }, () => [pick(), pick()] as const)

    for (const [expected, actual] of generated) {
      const inputFlow = declaring(actual.schema, Schema.Unknown)
      const inputSlot = Pattern.slot({ input: expected.schema, output: Schema.Unknown })
      if (acceptedInputs[expected.kind].includes(actual.kind)) {
        expect(Pattern.bind(inputSlot, inputFlow)).toBe(inputFlow)
      } else {
        expect(() => Pattern.bind(inputSlot, inputFlow)).toThrow(
          expect.objectContaining({
            code: "invalid_decorator",
            message:
              `The bound flow has an incompatible input schema: expected ${expected.schema.ast._tag}, received ${actual.schema.ast._tag}`
          })
        )
      }

      const outputFlow = declaring(Schema.Never, actual.schema)
      const outputSlot = Pattern.slot({ input: Schema.Never, output: expected.schema })
      if (acceptedOutputs[expected.kind].includes(actual.kind)) {
        expect(Pattern.bind(outputSlot, outputFlow)).toBe(outputFlow)
      } else {
        expect(() => Pattern.bind(outputSlot, outputFlow)).toThrow(
          expect.objectContaining({
            code: "invalid_decorator",
            message:
              `The bound flow has an incompatible output schema: expected ${expected.schema.ast._tag}, received ${actual.schema.ast._tag}`
          })
        )
      }
    }
  })

  it("derives decorator-chain names and clips capabilities at every layer", () => {
    const search = declaringAs("search", {
      input: Schema.String,
      output: Schema.String,
      capabilities: ["fs:read", "net:get"],
      effects: effect(["workspace/**"])
    })
    const withAudit: Pattern.Decorator = (inner) =>
      declaringAs(`withAudit(${inner._tag})`, {
        input: inner.payloadSchema,
        output: inner.successSchema,
        capabilities: ["fs:read", "audit:write"],
        effects: effect(["workspace/file"])
      })
    const withTrace: Pattern.Decorator = (inner) =>
      declaringAs(`withTrace(${inner._tag})`, {
        input: inner.payloadSchema,
        output: inner.successSchema,
        capabilities: ["fs:read", "trace:write"],
        effects: effect(["workspace/file"])
      })

    const decorated = Pattern.decorateAll(search, [withAudit, withTrace])

    expect(decorated._tag).toBe("withTrace(withAudit(search))")
    expect(Decorate.capabilitiesOf(decorated)).toEqual(["fs:read"])
    expect(Decorate.envelopeOf(decorated)?.reads).toEqual(["workspace/file"])
  })

  it("reports clipping and refuses to launder a wider effect envelope", () => {
    const template = declaringAs("template", {
      input: Schema.String,
      output: Schema.String,
      capabilities: ["fs:read"],
      effects: effect(["workspace/**"])
    })
    const supplied = declaringAs("supplied", {
      input: Schema.String,
      output: Schema.String,
      capabilities: ["fs:read", "net:admin"],
      effects: Effects.make({
        reads: ["workspace/item", "secret/item"],
        writes: ["secret/item"],
        mode: "expected",
        onConflict: "fail",
        tier: "irreversible"
      })
    })
    const report = Pattern.clipped(template, supplied)

    expect(report).toEqual({
      capabilities: ["net:admin"],
      reads: ["secret/item"],
      writes: ["secret/item"],
      mode: true,
      tier: true
    })
    // A decorator result named differently from the wrapped flow keeps its own name.
    expect(() => Pattern.decorate(template, () => supplied)).toThrow(
      expect.objectContaining({
        code: "envelope_conflict",
        message: "Decorator \"supplied\" widens the wrapped flow's declared effect envelope"
      })
    )
  })

  it("reports clipping when only the supplied declaration covers a path", () => {
    const template = declaringAs("template", {
      input: Schema.String,
      output: Schema.String,
      effects: effect(["workspace/item"])
    })
    const supplied = declaringAs("supplied", {
      input: Schema.String,
      output: Schema.String,
      effects: effect(["workspace/**"])
    })

    expect(Pattern.clipped(template, supplied).reads).toEqual(["workspace/**"])
  })

  it("reports every supplied effect when the template declares no envelope", () => {
    const template = declaringAs("template", { input: Schema.String, output: Schema.String })
    const supplied = declaringAs("supplied", {
      input: Schema.String,
      output: Schema.String,
      effects: Effects.make({
        reads: ["workspace/item"],
        writes: ["workspace/out"],
        mode: "expected",
        onConflict: "serialize",
        tier: "compensable"
      })
    })

    expect(Pattern.clipped(template, supplied)).toMatchObject({
      reads: ["workspace/item"],
      writes: ["workspace/out"],
      mode: true,
      tier: true
    })
  })

  it("intersects omitted and narrowed tiers under both effect modes", () => {
    const flow = (declaration: Effects.Declaration) =>
      declaringAs("tiered", { input: Schema.String, output: Schema.String, effects: declaration })
    const withoutTier = (reads: ReadonlyArray<string>, mode: "expected" | "hermetic") =>
      Effects.make({ reads, writes: [], mode, onConflict: "serialize" })
    const tiered = (
      reads: ReadonlyArray<string>,
      mode: "expected" | "hermetic",
      tier: "sealed" | "irreversible"
    ) => Effects.make({ reads, writes: [], mode, onConflict: "serialize", tier })

    expect(Pattern.clipped(
      flow(withoutTier(["workspace/allowed"], "hermetic")),
      flow(withoutTier(["workspace/outside"], "expected"))
    )).toMatchObject({ reads: ["workspace/outside"], mode: true, tier: false })
    expect(Pattern.clipped(
      flow(tiered(["workspace/allowed"], "expected", "irreversible")),
      flow(tiered(["workspace/outside"], "expected", "sealed"))
    )).toMatchObject({ reads: ["workspace/outside"], mode: false, tier: false })
    expect(Pattern.clipped(
      flow(tiered(["workspace/allowed"], "expected", "irreversible")),
      flow(tiered(["workspace/outside"], "hermetic", "sealed"))
    )).toMatchObject({ reads: ["workspace/outside"], mode: false, tier: false })
  })

  it("drops an envelope the wrapper narrowed away rather than inheriting the wrapped one", () => {
    // Capabilities and the envelope are annotations in `@smthrs/flow`, so a
    // wrapper that merged the inner bags unchanged would hand itself back the
    // authority it just narrowed.
    const template = declaringAs("template", {
      input: Schema.String,
      output: Schema.String,
      capabilities: ["fs:read", "net:get"],
      effects: effect(["workspace/**"])
    })
    const decorated = Pattern.decorate(
      template,
      (inner) => declaringAs("plain", { input: inner.payloadSchema, output: inner.successSchema })
    )

    expect(Decorate.capabilitiesOf(decorated)).toEqual([])
    expect(Decorate.envelopeOf(decorated)).toBeUndefined()
  })

  it("derives the composed name when the decorator result keeps the wrapped flow's name", () => {
    const template = declaringAs("template", { input: Schema.String, output: Schema.String })
    const decorator: Pattern.Decorator = (inner) =>
      declaringAs(inner._tag, { input: inner.payloadSchema, output: inner.successSchema })

    expect(Pattern.decorate(template, decorator)._tag).toBe("decorator(template)")
  })

  it("refuses decorators that return a non-flow or change either schema", () => {
    const template = declaringAs("template", { input: Schema.String, output: Schema.String })

    expect(() => Pattern.decorate(template, () => "not-a-flow" as unknown as Flow.Any)).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "A flow decorator must return a Flow" })
    )
    expect(() => Pattern.decorate(template, () => declaring(Schema.Number, Schema.String))).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "The flow decorator result has an incompatible input schema: expected String, received Number"
      })
    )
    expect(() => Pattern.decorate(template, () => declaring(Schema.String, Schema.Number))).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "The flow decorator result has an incompatible output schema: expected String, received Number"
      })
    )
  })
})
