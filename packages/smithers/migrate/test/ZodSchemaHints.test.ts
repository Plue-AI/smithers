import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as Detect from "../src/Detect.ts"
import * as ZodSchemaHints from "../src/ZodSchemaHints.ts"
import { copyFixture, nodeLayer } from "./fixtures/helpers.ts"

/** Evaluates printed schema text the way the migrated file will. */
const evaluate = (text: string): Schema.Top => {
  const build = new Function("Schema", "Effect", "SchemaGetter", `return (${text})`) as (
    schema: typeof Schema,
    effect: typeof Effect,
    getter: typeof SchemaGetter
  ) => Schema.Top
  return build(Schema, Effect, SchemaGetter)
}

const decodes = (text: string, input: unknown): unknown => Schema.decodeUnknownSync(evaluate(text) as never)(input)

describe("ZodSchemaHints.print over the safe subset", () => {
  const cases: ReadonlyArray<{
    readonly chain: string
    readonly text: string
    readonly input: unknown
    readonly output: unknown
  }> = [
    { chain: "z.string()", text: "Schema.String", input: "x", output: "x" },
    { chain: "z.number()", text: "Schema.Number", input: 1, output: 1 },
    { chain: "z.boolean()", text: "Schema.Boolean", input: true, output: true },
    { chain: "z.array(z.string())", text: "Schema.Array(Schema.String)", input: ["a"], output: ["a"] },
    { chain: "z.literal(\"ship\")", text: "Schema.Literal(\"ship\")", input: "ship", output: "ship" },
    {
      chain: "z.enum([\"critical\", \"minor\"])",
      text: "Schema.Literals([\"critical\", \"minor\"])",
      input: "minor",
      output: "minor"
    },
    {
      chain: "z.union([z.string(), z.number()])",
      text: "Schema.Union([Schema.String, Schema.Number])",
      input: 3,
      output: 3
    },
    {
      chain: "z.record(z.string(), z.number())",
      text: "Schema.Record(Schema.String, Schema.Number)",
      input: { a: 1 },
      output: { a: 1 }
    },
    { chain: "z.int()", text: "Schema.Int", input: 4, output: 4 },
    {
      chain: "z.object({ summary: z.string() })",
      text: "Schema.Struct({\n  summary: Schema.String\n})",
      input: { summary: "s" },
      output: { summary: "s" }
    },
    {
      chain: "z.object({ note: z.string().optional() })",
      text: "Schema.Struct({\n  note: Schema.optional(Schema.String)\n})",
      input: {},
      output: {}
    },
    {
      chain: "z.object({ note: z.string().nullable() })",
      text: "Schema.Struct({\n  note: Schema.NullOr(Schema.String)\n})",
      input: { note: null },
      output: { note: null }
    },
    {
      chain: "z.object({ items: z.array(z.string()).default([]) })",
      text:
        "Schema.Struct({\n  items: Schema.Array(Schema.String).pipe((schema) => Schema.optional(schema).pipe(Schema.decodeTo(schema, { decode: SchemaGetter.withDefault(Effect.succeed(schema.make([]))), encode: SchemaGetter.required() })))\n})",
      input: {},
      output: { items: [] }
    },
    {
      chain: "z.object({ summary: z.string().describe(\"what happened\") })",
      text: "Schema.Struct({\n  summary: Schema.String.annotate({ description: \"what happened\" })\n})",
      input: { summary: "s" },
      output: { summary: "s" }
    },
    {
      chain: "z.object({ count: z.number().int().nonnegative() })",
      text:
        "Schema.Struct({\n  count: Schema.Number.pipe(Schema.check(Schema.isInt())).pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))\n})",
      input: { count: 0 },
      output: { count: 0 }
    },
    {
      chain: "z.object({ name: z.string().min(2) })",
      text: "Schema.Struct({\n  name: Schema.String.pipe(Schema.check(Schema.isMinLength(2)))\n})",
      input: { name: "ab" },
      output: { name: "ab" }
    }
  ]

  for (const example of cases) {
    it(`prints and decodes ${example.chain}`, () => {
      const printed = ZodSchemaHints.print(example.chain)

      expect(printed).toBe(example.text)
      expect(ZodSchemaHints.classify(example.chain).class).toBe("automatic")
      expect(decodes(printed!, example.input)).toEqual(example.output)
    })
  }
})

