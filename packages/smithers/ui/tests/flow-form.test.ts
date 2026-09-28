import { expect, test } from "bun:test"
import { Schema } from "effect"
import { assembleArgs, assembleLine, displayLine, draftFrom, line, text, fileSubmission, positionalRead, formFieldsFor, missingFields, submissionPayload } from "../src/flow-form"

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

test("assembleArgs never writes a value its grammar would read as another token", () => {
  const fields = formFieldsFor(Schema.Struct({
    sourceCard: Schema.optional(Schema.String),
    runId: Schema.String,
    note: Schema.optional(Schema.String),
    follow: Schema.optional(Schema.Boolean)
  }))
  // Honest values round-trip, including a multi-word last value.
  expect(assembleArgs(fields, undefined, { sourceCard: "card-1", runId: "run-1", note: "look here", follow: true }))
    .toBe("sourceCard=card-1 run-1 look here --follow")
  // A smuggled flag, binding, or shifted word ends the line before it.
  expect(assembleArgs(fields, undefined, { runId: "run-1", note: "x --delete" })).toBe("run-1")
  expect(assembleArgs(fields, undefined, { runId: "sourceCard=victim run-1" })).toBe("")
  expect(assembleArgs(fields, undefined, { sourceCard: "card-1 run-evil", runId: "run-1" })).toBe("")
  expect(assembleArgs(fields, undefined, { runId: "run-1 run-evil", note: "n" })).toBe("")
  // What the line carries is exactly what the form held: no field gains a value.
  const read = positionalRead(fields, undefined, assembleArgs(fields, undefined, { runId: "run-1", note: "a --follow" }))
  expect(read.payload).toEqual({ runId: "run-1" })
})

test("assembleLine: every line reads back as exactly the values it carries, and withholds the rest", () => {
  // A trailing optional slot the form leaves unset is the case a last-written-value rule missed,
  // and a boolean mid-schema is the case a flag written in schema order cut the read short at.
  const fields = formFieldsFor(Schema.Struct({
    sourceCard: Schema.optional(Schema.String),
    runId: Schema.String,
    follow: Schema.optional(Schema.Boolean),
    note: Schema.optional(Schema.String),
    tag: Schema.optional(Schema.String)
  }))
  const pool = [undefined, "", "v", "two words", "a b c", "x --delete", "sourceCard=victim", '{"a":1}', '{"a": 1}', '{"a":"x --delete"}']
  let cases = 0
  for (const sourceCard of pool) for (const runId of pool) for (const note of pool) for (const tag of pool) for (const follow of [undefined, true]) {
    const payload = Object.fromEntries(Object.entries({ sourceCard, runId, note, tag, follow }).filter(([, value]) => value !== undefined))
    const line = assembleLine(fields, undefined, payload)
    const carried = Object.fromEntries(Object.entries(payload).filter(([name, value]) =>
      name !== "follow" && typeof value === "string" && value.trim() !== "" && !line.withheld.includes(name)))
    // Round trip on the exact line, flag included: the read is exactly the carried values.
    const read = positionalRead(fields, undefined, line.args).payload
    expect(read).toEqual(carried)
    // Every set value is either carried or reported withheld; none vanishes silently.
    for (const [name, value] of Object.entries(payload)) {
      if (name === "follow" || (typeof value === "string" && value.trim() === "")) continue
      expect(name in carried || line.withheld.includes(name)).toBe(true)
    }
    // A true boolean is always carried, as a trailing token.
    if (follow === true) expect(line.args.split(" ").at(-1)).toBe("--follow")
    expect(assembleArgs(fields, undefined, payload)).toBe(line.args)
    cases += 1
  }
  expect(cases).toBe(pool.length ** 4 * 2)
  // The reviewer's witnesses: a multi-word value short of the final slot, and a value behind a hole.
  expect(assembleLine(fields, undefined, { runId: "run-1", note: "look here" })).toEqual({ args: "run-1", withheld: ["note"] })
  expect(assembleLine(fields, undefined, { runId: "run-1", tag: "t" })).toEqual({ args: "run-1", withheld: ["tag"] })
  expect(assembleLine(fields, undefined, { runId: "run-1", note: "", tag: "t" })).toEqual({ args: "run-1", withheld: ["tag"] })
  expect(assembleLine(fields, undefined, { runId: "run-1", note: "n", tag: "t u", follow: true })).toEqual({ args: "run-1 n t u --follow", withheld: [] })
  // JSON with whitespace short of the final slot would give its second half to the next field.
  expect(assembleLine(fields, undefined, { runId: "run-1", note: '{"a": 1}', tag: "victim" })).toEqual({ args: "run-1", withheld: ["note", "tag"] })
})

