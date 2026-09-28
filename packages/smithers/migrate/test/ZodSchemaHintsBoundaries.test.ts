import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as ZodSchemaHints from "../src/ZodSchemaHints.ts"

const decode = (text: string, input: unknown): unknown => {
  const build = new Function("Schema", "Effect", `return (${text})`) as (
    schema: typeof Schema,
    effect: typeof Effect
  ) => Schema.Top
  return Schema.decodeUnknownSync(build(Schema, Effect) as never)(input)
}

describe("safe schema source boundaries", () => {
  for (
    const example of [
      { chain: "z.literal(0)", text: "Schema.Literal(0)", valid: 0, invalid: "0" },
      { chain: "z.literal(true)", text: "Schema.Literal(true)", valid: true, invalid: false },
      { chain: "z.literal(false)", text: "Schema.Literal(false)", valid: false, invalid: true },
      { chain: "z.literal(null)", text: "Schema.Literal(null)", valid: null, invalid: undefined },
      { chain: "z.any()", text: "Schema.Unknown", valid: { nested: [null, 1] }, invalid: undefined },
      { chain: "z.unknown()", text: "Schema.Unknown", valid: [false, "a"], invalid: undefined }
    ]
  ) {
    it(`preserves literal/type acceptance for ${example.chain}`, () => {
      expect(ZodSchemaHints.print(example.chain)).toBe(example.text)
      expect(ZodSchemaHints.classify(example.chain)).toEqual({ class: "automatic", reason: undefined })
      expect(decode(example.text, example.valid)).toEqual(example.valid)
      if (example.text === "Schema.Unknown") expect(decode(example.text, undefined)).toBeUndefined()
      else expect(() => decode(example.text, example.invalid)).toThrow()
    })
  }

  for (
    const example of [
      { field: "z.boolean().default(false)", text: "Schema.Boolean", value: "false", output: false, invalid: 0 },
      { field: "z.number().default(0)", text: "Schema.Number", value: "0", output: 0, invalid: "0" },
      {
        field: "z.string().nullable().default(null)",
        text: "Schema.NullOr(Schema.String)",
        value: "null",
        output: null,
        invalid: false
      },
      {
        field: "z.record(z.number()).default({})",
        text: "Schema.Record(Schema.String, Schema.Number)",
        value: "{}",
        output: {},
        invalid: { a: "x" }
      }
    ]
  ) {
    it(`applies ${example.field} only to a missing field`, () => {
      const chain = `z.object({ value: ${example.field} })`
      const text =
        `Schema.Struct({\n  value: ${example.text}.pipe(Schema.withDecodingDefaultKey(Effect.succeed(${example.value})))\n})`
      expect(ZodSchemaHints.print(chain)).toBe(text)
      expect(decode(text, {})).toEqual({ value: example.output })
      expect(decode(text, { value: example.output })).toEqual({ value: example.output })
      expect(() => decode(text, { value: example.invalid })).toThrow()
    })
  }

  it("retains quoted keys and the distinction between missing, null and a wrong field type", () => {
    const chain = "z.object({ \"display-name\": z.string().nullish(), \"雪\": z.number() })"
    const text =
      "Schema.Struct({\n  \"display-name\": Schema.optional(Schema.NullOr(Schema.String)),\n  \"雪\": Schema.Number\n})"
    expect(ZodSchemaHints.print(chain)).toBe(text)
    for (const input of [{ 雪: 1 }, { "display-name": null, 雪: 1 }, { "display-name": "a", 雪: 1 }]) {
      expect(decode(text, input)).toEqual(input)
    }
    expect(() => decode(text, { "display-name": false, 雪: 1 })).toThrow()
    expect(() => decode(text, { "display-name": "a" })).toThrow()
    expect(ZodSchemaHints.print("z.string().nullish()")).toBeUndefined()
    expect(ZodSchemaHints.printField("z.string().nullish()"))
      .toBe("Schema.optional(Schema.NullOr(Schema.String))")
  })

  for (
    const chain of [
      "z.literal(dynamicValue)",
      "z.enum(dynamicValues)",
      "z.enum([\"a\", dynamicValue])",
      "z.union(dynamicSchemas)",
      "z.union([z.string(), customSchema])",
      "z.object(dynamicShape)",
      "z.object({ ...otherShape, value: z.string() })",
      "z.object({ value })",
      "z.object({ [dynamicKey]: z.string() })",
      "z.object({ get value() { return z.string() } })",
      "z.object({ value: z.string().default(() => \"dynamic\") })",
      "z.object({ value: z.array(z.string()).default([\"seed\"]) })",
      "z.object({ value: z.record(z.number()).default({ seed: 1 }) })",
      "z.string().min(dynamicLimit)",
      "z.string().describe(dynamicDescription)"
    ]
  ) {
    it(`refuses a partial automatic conversion of ${chain}`, () => {
      expect(ZodSchemaHints.print(chain)).toBeUndefined()
      expect(ZodSchemaHints.printField(chain)).toBeUndefined()
      expect(ZodSchemaHints.classify(chain)).toEqual({
        class: "guided",
        reason: "the chain uses a zod form outside the safe subset"
      })
    })
  }
})
