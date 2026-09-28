import { expect, test } from "bun:test"
import { parseArgs } from "../src/flow-arguments"

test.each([
  ["", {}],
  [" \t\r\n ", {}],
  ["ready", { ready: true }],
  ["ready\tverbose\nquiet", { ready: true, verbose: true, quiet: true }],
  ["name=smithers retries=3 enabled=false", { name: "smithers", retries: "3", enabled: "false" }],
  ["empty= expression=a=b", { empty: "", expression: "a=b" }],
  ['title="two words" enabled', { title: "two words", enabled: true }],
  ["title='two words' enabled", { title: "two words", enabled: true }],
  ['title=pre"middle words"post', { title: "premiddle wordspost" }],
  ["empty='' other=\"\"", { empty: "", other: "" }],
  ["name='雪 ☃' emoji=🚀", { name: "雪 ☃", emoji: "🚀" }],
  [String.raw`path=C:\repo\notes.txt`, { path: String.raw`C:\repo\notes.txt` }],
  [String.raw`path='C:\repo\notes.txt'`, { path: String.raw`C:\repo\notes.txt` }],
  [String.raw`title=two\ words`, { title: "two words" }],
  [String.raw`value="say \"hello\""`, { value: 'say "hello"' }],
  [String.raw`value=it\'s`, { value: "it's" }],
  [String.raw`value=one\\two`, { value: String.raw`one\two` }],
  [String.raw`value='one\\two'`, { value: String.raw`one\\two` }],
  ["name=old name=new", { name: "new" }],
  [' {"name":"雪","nested":{"ok":true},"items":[1,null]} ',
    { name: "雪", nested: { ok: true }, items: [1, null] }],
  ['[1,"two",false,null]', { data: [1, "two", false, null] }],
  ['"text with spaces"', { data: "text with spaces" }],
  ['""', { data: "" }]
] as const)("parses flow arguments %j without executing or coercing values", (source, input) => {
  expect(parseArgs(source)).toEqual({ input })
})

test.each([
  ["{", "Invalid JSON"],
  ["[1,]", "Invalid JSON"],
  ['"unfinished', "Invalid JSON"],
  ['{"ok":true} trailing', "Invalid JSON"],
  ["value='unfinished", "Unclosed quote"],
  ['value="unfinished', "Unclosed quote"],
  ["value=unfinished\\", "Trailing escape"],
  ['value="unfinished\\', "Trailing escape"]
] as const)("refuses malformed arguments %j with an actionable error", (source, error) => {
  expect(parseArgs(source)).toEqual({ error })
})

test("prototype-named arguments stay own data and cannot change object prototypes", () => {
  for (const source of [
    "__proto__=value constructor=other prototype=third",
    '{"__proto__":"value","constructor":"other","prototype":"third"}'
  ]) {
    const parsed = parseArgs(source)
    expect("input" in parsed).toBe(true)
    if (!("input" in parsed)) throw new Error(parsed.error)
    expect(Object.getPrototypeOf(parsed.input)).toBe(Object.prototype)
    expect(Object.keys(parsed.input)).toEqual(["__proto__", "constructor", "prototype"])
    expect(Object.getOwnPropertyDescriptor(parsed.input, "__proto__")?.value).toBe("value")
    expect(Object.getOwnPropertyDescriptor(parsed.input, "constructor")?.value).toBe("other")
    expect(parsed.input.prototype).toBe("third")
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "prototype")).toBe(false)
  }
})