test("assembleLine never lets an optional slot hand its value to a required slot behind it", () => {
  const fields = formFieldsFor(Schema.Struct({ note: Schema.optional(Schema.String), runId: Schema.String }))
  // With runId unset the read would pass the lone token to the required slot.
  expect(assembleLine(fields, undefined, { note: "n" })).toEqual({ args: "", withheld: ["note"] })
  expect(positionalRead(fields, undefined, assembleArgs(fields, undefined, { note: "n", runId: "r" })).payload).toEqual({ note: "n", runId: "r" })
})

test("assembleLine carries JSON only where the grammar reads it back whole, and refuses a spaced list item", () => {
  const fields = formFieldsFor(Schema.Struct({ input: Schema.String, paths: Schema.Array(Schema.String) }))
  // One token: carried.
  expect(assembleLine(fields, undefined, { input: '{"message":"hi"}', paths: ["a", "b"] })).toEqual({ args: '{"message":"hi"} a b', withheld: [] })
  // Whitespace or a flag token inside the JSON: the positional grammar splits it, so it is withheld.
  expect(assembleLine(fields, undefined, { input: '{"message": "hi"}', paths: ["a"] })).toEqual({ args: "", withheld: ["input", "paths"] })
  expect(assembleLine(fields, undefined, { input: '{"m":"x --delete"}', paths: ["a"] })).toEqual({ args: "", withheld: ["input", "paths"] })
  // A flow whose own partial reads the JSON balanced carries it whole.
  const balanced = (args: string) => {
    const match = /^(\{.*\})\s*(.*)$/.exec(args.trim())
    return match === null ? {} : { input: match[1], ...(match[2] === "" ? {} : { paths: match[2]!.split(/\s+/) }) }
  }
  expect(assembleLine(fields, { partial: balanced }, { input: '{"message": "hi"}', paths: ["a"] })).toEqual({ args: '{"message": "hi"} a', withheld: [] })
  // The whole list is withheld: a truncated list is a value the form never held.
  expect(assembleLine(fields, undefined, { input: "x", paths: ["a", "b c", "d"] })).toEqual({ args: "x", withheld: ["paths"] })
})

