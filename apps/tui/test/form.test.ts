import { parseArgs } from "@smthrs/ui/flow-arguments"
import * as Form from "@smthrs/ui/flow-form"
import { expect, it } from "bun:test"
import { Schema } from "effect"

const schema = Schema.Struct({
  title: Schema.String,
  count: Schema.optional(Schema.Number),
  draft: Schema.Boolean,
  mode: Schema.Literals(["a", "b"])
})

it("preserves numeric literal choices in valid payloads", () => {
  const schema = Schema.Struct({ count: Schema.Literals([1, 2]), fixed: Schema.Literal(3) })
  const fields = Form.formFieldsFor(schema)
  const draft = Form.draftFrom(fields, { count: 1, fixed: 3 })
  const result = Form.fileSubmission(schema, fields, {}, draft)
  expect(result).toEqual({ payload: { count: 1, fixed: 3 } })
  expect("payload" in result && Schema.is(schema)(result.payload)).toBe(true)
  const selected = fields[0]!.options![1]!
  expect(Form.fileSubmission(schema, fields, {}, { ...draft, count: selected.value })).toEqual({
    payload: { count: 2, fixed: 3 }
  })
})

it("derives one field per payload property", () => {
  expect(Form.formFieldsFor(schema)).toEqual([
    { name: "title", label: "Title", kind: "text", required: true },
    { name: "count", label: "Count", kind: "number", required: false },
    { name: "draft", label: "Draft", kind: "boolean", required: true },
    {
      name: "mode",
      label: "Mode",
      kind: "select",
      required: true,
      options: [{ value: "a", label: "a" }, { value: "b", label: "b" }]
    }
  ])
})

it("coerces given values and lists required blanks by label", () => {
  const fields = Form.formFieldsFor(schema)
  const draft = Form.draftFrom(fields, { count: "3" })
  expect(draft).toEqual({ count: 3, draft: false })
  expect(Form.missingLabels(fields, draft)).toEqual(["Title", "Mode"])
  expect(Form.fileSubmission(schema, fields, {}, draft)).toEqual({ error: "Needs: Title, Mode" })
  const filled = Form.fileSubmission(schema, fields, { extra: 1 }, { ...draft, title: "x", mode: "b" })
  expect(filled).toEqual({ payload: { extra: 1, title: "x", count: 3, draft: false, mode: "b" } })
  expect(Form.fileSubmission(schema, fields, {}, { title: "x", mode: "a", count: "4" })).toMatchObject({
    payload: { count: 4 }
  })
  expect(Form.fileSubmission(schema, fields, {}, { title: "x", mode: "a", count: "four" })).toEqual({
    error: "Count: not a number"
  })
  expect(Schema.is(schema)({ title: "x", count: 3, draft: false, mode: "b" })).toBe(true)
})

it("parses /flow arguments like smthrs up", () => {
  expect(parseArgs("")).toEqual({ input: {} })
  expect(parseArgs("{\"a\":1}")).toEqual({ input: { a: 1 } })
  expect(parseArgs("a=1 b")).toEqual({ input: { a: "1", b: true } })
  expect(parseArgs("[1]")).toEqual({ input: { data: [1] } })
  expect(parseArgs("{bad")).toEqual({ error: "Invalid JSON" })
})

it("keeps quoted and escaped flow values intact", () => {
  expect(parseArgs("text=\"hello world\" enabled")).toEqual({ input: { text: "hello world", enabled: true } })
  expect(parseArgs("text='日本語 with spaces' empty='' equal='a=b'")).toEqual({
    input: { text: "日本語 with spaces", empty: "", equal: "a=b" }
  })
  expect(parseArgs(String.raw`text="say \"hi\"" path=C:\work\file escaped=hello\ world`)).toEqual({
    input: { text: "say \"hi\"", path: String.raw`C:\work\file`, escaped: "hello world" }
  })
  expect(parseArgs("text=\"unclosed")).toEqual({ error: "Unclosed quote" })
  expect(parseArgs("text=trailing\\")).toEqual({ error: "Trailing escape" })
})

it("keeps file-array values and objects through the terminal form", () => {
  const input = Schema.Struct({
    paths: Schema.Array(Schema.String),
    config: Schema.Struct({ enabled: Schema.Boolean })
  })
  const fields = Form.formFieldsFor(input)
  const given = { paths: ["a b", "c"], config: { enabled: false } }
  expect(Form.fileSubmission(input, fields, given, Form.draftFrom(fields, given, "json"))).toEqual({ payload: given })
})
