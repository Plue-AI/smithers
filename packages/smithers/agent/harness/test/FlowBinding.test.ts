/**
 * The executable-flow binding contract.
 *
 * The properties under test are the ones the whole cell path leans on: a flow
 * declaration and its handler are one thing; a correctable failure is data the
 * cell catches while a permission park is not; and a catalog refuses to let two
 * declarations share one name, because that is how a descriptor ends up
 * dispatched to somebody else's implementation.
 */
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as Digest from "@smthrs/core/Digest"
import * as Flow from "@smthrs/core/Flow"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import { Cause, Context, Effect, Exit, Option, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as FlowBinding from "../src/FlowBinding.ts"
import { HarnessError } from "../src/HarnessError.ts"

const Echo = Schema.Struct({ text: Schema.String })
const Echoed = Schema.Struct({ text: Schema.String, length: Schema.Number })

const echo = Flow.make({
  name: "echo",
  description: "Echo one string back.",
  input: Echo,
  output: Echoed,
  capabilities: ["fs:read:/**"],
  effects: { reads: ["/**"], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" }
})

/**
 * A declaration that names nothing.
 *
 * Written structurally rather than through a flow constructor, because the
 * property under test belongs to {@link FlowBinding.catalogResult}: every
 * constructor the repository ships refuses an anonymous declaration itself, so
 * building the case through one would assert the constructor's refusal instead
 * of the catalog's.
 */
const nameless = {
  input: Schema.Struct({}),
  output: Schema.Struct({}),
  capabilities: [],
  effects: undefined
} as const satisfies FlowBinding.Declared & { readonly input: Schema.Top; readonly output: Schema.Top }

const call = (
  flowName: string,
  input: unknown,
  overrides: { readonly declaration?: string } = {}
): Cell.Call =>
  new Cell.Call({
    flowName,
    input: input as typeof Schema.Json.Type,
    capabilities: [],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
    placement: Option.none(),
    identity: new Cell.CallIdentity({
      session: "session-1",
      frame: 0,
      cell: "cell-digest",
      ordinal: 0,
      declaration: overrides.declaration ?? "declaration-digest",
      layers: []
    })
  })

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> => Effect.runPromiseExit(effect)

describe("FlowBinding.descriptorOf", () => {
  it("projects a flow declaration without inventing a second registry shape", () => {
    const descriptor = FlowBinding.descriptorOf(echo)

    expect(descriptor.name).toBe("echo")
    expect(descriptor.description).toBe("Echo one string back.")
    expect(descriptor.capabilities).toEqual(["fs:read:/**"])
    expect(descriptor.effects.tier).toBe("sealed")
    expect(descriptor.modelInvocable).toBe(true)
    expect(descriptor.body).toMatchObject({ _tag: "Module", path: "binding://echo" })
    expect(descriptor.input).toMatchObject({ _tag: "Module", field: "input" })
    expect(descriptor.provenance.source).toBe("binding")
    // A descriptor projected from a declaration is an ordinary descriptor, so
    // the digest the boundary checks is the one the same descriptor written
    // out by hand carries, including every field left unasserted above.
    const path = "binding://echo"
    const effects = { reads: ["/**"], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" } as const
    const written = new Descriptor.FlowDescriptor({
      name: "echo",
      description: "Echo one string back.",
      body: new Descriptor.BodyRefModule({
        path,
        contentDigest: Digest.digest(Digest.canonical({
          capabilities: ["fs:read:/**"],
          description: "Echo one string back.",
          effects,
          name: "echo"
        }))
      }),
      input: new Descriptor.SchemaRefModule({ path, field: "input" }),
      output: new Descriptor.SchemaRefModule({ path, field: "output" }),
      model: Option.none(),
      flows: [],
      capabilities: ["fs:read:/**"],
      effects,
      placement: Option.none(),
      modelInvocable: true,
      path,
      frontmatter: {},
      provenance: new Descriptor.Provenance({ source: "binding", root: "binding://" })
    })
    expect(Cell.declarationDigest(descriptor)).toBe(Cell.declarationDigest(written))
  })

  it("defaults an undeclared effect envelope to the unshareable tier", () => {
    const bare = Flow.make({ name: "bare", input: Schema.Struct({}), output: Schema.Struct({}) })
    const descriptor = FlowBinding.descriptorOf(bare)

    expect(descriptor.effects).toEqual({
      reads: [],
      writes: [],
      mode: "expected",
      onConflict: "serialize",
      tier: "irreversible"
    })
    expect(descriptor.description).toBe("")
  })

  it("accepts host metadata a declaration cannot carry", () => {
    const descriptor = FlowBinding.descriptorOf(echo, {
      name: "renamed",
      path: "mcp://server/echo",
      modelInvocable: false,
      placement: Option.some("remote"),
      provenance: new Descriptor.Provenance({ source: "mcp", root: "server" })
    })

    expect(descriptor.name).toBe("renamed")
    expect(descriptor.path).toBe("mcp://server/echo")
    expect(descriptor.modelInvocable).toBe(false)
    expect(descriptor.placement).toEqual(Option.some("remote"))
    expect(descriptor.provenance.source).toBe("mcp")
  })

  it("uses an explicit schema document instead of the module locator", () => {
    const inputDocument = { type: "object", required: ["query"] } as const
    const descriptor = FlowBinding.descriptorOf(echo, { inputDocument })

    expect(descriptor.input).toStrictEqual(new Descriptor.SchemaRefInline({ document: inputDocument }))
    expect(descriptor.output).toMatchObject({ _tag: "Module", field: "output" })
  })

  it("names an unnamed declaration with the empty string a catalog then refuses", () => {
    const descriptor = FlowBinding.descriptorOf({ capabilities: [], effects: undefined })

    expect(descriptor.name).toBe("")
    expect(descriptor.path).toBe("binding://")
    expect(descriptor.body).toMatchObject({ path: "binding://" })
  })
})

describe("FlowBinding.make", () => {
  it("carries projectable input and output schemas by value", () => {
    const binding = FlowBinding.make({
      flow: echo,
      handler: (input) => Effect.succeed({ text: input.text, length: input.text.length })
    })

    expect(binding.descriptor.input).toStrictEqual(
      new Descriptor.SchemaRefInline({ document: Schema.toJsonSchemaDocument(Echo, { onExcessProperty: "error" }) })
    )
    expect(binding.descriptor.output).toStrictEqual(
      new Descriptor.SchemaRefInline({ document: Schema.toJsonSchemaDocument(Echoed, { onExcessProperty: "error" }) })
    )
  })

  it("keeps an explicit schema document instead of projecting the declaration", () => {
    const inputDocument = { type: "object", properties: { raw: { type: "string" } } } as const
    const binding = FlowBinding.make({
      flow: echo,
      inputDocument,
      handler: (input) => Effect.succeed({ text: input.text, length: input.text.length })
    })

    expect(binding.descriptor.input).toStrictEqual(new Descriptor.SchemaRefInline({ document: inputDocument }))
  })

  it("keeps an explicit output document, alone and beside an explicit input one", () => {
    const outputDocument = { type: "object", properties: { total: { type: "number" } } } as const
    const inputDocument = { type: "object", properties: { raw: { type: "string" } } } as const
    const handler = (input: typeof Echo.Type) => Effect.succeed({ text: input.text, length: input.text.length })

    const outputOnly = FlowBinding.make({ flow: echo, outputDocument, handler })
    const both = FlowBinding.make({ flow: echo, inputDocument, outputDocument, handler })

    expect(outputOnly.descriptor.output).toStrictEqual(new Descriptor.SchemaRefInline({ document: outputDocument }))
    // The unspecified half is still projected from the declaration.
    expect(outputOnly.descriptor.input).toStrictEqual(
      new Descriptor.SchemaRefInline({ document: Schema.toJsonSchemaDocument(Echo, { onExcessProperty: "error" }) })
    )
    expect(both.descriptor.input).toStrictEqual(new Descriptor.SchemaRefInline({ document: inputDocument }))
    expect(both.descriptor.output).toStrictEqual(new Descriptor.SchemaRefInline({ document: outputDocument }))
  })

  it("falls back to the module locator when an input schema cannot be projected", () => {
    const NonProjectable = Schema.String.pipe(
      Schema.check(
        Schema.makeFilter(() => true, {
          toJsonSchema: () => {
            throw new Error("no JSON Schema representation")
          }
        })
      )
    )
    const binding = FlowBinding.make({
      flow: Flow.make({ name: "opaque", input: NonProjectable, output: Schema.Struct({}) }),
      handler: () => Effect.succeed({})
    })

    expect(binding.descriptor.input).toMatchObject({ _tag: "Module", field: "input" })
    expect(binding.descriptor.output._tag).toBe("Inline")
  })

  it("decodes input, runs the handler, and validates output through the declared schemas", async () => {
    const binding = FlowBinding.make({
      flow: echo,
      handler: (input) => Effect.succeed({ text: input.text, length: input.text.length })
    })

    const exit = await run(binding.run(call("echo", { text: "hi" })))

    expect(exit).toStrictEqual(
      Exit.succeed(new Cell.CallResult({ outcome: "success", value: { text: "hi", length: 2 } }))
    )
  })

  it("refuses malformed input catchably instead of running the handler", async () => {
    let ran = false
    const binding = FlowBinding.make({
      flow: echo,
      handler: (input) =>
        Effect.sync(() => {
          ran = true
          return { text: input.text, length: 0 }
        })
    })

    const exit = await run(binding.run(call("echo", { text: 7 })))

    expect(ran).toBe(false)
    expect(Exit.isSuccess(exit) && exit.value.outcome).toBe("failure")
    expect(Exit.isSuccess(exit) && exit.value.code).toBe("invalid_input")
    expect(Exit.isSuccess(exit) && exit.value.message).toContain("rejected its input")
  })

  it("treats a null optional field as omitted", async () => {
    const Input = Schema.Struct({ env: Schema.optional(Schema.String) })
    let observed: unknown
    const binding = FlowBinding.make({
      flow: Flow.make({ name: "optional", input: Input, output: Schema.Struct({}) }),
      handler: (input) =>
        Effect.sync(() => {
          observed = input
          return {}
        })
    })

    const exit = await run(binding.run(call("optional", { env: null })))

    expect(exit).toMatchObject({ _tag: "Success", value: { outcome: "success" } })
    expect(observed).toEqual({})
  })

  it("treats a missing input as {} when every field is optional", async () => {
    const Input = Schema.Struct({ env: Schema.optional(Schema.String) })
    const observed: Array<unknown> = []
    const binding = FlowBinding.make({
      flow: Flow.make({ name: "list", input: Input, output: Schema.Struct({}) }),
      handler: (input) =>
        Effect.sync(() => {
          observed.push(input)
          return {}
        })
    })

    // A cell's `ctx.call("list")` and `ctx.call("list", undefined)` cross the realm as JSON null.
    const exit = await run(binding.run(call("list", null)))

    expect(exit).toMatchObject({ _tag: "Success", value: { outcome: "success" } })
    expect(observed).toEqual([{}])
  })

  it("refuses a missing input when the schema requires a field", async () => {
    const binding = FlowBinding.make({ flow: echo, handler: () => Effect.die("unreachable") })
    const rejection = Schema.decodeUnknownResult(Echo)(null)
    const rejected = Result.isFailure(rejection) ? rejection.failure.message : ""

    const exit = await run(binding.run(call("echo", null)))

    expect(Exit.isSuccess(exit) && exit.value.message).toBe(
      `Flow echo rejected its input: ${rejected}. Re-read ctx.flows and reissue the call.`
    )
  })

  it("reports the original failure when input remains invalid without nulls", async () => {
    const Input = Schema.Struct({ env: Schema.optional(Schema.String), count: Schema.Number })
    const input = { env: null, count: "many" }
    const original = Schema.decodeUnknownResult(Input)(input)
    const retried = Schema.decodeUnknownResult(Input)({ count: "many" })
    const binding = FlowBinding.make({
      flow: Flow.make({ name: "count", input: Input, output: Schema.Struct({}) }),
      handler: () => Effect.succeed({})
    })

    const exit = await run(binding.run(call("count", input)))
    const originalMessage = Result.isFailure(original) ? original.failure.message : ""
    const retriedMessage = Result.isFailure(retried) ? retried.failure.message : ""

    expect(originalMessage).not.toBe(retriedMessage)
    expect(Exit.isSuccess(exit) && exit.value.message).toBe(
      `Flow count rejected its input: ${originalMessage}. Re-read ctx.flows and reissue the call.`
    )
    expect(Exit.isSuccess(exit) && exit.value.code).toBe("invalid_input")
  })

  it("refuses a call input that is not an object at all", async () => {
    let ran = false
    const binding = FlowBinding.make({
      flow: echo,
      handler: (input) =>
        Effect.sync(() => {
          ran = true
          return { text: input.text, length: 0 }
        })
    })
    const rejection = Schema.decodeUnknownResult(Echo)("just a string")
    const rejected = Result.isFailure(rejection) ? rejection.failure.message : ""

    const exits = await Promise.all(
      ["just a string", ["one"], null, 7].map((input) => run(binding.run(call("echo", input))))
    )

    // The omission retry only handles top-level properties of a record; a string,
    // an array, and null itself are returned untouched, so the retry reports
    // the same rejection the first attempt did.
    expect(ran).toBe(false)
    expect(exits.map((exit) => Exit.isSuccess(exit) && exit.value.outcome)).toEqual([
      "failure",
      "failure",
      "failure",
      "failure"
    ])
    expect(Exit.isSuccess(exits[0]!) && exits[0]!.value.message).toBe(
      `Flow echo rejected its input: ${rejected}. Re-read ctx.flows and reissue the call.`
    )
  })

  it("bounds a long input rejection before it enters the call ledger", async () => {
    const field = `required_${"x".repeat(800)}`
    const Input = Schema.Struct({ [field]: Schema.String })
    const binding = FlowBinding.make({
      flow: Flow.make({ name: "bounded-input", input: Input, output: Schema.Struct({}) }),
      handler: () => Effect.succeed({})
    })

    const exit = await run(binding.run(call("bounded-input", {})))
    const message = Exit.isSuccess(exit) ? exit.value.message : undefined

    expect(Exit.isSuccess(exit) && exit.value.code).toBe("invalid_input")
    expect(message).toContain("reissue the call to see the whole failure")
    expect(message?.length).toBeLessThan(700)
  })

  it("preserves null when the input schema accepts it", async () => {
    const Input = Schema.Struct({ env: Schema.NullOr(Schema.String) })
    let observed: unknown
    const binding = FlowBinding.make({
      flow: Flow.make({ name: "nullable", input: Input, output: Schema.Struct({}) }),
      handler: (input) =>
        Effect.sync(() => {
          observed = input
          return {}
        })
    })

    const exit = await run(binding.run(call("nullable", { env: null })))

    expect(exit).toMatchObject({ _tag: "Success", value: { outcome: "success" } })
    expect(observed).toEqual({ env: null })
  })

  it.each([
    { status: 401, request: { headers: { Authorization: "Bearer SYNTHETIC_HOST_ONLY_TOKEN" } } },
    { request: { url: "https://user:SYNTHETIC_PASSWORD@example.invalid/?api_key=SYNTHETIC_QUERY_SECRET" } },
    new Error("Authorization: Bearer SYNTHETIC_ERROR_SECRET"),
    "https://example.invalid/?api_key=SYNTHETIC_STRING_SECRET"
  ])("keeps host credentials out of call results for failure %#", async (failure) => {
    const binding = FlowBinding.make({
      flow: Flow.make({ name: "lookup", input: Schema.Struct({}), output: Schema.Struct({}) }),
      handler: () => Effect.fail(failure)
    })

    const result = await Effect.runPromise(binding.run(call("lookup", {})))

    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_")
    expect(result).toStrictEqual(
      new Cell.CallResult({
        outcome: "failure",
        value: null,
        code: "flow_failed",
        message: "Flow lookup failed."
      })
    )
  })

  it("preserves nullable fields when another optional field rejects null", async () => {
    const Input = Schema.Struct({
      content: Schema.optional(Schema.NullOr(Schema.String)),
      limit: Schema.optional(Schema.Number)
    })
    let observed: unknown
    const binding = FlowBinding.make({
      flow: Flow.make({ name: "mixed", input: Input, output: Schema.Struct({}) }),
      handler: (input) =>
        Effect.sync(() => {
          observed = input
          return {}
        })
    })
    const input = { content: null, limit: null }

    const exit = await run(binding.run(call("mixed", input)))

    expect(exit).toMatchObject({ _tag: "Success", value: { outcome: "success" } })
    expect(observed).toEqual({ content: null })
    expect(input).toEqual({ content: null, limit: null })
  })

  it("preserves required nullable and nested values during optional-key omission", async () => {
    const Input = Schema.Struct({
      content: Schema.NullOr(Schema.String),
      limit: Schema.optionalKey(Schema.Number),
      nested: Schema.Struct({ value: Schema.NullOr(Schema.String) }),
      count: Schema.Number
    })
    let observed: unknown
    const binding = FlowBinding.make({
      flow: Flow.make({ name: "mixed", input: Input, output: Schema.Struct({}) }),
      handler: (input) =>
        Effect.sync(() => {
          observed = input
          return {}
        })
    })

    const exit = await run(binding.run(call("mixed", {
      content: null,
      limit: null,
      nested: { value: null },
      count: 2
    })))

    expect(exit).toMatchObject({ _tag: "Success", value: { outcome: "success" } })
    expect(observed).toEqual({ content: null, nested: { value: null }, count: 2 })
  })

  it("does not omit null-valued record entries", async () => {
    const Input = Schema.Record(Schema.String, Schema.Number)
    let ran = false
    const binding = FlowBinding.make({
      flow: Flow.make({ name: "record", input: Input, output: Schema.Struct({}) }),
      handler: () =>
        Effect.sync(() => {
          ran = true
          return {}
        })
    })

    const exit = await run(binding.run(call("record", { limit: null })))

    expect(exit).toMatchObject({ _tag: "Success", value: { outcome: "failure", code: "invalid_input" } })
    expect(ran).toBe(false)
  })

  it("turns an ordinary handler failure into a catchable call failure", async () => {
    const binding = FlowBinding.make({
      flow: echo,
      handler: () => Effect.fail(new Error("the file was busy"))
    })

    const exit = await run(binding.run(call("echo", { text: "hi" })))

    expect(Exit.isSuccess(exit) && exit.value.outcome).toBe("failure")
    expect(Exit.isSuccess(exit) && exit.value.code).toBe("flow_failed")
    expect(Exit.isSuccess(exit) && exit.value.message).toBe("Flow echo failed.")
  })

  it("reports a handler failure the binding recognises as its own timeout, with its limit when it says", async () => {
    const binding = FlowBinding.make({
      flow: echo,
      handler: (input) => Effect.fail({ text: input.text, detail: `${input.text} ran too long` }),
      publicError: (error) => error.detail,
      timedOut: (error) =>
        error.text === "slow" ? { limitMillis: 250 } : error.text === "unsaid" ? {} : undefined
    })

    const slow = await Effect.runPromise(binding.run(call("echo", { text: "slow" })))
    const unsaid = await Effect.runPromise(binding.run(call("echo", { text: "unsaid" })))
    const busy = await Effect.runPromise(binding.run(call("echo", { text: "busy" })))

    expect(slow).toStrictEqual(
      new Cell.CallResult({
        outcome: "failure",
        value: { limitMillis: 250 },
        code: "timeout",
        message: "Flow echo failed: slow ran too long"
      })
    )
    expect(unsaid).toStrictEqual(
      new Cell.CallResult({
        outcome: "failure",
        value: null,
        code: "timeout",
        message: "Flow echo failed: unsaid ran too long"
      })
    )
    expect(busy).toStrictEqual(
      new Cell.CallResult({
        outcome: "failure",
        value: null,
        code: "flow_failed",
        message: "Flow echo failed: busy ran too long"
      })
    )
  })

  it("bounds explicitly public handler failure text before it enters later frames", async () => {
    const binding = FlowBinding.make({
      flow: echo,
      handler: () => Effect.fail({ publicDetail: "x".repeat(1_000) }),
      publicError: (error) => error.publicDetail
    })

    const exit = await run(binding.run(call("echo", { text: "hi" })))
    const message = Exit.isSuccess(exit) ? exit.value.message : undefined

    expect(Exit.isSuccess(exit) && exit.value.code).toBe("flow_failed")
    expect(message).toContain("ask the host for the full public failure")
    expect(message?.length).toBeLessThan(650)
  })

  it("keeps non-Error failure values opaque", async () => {
    const stringFailure = FlowBinding.make({ flow: echo, handler: () => Effect.fail("plain refusal") })
    const taggedFailure = FlowBinding.make({ flow: echo, handler: () => Effect.fail({ message: "tagged refusal" }) })
    const opaqueFailure = FlowBinding.make({ flow: echo, handler: () => Effect.fail({ code: 12 }) })

    const rendered = await Promise.all(
      [stringFailure, taggedFailure, opaqueFailure].map(async (binding) => {
        const exit = await run(binding.run(call("echo", { text: "hi" })))
        return Exit.isSuccess(exit) ? exit.value.message : undefined
      })
    )

    expect(rendered).toEqual([
      "Flow echo failed.",
      "Flow echo failed.",
      "Flow echo failed."
    ])
  })

  it("keeps failure values with no message and no JSON form opaque", async () => {
    const undefinedFailure = FlowBinding.make({ flow: echo, handler: () => Effect.fail(undefined) })
    const symbolFailure = FlowBinding.make({ flow: echo, handler: () => Effect.fail(Symbol("refused")) })

    const rendered = await Promise.all(
      [undefinedFailure, symbolFailure].map(async (binding) => {
        const exit = await run(binding.run(call("echo", { text: "hi" })))
        return Exit.isSuccess(exit) ? exit.value.message : undefined
      })
    )

    expect(rendered).toEqual([
      "Flow echo failed.",
      "Flow echo failed."
    ])
  })

  it("settles a cyclic handler failure as catchable data", async () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const binding = FlowBinding.make({ flow: echo, handler: () => Effect.fail(cyclic) })

    const exit = await run(binding.run(call("echo", { text: "hi" })))

    expect(exit).toMatchObject({
      _tag: "Success",
      value: {
        outcome: "failure",
        code: "flow_failed",
        message: "Flow echo failed."
      }
    })
  })

  it("settles a BigInt-bearing handler failure as catchable data", async () => {
    const binding = FlowBinding.make({ flow: echo, handler: () => Effect.fail({ big: 1n }) })

    const exit = await run(binding.run(call("echo", { text: "hi" })))

    expect(exit).toMatchObject({
      _tag: "Success",
      value: {
        outcome: "failure",
        code: "flow_failed",
        message: "Flow echo failed."
      }
    })
  })

  it("settles a failure whose every read throws as catchable data", async () => {
    // Unknown failures must not be inspected or serialized, even when their
    // accessors would throw.
    const hostile = new Error("unreadable")
    Object.defineProperty(hostile, "message", {
      get: () => {
        throw new Error("message getter")
      }
    })
    Object.defineProperty(hostile, "toJSON", {
      value: () => {
        throw new Error("toJSON")
      }
    })
    Object.defineProperty(hostile, "toString", {
      value: () => {
        throw new Error("toString")
      }
    })
    const binding = FlowBinding.make({ flow: echo, handler: () => Effect.fail(hostile) })

    const exit = await run(binding.run(call("echo", { text: "hi" })))

    expect(exit).toMatchObject({
      _tag: "Success",
      value: {
        outcome: "failure",
        code: "flow_failed",
        message: "Flow echo failed."
      }
    })
  })

  it("publishes only details explicitly selected by the typed renderer", async () => {
    const failure = { status: 404, request: { headers: { Authorization: "SYNTHETIC_SECRET" } } }
    let observed: unknown
    const binding = FlowBinding.make({
      flow: echo,
      handler: () => Effect.fail(failure),
      publicError: (error) => {
        observed = error
        return `Lookup returned status ${error.status}.`
      }
    })

    const result = await Effect.runPromise(binding.run(call("echo", { text: "hi" })))

    expect(observed).toBe(failure)
    expect(result.message).toBe("Flow echo failed: Lookup returned status 404.")
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET")
  })

  it.each(["declined", "thrown", "invalid"])("uses the opaque default for a %s public renderer", async (mode) => {
    const binding = FlowBinding.make({
      flow: echo,
      handler: () => Effect.fail(new Error("SYNTHETIC_SECRET")),
      publicError: () => {
        if (mode === "thrown") throw new Error("SYNTHETIC_RENDERER_SECRET")
        if (mode === "invalid") return { secret: "SYNTHETIC_SECRET" } as unknown as string
        return undefined
      }
    })

    const result = await Effect.runPromise(binding.run(call("echo", { text: "hi" })))

    expect(result.message).toBe("Flow echo failed.")
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_")
  })

  it("keeps a permission requirement in the typed channel where a cell cannot swallow it", async () => {
    const required = new Permission.PermissionRequired({
      requestId: "request-1",
      capability: Capability.make("fs:write", "**"),
      tier: "irreversible",
      meta: {}
    })
    const binding = FlowBinding.make({ flow: echo, handler: () => Effect.fail(required) })

    const exit = await run(binding.run(call("echo", { text: "hi" })))

    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error).toMatchObject({ _tag: "/harness/HarnessError", code: "suspended", cause: required })
  })

  it("keeps a permission denial and a harness failure in the typed channel too", async () => {
    const denied = Permission.permissionDenied(Capability.make("fs:write", "**"), "policy")
    const harness = new HarnessError({ code: "engine_failed", message: "the realm could not open" })

    let rendered = false
    const publicError = () => {
      rendered = true
      return "Should not reach the cell."
    }
    const deniedExit = await run(
      FlowBinding.make({ flow: echo, handler: () => Effect.fail(denied), publicError }).run(
        call("echo", { text: "hi" })
      )
    )
    const harnessExit = await run(
      FlowBinding.make({ flow: echo, handler: () => Effect.fail(harness), publicError }).run(
        call("echo", { text: "hi" })
      )
    )

    expect(Exit.isFailure(deniedExit) ? Cause.squash(deniedExit.cause) : undefined).toMatchObject({
      code: "suspended"
    })
    expect(Exit.isFailure(harnessExit) ? Cause.squash(harnessExit.cause) : undefined).toBe(harness)
    expect(rendered).toBe(false)
  })

  it("never converts an interruption into a call result", async () => {
    const binding = FlowBinding.make({ flow: echo, handler: () => Effect.interrupt })

    const exit = await run(binding.run(call("echo", { text: "hi" })))

    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  })

  it("refuses output the declaration's own schema rejects", async () => {
    const binding = FlowBinding.make({
      flow: echo,
      handler: () => Effect.succeed({ text: "hi", length: "two" } as unknown as typeof Echoed.Type)
    })

    const exit = await run(binding.run(call("echo", { text: "hi" })))

    expect(Exit.isSuccess(exit) && exit.value.code).toBe("flow_failed")
    expect(Exit.isSuccess(exit) && exit.value.message).toBe("Flow echo produced output its own schema rejects.")
  })

  it("refuses output that cannot cross the journal", async () => {
    const Unserializable = Schema.Struct({ when: Schema.Any })
    const binding = FlowBinding.make({
      flow: Flow.make({ name: "clock", input: Schema.Struct({}), output: Unserializable }),
      handler: () => Effect.succeed({ when: () => "now" })
    })

    const exit = await run(binding.run(call("clock", {})))

    expect(Exit.isSuccess(exit) && exit.value.code).toBe("flow_failed")
    expect(Exit.isSuccess(exit) && exit.value.message).toBe("Flow clock produced output that is not serializable.")
  })
})

describe("FlowBinding.provide", () => {
  it("closes a handler's requirements with the context the host built", async () => {
    interface Greeter {
      readonly greet: (name: string) => string
    }
    const Greeter = Context.Service<Greeter, Greeter>("test/Greeter")
    const binding = FlowBinding.provide(
      FlowBinding.make({
        flow: echo,
        handler: (input) =>
          Effect.map(Greeter, (greeter) => ({
            text: greeter.greet(input.text),
            length: input.text.length
          }))
      }),
      Context.make(Greeter, { greet: (name: string) => `hello ${name}` })
    )

    const exit = await run(binding.run(call("echo", { text: "world" })))

    expect(Exit.isSuccess(exit) && exit.value.value).toEqual({ text: "hello world", length: 5 })
  })
})

describe("FlowBinding.catalog", () => {
  const binding = (name: string) =>
    FlowBinding.make({
      flow: Flow.make({ name, input: Schema.Struct({}), output: Schema.Struct({}) }),
      handler: () => Effect.succeed({})
    })

  it("composes ordered sources deterministically", async () => {
    const catalog = await Effect.runPromise(
      FlowBinding.catalog([
        FlowBinding.source("first", [binding("alpha")]),
        FlowBinding.source("second", [binding("beta"), binding("gamma")])
      ])
    )

    expect(catalog.descriptors.map((descriptor) => descriptor.name)).toEqual(["alpha", "beta", "gamma"])
    expect(catalog.entries).toHaveLength(3)
    expect([...catalog.bindings.keys()]).toEqual(["alpha", "beta", "gamma"])
  })

  it("refuses two implementations under one name rather than picking one", () => {
    const composed = FlowBinding.catalogResult([binding("alpha"), binding("alpha")])

    expect(Result.isFailure(composed)).toBe(true)
    expect(Result.isFailure(composed) ? composed.failure.message : "").toContain(
      "Two executable bindings are named \"alpha\""
    )
  })

  it("refuses a name two different sources both contribute", async () => {
    const exit = await run(
      FlowBinding.catalog([
        FlowBinding.source("plugin", [binding("alpha")]),
        FlowBinding.source("mcp", [binding("alpha")])
      ])
    )

    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({
      code: "assembly_failed",
      message: expect.stringContaining("Two executable bindings are named \"alpha\"")
    })
  })

  it("composes nothing from no sources and from a source contributing none", async () => {
    const [none, empty, one] = await Effect.runPromise(
      Effect.all([
        FlowBinding.catalog([]),
        FlowBinding.catalog([FlowBinding.source("silent", [])]),
        FlowBinding.catalog([FlowBinding.source("single", [binding("alpha")])])
      ])
    )

    expect(none.entries).toEqual([])
    expect(none.descriptors).toEqual([])
    expect(none.bindings.size).toBe(0)
    expect(empty.entries).toEqual([])
    expect(one.entries).toHaveLength(1)
    expect([...one.bindings.keys()]).toEqual(["alpha"])
  })

  it("reports the missing name before the duplicate when a binding has neither", () => {
    const anonymous = FlowBinding.make({
      flow: nameless,
      handler: () => Effect.succeed({})
    })

    const composed = FlowBinding.catalogResult([anonymous, anonymous])

    expect(Result.isFailure(composed) ? composed.failure.message : "").toContain(
      "An executable binding has no flow name"
    )
  })

  it("refuses a binding whose declaration has no name", () => {
    const anonymous = FlowBinding.make({
      flow: nameless,
      handler: () => Effect.succeed({})
    })

    const composed = FlowBinding.catalogResult([anonymous])

    expect(Result.isFailure(composed) ? composed.failure.code : "").toBe("assembly_failed")
  })

  it("propagates a source that could not be resolved", async () => {
    const exit = await run(
      FlowBinding.catalog([{
        name: "broken",
        bindings: () => Effect.fail(new HarnessError({ code: "engine_failed", message: "no server" }))
      }])
    )

    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({ message: "no server" })
  })

  it("discloses nothing when empty", () => {
    expect(FlowBinding.empty().descriptors).toEqual([])
    expect(FlowBinding.empty().bindings.size).toBe(0)
  })
})

describe("FlowBinding.registry", () => {
  const discovered = new Descriptor.FlowDescriptor({
    name: "review",
    description: "A discovered markdown flow.",
    body: new Descriptor.BodyRefMarkdown({ path: "/flows/review/flow.mdx", baseDirectory: "/flows/review" }),
    input: new Descriptor.SchemaRefMarkdownArgs(),
    output: new Descriptor.SchemaRefMarkdownOutput(),
    model: Option.none(),
    flows: [],
    capabilities: [],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
    placement: Option.none(),
    modelInvocable: true,
    path: "/flows/review",
    frontmatter: {},
    provenance: new Descriptor.Provenance({ source: "project", root: "/flows" })
  })

  const base = (entries: ReadonlyArray<Descriptor.FlowDescriptor>): Registry.Registry =>
    Registry.makeNoop({
      list: () => Effect.succeed(entries),
      visible: () => Effect.succeed(entries.filter((entry) => entry.modelInvocable)),
      getOption: (name) => Effect.succeed(Option.fromUndefinedOr(entries.find((entry) => entry.name === name))),
      warnings: () => Effect.succeed([])
    })

  const bound = FlowBinding.make({
    flow: Flow.make({ name: "read", description: "Read a file.", input: Schema.Struct({}), output: Schema.Struct({}) }),
    handler: () => Effect.succeed({})
  })

  const hiddenBinding = FlowBinding.make({
    flow: Flow.make({ name: "internal", input: Schema.Struct({}), output: Schema.Struct({}) }),
    handler: () => Effect.succeed({}),
    modelInvocable: false
  })

  it("discloses bindings alongside discovered entries through one registry contract", async () => {
    const catalog = Result.getOrThrow(FlowBinding.catalogResult([bound, hiddenBinding]))
    const registry = FlowBinding.registry(base([discovered]), catalog)

    const [listed, visible, found] = await Effect.runPromise(
      Effect.all([registry.list(), registry.visible(), registry.get("read")])
    )

    expect(listed.map((entry) => entry.name)).toEqual(["review", "read", "internal"])
    expect(visible.map((entry) => entry.name)).toEqual(["review", "read"])
    expect(found.description).toBe("Read a file.")
  })

  it("keeps discovery precedence when a binding collides with a discovered flow", async () => {
    const shadowed = FlowBinding.make({
      flow: Flow.make({
        name: "review",
        description: "A bound review.",
        input: Schema.Struct({}),
        output: Schema.Struct({})
      }),
      handler: () => Effect.succeed({})
    })
    const catalog = Result.getOrThrow(FlowBinding.catalogResult([shadowed]))
    const registry = FlowBinding.registry(base([discovered]), catalog)

    const [listed, resolved, warnings] = await Effect.runPromise(
      Effect.all([registry.list(), registry.getOption("review"), registry.warnings()])
    )

    expect(listed.map((entry) => entry.name)).toEqual(["review"])
    expect(Option.getOrThrow(resolved).description).toBe("A discovered markdown flow.")
    expect(warnings.map((warning) => warning.code)).toEqual(["duplicate_name"])
    expect(warnings[0]?.message).toContain("is shadowed by a discovered flow")
  })

  it("keeps discovery precedence even when the discovered entry is not model-invocable", async () => {
    // Deciding shadowing against `visible()` would miss this entry, disclose
    // the binding under a name `getOption` resolves to the discovered flow, and
    // leave the model holding a flow every call refuses.
    const hidden = new Descriptor.FlowDescriptor({
      ...discovered,
      name: "audit",
      modelInvocable: false
    })
    const shadowed = FlowBinding.make({
      flow: Flow.make({ name: "audit", input: Schema.Struct({}), output: Schema.Struct({}) }),
      handler: () => Effect.succeed({})
    })
    const catalog = Result.getOrThrow(FlowBinding.catalogResult([shadowed]))
    const registry = FlowBinding.registry(base([hidden]), catalog)

    const [listed, visible, resolved] = await Effect.runPromise(
      Effect.all([registry.list(), registry.visible(), registry.getOption("audit")])
    )

    expect(listed.map((entry) => entry.name)).toEqual(["audit"])
    expect(visible).toEqual([])
    expect(Option.getOrThrow(resolved).modelInvocable).toBe(false)
  })

  it("reports an unknown name the way the base registry does", async () => {
    const registry = FlowBinding.registry(base([discovered]), FlowBinding.empty())

    const [missing, exit] = await Effect.runPromise(
      Effect.all([registry.getOption("absent"), Effect.exit(registry.get("absent"))])
    )

    expect(Option.isNone(missing)).toBe(true)
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("never resolves a shadowed name to the binding when discovery cannot serve it", async () => {
    // Discovery still owns "review" — `list()` says so — but its entry is not
    // resolvable this instant. Falling back to the binding here would dispatch
    // one declaration's disclosure to another declaration's implementation.
    const racing = Registry.makeNoop({
      list: () => Effect.succeed([discovered]),
      visible: () => Effect.succeed([discovered]),
      getOption: () => Effect.succeed(Option.none()),
      warnings: () => Effect.succeed([])
    })
    const shadowed = FlowBinding.make({
      flow: Flow.make({
        name: "review",
        description: "A bound review.",
        input: Schema.Struct({}),
        output: Schema.Struct({})
      }),
      handler: () => Effect.succeed({})
    })
    const registry = FlowBinding.registry(racing, Result.getOrThrow(FlowBinding.catalogResult([shadowed])))

    const [resolved, exit] = await Effect.runPromise(
      Effect.all([registry.getOption("review"), Effect.exit(registry.get("review"))])
    )

    expect(Option.isNone(resolved)).toBe(true)
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("discloses every binding when discovery found nothing at all", async () => {
    const catalog = Result.getOrThrow(FlowBinding.catalogResult([bound, hiddenBinding]))
    const registry = FlowBinding.registry(base([]), catalog)

    const [listed, visible, resolved, warnings] = await Effect.runPromise(
      Effect.all([registry.list(), registry.visible(), registry.getOption("internal"), registry.warnings()])
    )

    expect(listed.map((entry) => entry.name)).toEqual(["read", "internal"])
    expect(visible.map((entry) => entry.name)).toEqual(["read"])
    expect(Option.getOrThrow(resolved).modelInvocable).toBe(false)
    expect(warnings).toEqual([])
  })

  it("discloses nothing extra when the catalog is empty", async () => {
    const registry = FlowBinding.registry(base([discovered]), FlowBinding.empty())

    const [listed, visible, warnings] = await Effect.runPromise(
      Effect.all([registry.list(), registry.visible(), registry.warnings()])
    )

    expect(listed.map((entry) => entry.name)).toEqual(["review"])
    expect(visible.map((entry) => entry.name)).toEqual(["review"])
    expect(warnings).toEqual([])
  })
})
