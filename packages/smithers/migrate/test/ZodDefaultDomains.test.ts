import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as ZodSchemaHints from "../src/ZodSchemaHints.ts"

const schema = (chain: string): Schema.Top => {
  const text = ZodSchemaHints.print(chain)
  expect(text).toBeDefined()
  const build = new Function("Schema", "Effect", "SchemaGetter", `return (${text})`) as (
    schema: typeof Schema,
    effect: typeof Effect,
    getter: typeof SchemaGetter
  ) => Schema.Top
  return build(Schema, Effect, SchemaGetter)
}

describe("automatic defaults stay within the supplied-value domain", () => {
  for (
    const example of [
      { field: "z.array(z.string()).default([])", empty: [] },
      { field: "z.record(z.string(), z.number()).default({})", empty: {} }
    ]
  ) {
    it(`does not share mutable fallback results for ${example.field}`, () => {
      const decode = Schema.decodeUnknownSync(schema(`z.object({ value: ${example.field} })`) as never)
      const first: unknown = decode({})
      const second: unknown = decode({})
      if (typeof first !== "object" || first === null || !("value" in first)) throw new Error("missing first value")
      if (typeof second !== "object" || second === null || !("value" in second)) throw new Error("missing second value")
      expect(first.value).not.toBe(second.value)
      if (Array.isArray(first.value)) first.value.push("changed")
      else {
        if (typeof first.value !== "object" || first.value === null) throw new Error("missing record value")
        Object.assign(first.value, { changed: 1 })
      }
      const third: unknown = decode({})
      if (typeof third !== "object" || third === null || !("value" in third)) throw new Error("missing third value")
      expect(second).toEqual({ value: example.empty })
      expect(third).toEqual({ value: example.empty })
      expect(second.value).not.toBe(third.value)
    })
  }
  for (
    const example of [
      { field: "z.literal(1).default(1)", fallback: 1, wrong: 2 },
      { field: "z.literal(true).default(true)", fallback: true, wrong: false },
      { field: "z.enum([\"a\", \"b\"]).default(\"b\")", fallback: "b", wrong: "c" },
      { field: "z.array(z.string()).default([])", fallback: [], wrong: [1] },
      { field: "z.object({ note: z.string().optional() }).default({})", fallback: {}, wrong: { note: 1 } }
    ]
  ) {
    it(`defaults and validates ${example.field}`, () => {
      const chain = `z.object({ value: ${example.field} })`
      expect(ZodSchemaHints.classify(chain)).toEqual({ class: "automatic", reason: undefined })
      const found = schema(chain)
      const decode = Schema.decodeUnknownSync(found as never)
      const encode = Schema.encodeUnknownSync(found as never)
      expect(decode({})).toEqual({ value: example.fallback })
      expect(decode({ value: undefined })).toEqual({ value: example.fallback })
      expect(decode({ value: example.fallback })).toEqual({ value: example.fallback })
      expect(encode({ value: example.fallback })).toEqual({ value: example.fallback })
      expect(() => decode({ value: example.wrong })).toThrow()
      expect(() => encode({ value: example.wrong })).toThrow()
      expect(() => encode({})).toThrow()
      expect(() => encode({ value: undefined })).toThrow()
    })
  }

  for (
    const field of [
      "z.string().default(0)",
      "z.number().default(false)",
      "z.boolean().default(1)",
      "z.record(z.enum([\"required\"]), z.number()).default({})",
      "z.object({ note: z.string().default(\"fallback\") }).default({})",
      "z.int().default(1)",
      "z.number().default(1e999)",
      "z.unknown().default([])",
      "z.any().default({})",
      "z.unknown().default(null)",
      "z.any().default(0)",
      "z.unknown().nullable().default(null)",
      "z.union([z.string(), z.unknown()]).nullable().default(null)"
    ]
  ) {
    it(`guides a fallback that cannot preserve the domain: ${field}`, () => {
      const chain = `z.object({ value: ${field} })`
      expect(ZodSchemaHints.classify(chain)).toEqual({
        class: "guided",
        reason: "the chain uses a zod form outside the safe subset"
      })
      expect(ZodSchemaHints.print(chain)).toBeUndefined()
      expect(ZodSchemaHints.printField(field)).toBeUndefined()
    })
  }
  it("defaults the null branch of a checked nullable string without bypassing string validation", () => {
    const chain = "z.object({ value: z.string().min(5).nullable().default(null) })"
    expect(ZodSchemaHints.classify(chain)).toEqual({ class: "automatic", reason: undefined })
    const found = schema(chain)
    const decode = Schema.decodeUnknownSync(found as never)
    const encode = Schema.encodeUnknownSync(found as never)
    expect(decode({})).toEqual({ value: null })
    expect(decode({ value: undefined })).toEqual({ value: null })
    for (const value of [null, "abcde"]) {
      expect(decode({ value })).toEqual({ value })
      expect(encode({ value })).toEqual({ value })
    }
    expect(() => decode({ value: "abc" })).toThrow()
    expect(() => encode({ value: "abc" })).toThrow()
    expect(() => encode({})).toThrow()
  })
})