test("a flow's own args builder cannot write a flag or binding out of a value", () => {
  const fields = formFieldsFor(Schema.Struct({ sessionId: Schema.String, text: Schema.optional(Schema.String) }))
  const bare = { args: (payload: Readonly<Record<string, unknown>>) => line(text(payload, "sessionId"), text(payload, "text")) }
  // The reviewer's probe: an unquoted free-text value carrying --delete and sourceCard=.
  expect(assembleLine(fields, bare, { sessionId: "run-1", text: "x --delete sourceCard=victim" })).toEqual({ args: "run-1", withheld: ["text"] })
  expect(assembleLine(fields, bare, { sessionId: "--delete", text: "hi" })).toEqual({ args: "hi", withheld: ["sessionId"] })
  // Honest free text still passes.
  expect(assembleLine(fields, bare, { sessionId: "run-1", text: "look here" })).toEqual({ args: "run-1 look here", withheld: [] })
  // A builder that quotes the value as a JSON string literal keeps it: the grammar reads the literal.
  const quoted = { args: (payload: Readonly<Record<string, unknown>>) => `${payload.sessionId} ${JSON.stringify(payload.text)}` }
  expect(assembleLine(fields, quoted, { sessionId: "run-1", text: "x --delete" })).toEqual({ args: 'run-1 "x --delete"', withheld: [] })
  const json = { args: (payload: Readonly<Record<string, unknown>>) => JSON.stringify(payload) }
  expect(assembleLine(fields, json, { sessionId: "run-1", text: "x --delete" }).withheld).toEqual([])
  // A builder that writes sourceCard= itself cannot be handed a second token through it; with a partial, every value must read back.
  const sourced = formFieldsFor(Schema.Struct({ sourceCard: Schema.optional(Schema.String), name: Schema.String, repo: Schema.optional(Schema.String) }))
  const build = (payload: Readonly<Record<string, unknown>>) =>
    line(text(payload, "sourceCard") === undefined ? undefined : `sourceCard=${text(payload, "sourceCard")}`, text(payload, "name"), text(payload, "repo"))
  const partial = (args: string) => {
    const tokens = args.trim().split(/\s+/).filter((token) => token !== "")
    const card = tokens[0]?.startsWith("sourceCard=") ? tokens.shift()!.slice("sourceCard=".length) : undefined
    const [name, repo] = tokens
    return { ...(card === undefined ? {} : { sourceCard: card }), ...(name === undefined ? {} : { name }), ...(repo === undefined ? {} : { repo }) }
  }
  expect(assembleLine(sourced, { args: build }, { sourceCard: "card-1 run-evil", name: "review" })).toEqual({ args: "review", withheld: ["sourceCard"] })
  expect(assembleLine(sourced, { args: build, partial }, { name: "two words", repo: "o/r" }).withheld).toContain("name")
  expect(assembleLine(sourced, { args: build, partial }, { sourceCard: "card-1", name: "review", repo: "o/r" })).toEqual({ args: "sourceCard=card-1 review o/r", withheld: [] })
})

test("a value cannot bind from: or a name= token through the line", () => {
  // change.request / prs.create shape: free text, then an optional trailing owner/repo.
  const fields = formFieldsFor(Schema.Struct({ prompt: Schema.String, repo: Schema.optional(Schema.String) }))
  const build = { args: (payload: Readonly<Record<string, unknown>>) => line(text(payload, "prompt"), text(payload, "repo")) }
  expect(assembleLine(fields, build, { prompt: "fix it from:evil-bookmark" })).toEqual({ args: "", withheld: ["prompt"] })
  expect(assembleLine(fields, build, { prompt: "fix it against=run-9" })).toEqual({ args: "", withheld: ["prompt"] })
  // Quoting does not hide a binding from a whitespace grammar.
  const quoted = {
    args: (payload: Readonly<Record<string, unknown>>) => text(payload, "prompt") === undefined ? "" : JSON.stringify(text(payload, "prompt"))
  }
  expect(assembleLine(fields, quoted, { prompt: "fix it from:evil" }).withheld).toEqual(["prompt"])
  // A slash is still text here; a flow's own trailing-repository read is the re-running caller's check.
  expect(assembleLine(fields, build, { prompt: "fix it", repo: "o/r" })).toEqual({ args: "fix it o/r", withheld: [] })
  // The default positional path refuses the same tokens.
  const positional = formFieldsFor(Schema.Struct({ title: Schema.String }))
  expect(assembleLine(positional, undefined, { title: "add thing from:evil" })).toEqual({ args: "", withheld: ["title"] })
  expect(assembleLine(positional, undefined, { title: "add thing" })).toEqual({ args: "add thing", withheld: [] })
})

test("displayLine names the withheld fields after the line", () => {
  expect(displayLine({ args: "run-1", withheld: [] })).toBe("run-1")
  expect(displayLine({ args: "run-1", withheld: ["note", "tag"] })).toBe("run-1 (+note, tag)")
  expect(displayLine({ args: "", withheld: ["note"] })).toBe("(+note)")
})
