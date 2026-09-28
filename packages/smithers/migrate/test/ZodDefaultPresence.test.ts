import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as ZodSchemaHints from "../src/ZodSchemaHints.ts"

const fieldSchema = (field: string): Schema.Top => {
  const printed = ZodSchemaHints.print(`z.object({ value: ${field} })`)
  expect(printed).toBeDefined()
  const build = new Function("Schema", "Effect", "SchemaGetter", `return (${printed})`) as (
    schema: typeof Schema,
    effect: typeof Effect,
    getter: typeof SchemaGetter
  ) => Schema.Top
  return build(Schema, Effect, SchemaGetter)
}

const decodeField = (field: string, input: unknown): unknown =>
  Schema.decodeUnknownSync(fieldSchema(field) as never)(input)

// Independently verified using the fixture's zod@4.4.3, not the generated
// Effect schema: .default applies to both a missing key and explicit undefined.
describe("default field presence preserves supported Zod semantics", () => {
  // Pinned Zod 4.4.3 decodes missing/undefined to the fallback in both
  // orders, but encodes them as absent/own undefined. The safe printer must
  // guide these forms rather than claim equivalent generated code.
  for (
    const field of [
      "z.string().default(\"fallback\").optional()",
      "z.string().optional().default(\"fallback\")",
      "z.string().default(\"fallback\").nullish()",
      "z.string().nullish().default(\"fallback\")"
    ]
  ) {
    it(`guides mixed field metadata rather than changing presence semantics: ${field}`, () => {
      const chain = `z.object({ value: ${field} })`
      expect(ZodSchemaHints.classify(chain)).toEqual({
        class: "guided",
        reason: "the chain uses a zod form outside the safe subset"
      })
      expect(ZodSchemaHints.print(chain)).toBeUndefined()
      expect(ZodSchemaHints.printField(field)).toBeUndefined()
    })
  }

  for (
    const example of [
      {
        field: "z.boolean().default(false)",
        fallback: false,
        valid: true,
        wrong: "true",
        acceptsNull: false,
        acceptsAbsent: false
      },
      { field: "z.number().default(0)", fallback: 0, valid: 7, wrong: "7", acceptsNull: false, acceptsAbsent: false },
      {
        field: "z.string().nullable().default(null)",
        fallback: null,
        valid: "a",
        wrong: false,
        acceptsNull: true,
        acceptsAbsent: false
      },
      {
        field: "z.record(z.string(), z.number()).default({})",
        fallback: {},
        valid: { a: 1 },
        wrong: { a: "1" },
        acceptsNull: false,
        acceptsAbsent: false
      }
    ]
  ) {
    it(`preserves missing and undefined defaults through printField for ${example.field}`, () => {
      const field = ZodSchemaHints.printField(example.field)
      expect(field).toBeDefined()
      const build = new Function("Schema", "Effect", "SchemaGetter", `return Schema.Struct({ value: ${field} })`) as (
        schema: typeof Schema,
        effect: typeof Effect,
        getter: typeof SchemaGetter
      ) => Schema.Top
      const decode = Schema.decodeUnknownSync(build(Schema, Effect, SchemaGetter) as never)
      expect(decode({})).toEqual({ value: example.fallback })
      expect(decode({ value: undefined })).toEqual({ value: example.fallback })
    })
    it(`preserves encoded presence and value validation for ${example.field}`, () => {
      const encode = Schema.encodeUnknownSync(fieldSchema(example.field) as never)
      for (const input of [{}, { value: undefined }]) {
        if (example.acceptsAbsent) {
          const output = encode(input)
          expect(output).toEqual(input)
          expect(Object.hasOwn(output as object, "value")).toBe(Object.hasOwn(input, "value"))
        } else expect(() => encode(input)).toThrow()
      }
      expect(encode({ value: example.valid })).toEqual({ value: example.valid })
      expect(() => encode({ value: example.wrong })).toThrow()
      if (example.acceptsNull) expect(encode({ value: null })).toEqual({ value: null })
      else expect(() => encode({ value: null })).toThrow()
    })
    it(`defaults a missing key for ${example.field}`, () => {
      expect(decodeField(example.field, {})).toEqual({ value: example.fallback })
    })
    it(`defaults explicit undefined for ${example.field}`, () => {
      const input = { value: undefined }
      expect(Object.hasOwn(input, "value")).toBe(true)
      expect(decodeField(example.field, input)).toEqual({ value: example.fallback })
    })
    it(`preserves null acceptance for ${example.field}`, () => {
      if (example.acceptsNull) expect(decodeField(example.field, { value: null })).toEqual({ value: null })
      else expect(() => decodeField(example.field, { value: null })).toThrow()
    })
    it(`preserves explicit value validation for ${example.field}`, () => {
      expect(decodeField(example.field, { value: example.valid })).toEqual({ value: example.valid })
      expect(() => decodeField(example.field, { value: example.wrong })).toThrow()
    })
  }
})
