import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { NoInput, operation } from "../src/app-operations"
import type { Operation } from "../src/app-operations"
import { WIKI_DISPLAY_NAME, wikiOperations, wikiSurfaceOperations } from "../src/app-operations/wiki"
import { formFieldsFor, submissionPayload } from "../src/flow-form"

const all: ReadonlyArray<Operation> = [...wikiSurfaceOperations, ...wikiOperations]
const named = (name: string) => {
  const found = all.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`no ${name} operation`)
  return found
}

describe("wiki operations", () => {
  test("wiki.create declares its requirement, confirmation and input without a host handler", () => {
    const create = named("wiki.create")
    expect(create.requires).toEqual(["signed-in"])
    expect(create.confirm).toBe("refresh the repository Wiki")
    expect(create.args).toBe("<owner/repo>")
    expect(Schema.decodeUnknownSync(create.input)({ repo: "acme/app" })).toEqual({ repo: "acme/app" })
    expect(() => Schema.decodeUnknownSync(create.input)({})).toThrow()
    expect(() => Schema.decodeUnknownSync(create.input)({ repo: "" })).toThrow()
    expect("handler" in create).toBe(false)
  })

  test("no operation carries a host handler or preparation", () => {
    for (const declared of all) {
      expect(Object.keys(declared)).not.toContain("handler")
      expect(Object.keys(declared)).not.toContain("prepare")
    }
  })

  test("names are unique and stay in the wiki namespace", () => {
    const names = all.map((declared) => declared.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name === "wiki" || name.startsWith("wiki.")).toBe(true)
  })

  test("every user-only operation states why robots may not invoke it", () => {
    const userOnly = all.filter((declared) => declared.userOnly === true)
    expect(userOnly.map((declared) => declared.name).sort()).toEqual([
      "wiki.ask", "wiki.attach", "wiki.delete.cancel", "wiki.delete.confirm", "wiki.heading", "wiki.pane"
    ])
    for (const declared of userOnly) expect(declared.userOnlyReason?.length ?? 0).toBeGreaterThan(0)
  })

  test("consequential operations confirm instead of becoming user-only", () => {
    expect(named("wiki.cloud.delete").confirm).toBe("delete the Wiki page")
    expect(named("wiki.cloud.delete").userOnly).toBeUndefined()
  })

  test("summaries use the product name", () => {
    expect(WIKI_DISPLAY_NAME).toBe("Wiki")
    expect(named("wiki").summary).toBe("See what Smithers understands (Wiki)")
    expect(named("wiki.pane").summary).toBe("Open the Wiki beside the chat")
  })

  test("each input decodes what its argument hint names", () => {
    expect(Schema.decodeUnknownSync(named("wiki.space").input)({ space: "private" })).toEqual({ space: "private" })
    expect(() => Schema.decodeUnknownSync(named("wiki.space").input)({ space: "team" })).toThrow()
    expect(Schema.decodeUnknownSync(named("wiki.cloud").input)({ repo: "acme/app", page: 2 })).toEqual({ repo: "acme/app", page: 2 })
    expect(Schema.decodeUnknownSync(named("wiki.pane").input)({})).toEqual({})
    expect(named("wiki.attach").args).toBe("[path] [owner/repo]")
    expect(Schema.decodeUnknownSync(named("wiki.attach").input)({ path: "assets/diagram.png", repo: "acme/app" })).toEqual({ path: "assets/diagram.png", repo: "acme/app" })
  })
})

describe("operation", () => {
  test("NoInput accepts the empty object", () => {
    const payload: typeof NoInput.Type = {}
    const encoded: typeof NoInput.Encoded = {}
    type Rejects<T> = T extends typeof NoInput.Type ? false : true
    const rejectsProperties: Rejects<{ extra: string }> = true
    const rejectsNumericProperties: Rejects<{ 0: number }> = true
    const rejectsArrays: Rejects<[]> = true
    const rejectsStrings: Rejects<string> = true
    const rejectsNumbers: Rejects<number> = true
    const rejectsBooleans: Rejects<boolean> = true
    const rejectsNull: Rejects<null> = true
    const rejectsUndefined: Rejects<undefined> = true
    expect([
      rejectsProperties, rejectsNumericProperties, rejectsArrays, rejectsStrings,
      rejectsNumbers, rejectsBooleans, rejectsNull, rejectsUndefined
    ]).toEqual(Array(8).fill(true))
    expect(Schema.decodeUnknownSync(NoInput)(payload)).toEqual({})
    expect(Schema.decodeUnknownSync(NoInput)(encoded)).toEqual({})
  })

  test.each([
    ["unknown property", { extra: true }],
    ["undefined property", { extra: undefined }],
    ["numeric property", { 0: "value" }],
    ["empty array", []],
    ["populated array", [1]],
    ["empty string", ""],
    ["string", "input"],
    ["zero", 0],
    ["number", 42],
    ["NaN", NaN],
    ["infinity", Infinity],
    ["true", true],
    ["false", false],
    ["null", null],
    ["undefined", undefined]
  ])("NoInput rejects %s at the public decoder", (_name, value) => {
    expect(() => Schema.decodeUnknownSync(NoInput)(value)).toThrow()
  })

  test("NoInput derives a closed object JSON Schema", () => {
    expect(Schema.toJsonSchemaDocument(NoInput).schema).toEqual({ type: "object", additionalProperties: false })
  })

  test("no-input consumers retain empty forms and valid submissions", () => {
    const consumers = all.filter((declared) => declared.input === NoInput)
    expect(consumers.length).toBeGreaterThan(0)
    for (const declared of consumers) {
      const fields = formFieldsFor(declared.input)
      expect(fields).toEqual([])
      expect(submissionPayload(declared.input, fields, {}, {})).toEqual({ payload: {} })
      expect(Schema.decodeUnknownSync(declared.input)({})).toEqual({})
      expect(() => Schema.decodeUnknownSync(declared.input)({ extra: 1 })).toThrow()
    }
  })

  test("keeps the declaration's literal shape for host binding", () => {
    const declared = operation({ name: "demo.run", summary: "Run the demo", input: Schema.Struct({ id: Schema.String }), requires: ["signed-in"] })
    expect(declared).toEqual({ name: "demo.run", summary: "Run the demo", input: declared.input, requires: ["signed-in"] })
  })
})
