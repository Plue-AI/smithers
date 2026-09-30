import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { operation } from "../src/app-operations"
import { WIKI_DISPLAY_NAME, wikiOperations, wikiSurfaceOperations } from "../src/app-operations/wiki"

const all = [...wikiSurfaceOperations, ...wikiOperations]
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
  })
})

describe("operation", () => {
  test("keeps the declaration's literal shape for host binding", () => {
    const declared = operation({ name: "demo.run", summary: "Run the demo", input: Schema.Struct({ id: Schema.String }), requires: ["signed-in"] })
    expect(declared).toEqual({ name: "demo.run", summary: "Run the demo", input: declared.input, requires: ["signed-in"] })
  })
})