describe("ZodSchemaHints.print preserves integer refinements", () => {
  const cases = [
    { chain: "z.number().min(5).max(10).int()", valid: [5, 7, 10], invalid: [-1, 4, 11, 7.5] },
    { chain: "z.number().int().min(5).max(10)", valid: [5, 7, 10], invalid: [-1, 4, 11, 7.5] },
    { chain: "z.number().min(5).int().max(10)", valid: [5, 7, 10], invalid: [-1, 4, 11, 7.5] },
    { chain: "z.number().positive().int()", valid: [1, 5], invalid: [-1, 0, 1.5] },
    { chain: "z.number().int().positive()", valid: [1, 5], invalid: [-1, 0, 1.5] },
    { chain: "z.number().nonnegative().int().describe(\"count\")", valid: [0, 5], invalid: [-1, 1.5] },
    { chain: "z.number().int().nonnegative().describe(\"count\")", valid: [0, 5], invalid: [-1, 1.5] }
  ]

  for (const { chain, invalid, valid } of cases) {
    it(`keeps every check in ${chain}`, () => {
      const printed = ZodSchemaHints.print(chain)!

      expect(ZodSchemaHints.classify(chain).class).toBe("automatic")
      for (const input of valid) expect(decodes(printed, input)).toBe(input)
      for (const input of invalid) expect(() => decodes(printed, input)).toThrow()
      if (chain.includes("describe")) expect(printed).toContain(".annotate({ description: \"count\" })")
    })
  }
})

describe("ZodSchemaHints.classify outside the safe subset", () => {
  const guided: ReadonlyArray<[string, string]> = [
    ["z.object({ a: z.string() }).passthrough()", "passthrough"],
    ["z.number().refine((value) => value > 0)", "refine"],
    ["z.discriminatedUnion(\"kind\", [a, b])", "discriminatedUnion"],
    ["z.string().transform((value) => value.length)", "transform"],
    ["z.lazy(() => node)", "lazy"],
    ["z.tuple([z.string(), z.number()])", "tuple"]
  ]

  for (const [chain, marker] of guided) {
    it(`marks ${marker} guided and prints nothing`, () => {
      const classification = ZodSchemaHints.classify(chain)

      expect(classification.class).toBe("guided")
      expect(classification.reason).toContain(marker)
    })
  }

  it("marks an unrecognized zod form guided rather than guessing", () => {
    const classification = ZodSchemaHints.classify("z.date()")

    expect(classification.class).toBe("guided")
    expect(classification.reason).toBe("the chain uses a zod form outside the safe subset")
    expect(ZodSchemaHints.print("z.date()")).toBeUndefined()
  })
})

