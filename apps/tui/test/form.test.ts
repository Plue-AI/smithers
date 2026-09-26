import { expect, it } from "bun:test"
import { Schema } from "effect"
import * as Form from "../src/form.ts"

const schema = Schema.Struct({
  title: Schema.String,
  count: Schema.optional(Schema.Number),
  draft: Schema.Boolean,
  mode: Schema.Literals(["a", "b"])
})

it("preserves numeric literal choices in valid payloads", () => {
  const schema = Schema.Struct({ count: Schema.Literals([1, 2]), fixed: Schema.Literal(3) })
  const fields = Form.fields(schema)
  const draft = Form.draft(fields, { count: 1, fixed: 3 })
  const result = Form.payload(schema, fields, {}, draft)
  expect(result).toEqual({ payload: { count: 1, fixed: 3 } })
  expect("payload" in result && Form.valid(schema, result.payload)).toBe(true)
  const selected = fields[0]!.options![1]!
  expect(Form.payload(schema, fields, {}, { ...draft, count: selected })).toEqual({ payload: { count: 2, fixed: 3 } })
})

it("derives one field per payload property", () => {
  expect(Form.fields(schema)).toEqual([
    { name: "title", label: "Title", kind: "text", required: true },
    { name: "count", label: "Count", kind: "number", required: false },
    { name: "draft", label: "Draft", kind: "boolean", required: true },
    { name: "mode", label: "Mode", kind: "select", required: true, options: ["a", "b"] }
  ])
})

it("coerces given values and lists required blanks by label", () => {
  const fields = Form.fields(schema)
  const draft = Form.draft(fields, { count: "3" })
  expect(draft).toEqual({ count: 3, draft: false })
  expect(Form.missing(fields, draft)).toEqual(["Title", "Mode"])
  expect(Form.payload(schema, fields, {}, draft)).toEqual({ error: "Needs: Title, Mode" })
  const filled = Form.payload(schema, fields, { extra: 1 }, { ...draft, title: "x", mode: "b" })
  expect(filled).toEqual({ payload: { extra: 1, title: "x", count: 3, draft: false, mode: "b" } })
  expect(Form.payload(schema, fields, {}, { title: "x", mode: "a", count: "4" })).toMatchObject({
    payload: { count: 4 }
  })
  expect(Form.payload(schema, fields, {}, { title: "x", mode: "a", count: "four" })).toEqual({
    error: "Count: not a number"
  })
  expect(Form.valid(schema, { title: "x", count: 3, draft: false, mode: "b" })).toBe(true)
})

it("parses /flow arguments like smthrs up", () => {
  expect(Form.parseArgs("")).toEqual({ input: {} })
  expect(Form.parseArgs("{\"a\":1}")).toEqual({ input: { a: 1 } })
  expect(Form.parseArgs("a=1 b")).toEqual({ input: { a: "1", b: true } })
  expect(Form.parseArgs("[1]")).toEqual({ input: { data: [1] } })
  expect(Form.parseArgs("{bad")).toEqual({ error: "Invalid JSON" })
})

it("keeps quoted and escaped flow values intact", () => {
  expect(Form.parseArgs("text=\"hello world\" enabled")).toEqual({ input: { text: "hello world", enabled: true } })
  expect(Form.parseArgs("text='日本語 with spaces' empty='' equal='a=b'")).toEqual({
    input: { text: "日本語 with spaces", empty: "", equal: "a=b" }
  })
  expect(Form.parseArgs(String.raw`text="say \"hi\"" path=C:\work\file escaped=hello\ world`)).toEqual({
    input: { text: "say \"hi\"", path: String.raw`C:\work\file`, escaped: "hello world" }
  })
  expect(Form.parseArgs("text=\"unclosed")).toEqual({ error: "Unclosed quote" })
  expect(Form.parseArgs("text=trailing\\")).toEqual({ error: "Trailing escape" })
})
