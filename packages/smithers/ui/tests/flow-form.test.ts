import { expect, test } from "bun:test"
import { Schema } from "effect"
import { draftFrom, fileSubmission, formFieldsFor, missingFields, submissionPayload } from "../src/flow-form"

const input = Schema.Struct({
  count: Schema.Literals([1, 2]),
  enabled: Schema.Boolean,
  paths: Schema.Array(Schema.String),
  config: Schema.Struct({ retries: Schema.Number }),
  optional: Schema.optional(Schema.Number)
})

test("file forms retain typed choices and structured payloads through either renderer", () => {
  const fields = formFieldsFor(input)
  const given = { count: 1, enabled: false, paths: ["a b", "日本語"], config: { retries: 3 }, untouched: "routing" }
  const draft = draftFrom(fields, given, "json")
  expect(draft.paths).toBe('["a b","日本語"]')
  expect(missingFields(fields, draft)).toEqual([])
  const changed = { ...draft, count: fields[0]!.options![1]!.value, optional: "4" }
  const gui = submissionPayload(input, fields, given, changed, "json")
  expect(fileSubmission(input, fields, given, changed)).toEqual(gui)
  expect(gui).toEqual({ payload: { ...given, count: 2, optional: 4 } })
  expect("payload" in gui && Schema.is(input)(gui.payload)).toBe(true)
})

test("command-list grammar remains space separated while file arrays use JSON", () => {
  const schema = Schema.Struct({ paths: Schema.Array(Schema.String) })
  const fields = formFieldsFor(schema)
  expect(submissionPayload(schema, fields, {}, { paths: "a b" })).toEqual({ payload: { paths: ["a", "b"] } })
  expect(fileSubmission(schema, fields, {}, { paths: "a b" })).toHaveProperty("error")
  expect(fileSubmission(schema, fields, {}, { paths: '["a b"]' })).toEqual({ payload: { paths: ["a b"] } })
})

test("optional numeric blanks are absent and invalid numbers cannot launch", () => {
  const schema = Schema.Struct({ count: Schema.optional(Schema.Number) })
  const fields = formFieldsFor(schema)
  expect(fileSubmission(schema, fields, { count: 8 }, { count: "" })).toEqual({ payload: {} })
  expect(fileSubmission(schema, fields, {}, { count: "Infinity" })).toEqual({ error: "Count: not a number" })
})

test("write-only values never become drafts or submitted payloads", () => {
  const schema = Schema.Struct({ secret: Schema.String, id: Schema.String })
  const fields = formFieldsFor(schema, { fields: { secret: { kind: "write-only" } } })
  expect(draftFrom(fields, { secret: "private", id: "one" })).toEqual({ id: "one" })
  expect(submissionPayload(schema, fields, { secret: "private" }, { secret: "private", id: "one" }))
    .toEqual({ payload: { id: "one" } })
})

test("headless exports bundle for Bun without importing DOM presentation", async () => {
  const result = await Bun.build({ entrypoints: [new URL("../src/flow-form.ts", import.meta.url).pathname],
    target: "bun", packages: "external" })
  expect(result.success).toBe(true)
  const source = await result.outputs[0]!.text()
  expect(source).not.toContain("react-dom")
  expect(source).not.toContain("@opentui")
  expect(source).not.toContain("document.")
})