describe("ZodSchemaHints.print refuses what it cannot translate faithfully", () => {
  it("keeps a record's key schema when it is a string or a literal set, and refuses any other", () => {
    expect(ZodSchemaHints.print("z.record(z.string(), z.number())")).toBe("Schema.Record(Schema.String, Schema.Number)")
    expect(ZodSchemaHints.print("z.record(z.enum([\"a\", \"b\"]), z.number())"))
      .toBe("Schema.Record(Schema.Literals([\"a\", \"b\"]), Schema.Number)")
    expect(ZodSchemaHints.print("z.record(z.number())")).toBe("Schema.Record(Schema.String, Schema.Number)")
    // A numeric key changes what the record accepts; it is not printed as a string key.
    expect(ZodSchemaHints.print("z.record(z.number(), z.string())")).toBeUndefined()
    expect(ZodSchemaHints.classify("z.record(z.number(), z.string())").class).not.toBe("automatic")
  })

  it("checks a length on a string or an array and a bound on a number, never the other way round", () => {
    expect(ZodSchemaHints.print("z.array(z.number()).min(1)"))
      .toBe("Schema.Array(Schema.Number).pipe(Schema.check(Schema.isMinLength(1)))")
    expect(ZodSchemaHints.print("z.array(z.string()).max(3)"))
      .toBe("Schema.Array(Schema.String).pipe(Schema.check(Schema.isMaxLength(3)))")
    expect(ZodSchemaHints.print("z.number().min(1)"))
      .toBe("Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))")
    expect(ZodSchemaHints.print("z.string().max(2)")).toBe("Schema.String.pipe(Schema.check(Schema.isMaxLength(2)))")
    expect(ZodSchemaHints.print("z.boolean().min(1)")).toBeUndefined()
    expect(ZodSchemaHints.print("z.string().int()")).toBeUndefined()
    expect(ZodSchemaHints.print("z.string().positive()")).toBeUndefined()
    // The printed array check is a real check: one element passes, none fails.
    const printed = ZodSchemaHints.print("z.array(z.number()).min(1)")!
    expect(decodes(printed, [1])).toEqual([1])
    expect(() => decodes(printed, [])).toThrow()
  })

  it("refuses a nested optional or default rather than dropping it, and keeps a nested description", () => {
    expect(ZodSchemaHints.print("z.array(z.string().optional())")).toBeUndefined()
    expect(ZodSchemaHints.print("z.array(z.string().default(\"x\"))")).toBeUndefined()
    expect(ZodSchemaHints.print("z.union([z.string().optional(), z.number()])")).toBeUndefined()
    expect(ZodSchemaHints.print("z.record(z.string(), z.number().default(1))")).toBeUndefined()
    expect(ZodSchemaHints.print("z.array(z.string().describe(\"d\"))"))
      .toBe("Schema.Array(Schema.String.annotate({ description: \"d\" }))")
  })

  it("prints a top-level optional, default, or description as the field it is", () => {
    expect(ZodSchemaHints.printField("z.string().optional()")).toBe("Schema.optional(Schema.String)")
    expect(ZodSchemaHints.printField("z.number().default(3)"))
      .toBe(
        "Schema.Number.pipe((schema) => Schema.optional(schema).pipe(Schema.decodeTo(schema, { decode: SchemaGetter.withDefault(Effect.succeed(schema.make(3))), encode: SchemaGetter.required() })))"
      )
    expect(ZodSchemaHints.printField("z.string().describe(\"d\").optional()"))
      .toBe("Schema.optional(Schema.String.annotate({ description: \"d\" }))")
    expect(ZodSchemaHints.printField("z.string()")).toBe("Schema.String")
    expect(ZodSchemaHints.printField("z.nope()")).toBeUndefined()
    // `print` alone has no spelling for a top-level optional or default, so
    // it refuses rather than printing the bare schema and calling the chain
    // automatic; a description is kept as an annotation.
    expect(ZodSchemaHints.print("z.string().optional()")).toBeUndefined()
    expect(ZodSchemaHints.print("z.string().default(\"x\")")).toBeUndefined()
    expect(ZodSchemaHints.classify("z.string().default(\"x\")").class).toBe("guided")
    expect(ZodSchemaHints.print("z.string().describe(\"d\")")).toBe("Schema.String.annotate({ description: \"d\" })")
  })
})

describe("ZodSchemaHints.hints", () => {
  it.effect("converts the jsx-single schemas and decodes the sample the workflow produces", () =>
    Effect.gen(function*() {
      const detection = yield* Detect.scan(copyFixture("jsx-single"))
      const found = ZodSchemaHints.hints(detection)

      const research = found.find((hint) => hint.name === "researchSchema")
      expect(research?.class).toBe("automatic")
      expect(research?.schema).toBe(
        "Schema.Struct({\n  summary: Schema.String,\n  keyPoints: Schema.Array(Schema.String)\n})"
      )
      expect(decodes(research!.schema!, { summary: "s", keyPoints: ["a"] })).toEqual({
        summary: "s",
        keyPoints: ["a"]
      })
    }).pipe(Effect.provide(nodeLayer)))

  it.effect("marks the plue-pack passthrough schemas guided", () =>
    Effect.gen(function*() {
      const detection = yield* Detect.scan(copyFixture("plue-pack"))
      const found = ZodSchemaHints.hints(detection)

      const ralph = found.find((hint) => hint.name === "ralphOutputSchema")
      expect(ralph?.class).toBe("guided")
      expect(ralph?.reason).toContain("passthrough")
      expect(ralph?.schema).toBeUndefined()

      const implement = found.find((hint) => hint.name === "implementOutputSchema")
      expect(implement?.class).toBe("automatic")
      expect(implement?.schema).toContain("SchemaGetter.withDefault")
    }).pipe(Effect.provide(nodeLayer)))
})
