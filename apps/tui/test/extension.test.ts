import type { FlowDescriptor } from "@smthrs/registry/Descriptor"
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as Extension from "../src/extension.ts"

const listed = (overrides: Partial<Extension.Descriptor> = {}): Extension.Descriptor => ({
  name: "review",
  description: "Reviews the change.",
  modelInvocable: true,
  kind: "markdown",
  flows: [],
  capabilities: ["fs:read:**"],
  path: "/repo/flows/review/flow.mdx",
  ...overrides
})

describe("contributions", () => {
  test("a bare ui.publish panel stays a tab", () => {
    const decoded = Extension.decode({ id: "plan", title: "Plan", summary: "Two steps.", rows: [] })
    expect(decoded).toEqual({
      kind: "panel",
      placement: "tab",
      panel: { id: "plan", title: "Plan", summary: "Two steps.", rows: [] }
    })
  })

  test("a panel can be placed as a transcript card", () => {
    const decoded = Extension.decode({
      kind: "panel",
      placement: "card",
      panel: { id: "plan", title: "Plan", summary: "Two steps.", rows: [] }
    })
    expect(decoded.kind === "panel" && decoded.placement).toBe("card")
  })

  test("status items are one short line", () => {
    expect(Extension.decode({ kind: "status", status: { id: "ci", text: "CI ✓" } }).kind).toBe("status")
    expect(() => Extension.decode({ kind: "status", status: { id: "ci", text: "a\nb" } })).toThrow()
    expect(() => Extension.decode({ kind: "status", status: { id: "ci", text: "x".repeat(25) } })).toThrow()
  })

  test("a global key needs ctrl or alt so typing never triggers it", () => {
    const key = (key: string, context?: "global" | "panel") => ({
      kind: "key",
      key: {
        id: "review",
        key,
        label: "Review",
        action: { kind: "flow", flow: "review" },
        ...(context ? { context } : {})
      }
    })
    expect(Extension.decode(key("alt+z")).kind).toBe("key")
    expect(() => Extension.decode(key("r"))).toThrow(/ctrl or alt/)
    expect(Extension.decode(key("r", "panel")).kind).toBe("key")
    expect(() => Extension.decode(key("hyper+r"))).toThrow()
  })

  test("actions are data: prompt, flow, agent or open", () => {
    for (
      const action of [
        { kind: "prompt", prompt: "Summarize" },
        { kind: "flow", flow: "review", input: { args: "src" } },
        { kind: "agent", agent: "review" },
        { kind: "agent", agent: "review", prompt: "Look at src" },
        { kind: "open", surface: "smithers" }
      ]
    ) {
      expect(Schema.decodeUnknownSync(Extension.Action)(action)).toEqual(action as never)
    }
    expect(() =>
      Extension.decode({ kind: "status", status: { id: "x", text: "x", action: { kind: "shell", command: "rm" } } })
    )
      .toThrow()
  })

  test("factory Retry is an explicit issue action with a positive safe integer", () => {
    const decode = Schema.decodeUnknownSync(Extension.Action)
    for (const issue of [1, 3065, Number.MAX_SAFE_INTEGER]) {
      expect(decode({ kind: "factory-retry", issue })).toEqual({ kind: "factory-retry", issue })
    }
    for (const issue of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "3065"]) {
      expect(() => decode({ kind: "factory-retry", issue })).toThrow()
    }
  })
})

describe("descriptors", () => {
  test("a markdown flow is an agent; a module flow is not", () => {
    expect(Extension.isAgent(listed())).toBe(true)
    expect(Extension.isAgent(listed({ kind: "module" }))).toBe(false)
  })

  test("metadata.tui keys default to the owner's own action", () => {
    const declared = Extension.declared(listed({
      tui: { keys: [{ key: "alt+z", label: "Review" }], status: true, card: true }
    }))
    expect(declared.problems).toEqual([])
    expect(declared.owner).toBe("repo:review")
    expect(declared.keys).toEqual([
      {
        id: "repo:review/alt+z",
        key: "alt+z",
        label: "Review",
        context: "global",
        action: { kind: "agent", agent: "review", prompt: "Review" }
      }
    ])
    expect(declared.status).toBe(true)
    expect(declared.card).toBe(true)
    expect(
      Extension.declared(listed({ kind: "module", tui: { keys: [{ key: "alt+z", label: "Review" }] } })).keys[0]?.action
    )
      .toEqual({ kind: "flow", flow: "review" })
  })

  test("a malformed manifest contributes nothing and names the problem", () => {
    const declared = Extension.declared(listed({ tui: { keys: [{ key: "r", label: "Review" }] } }))
    expect(declared.keys).toEqual([])
    expect(declared.problems[0]).toContain("review")
  })

  test("reads the registry's YAML failsafe strings: flags as \"true\", and a JSON manifest string", () => {
    // The registry parses frontmatter with YAML's failsafe schema, so every scalar arrives as a string.
    const flags = Extension.declared(
      listed({ tui: { keys: [{ key: "alt+z", label: "Review" }], status: "true", card: "false" } })
    )
    expect(flags.problems).toEqual([])
    expect([flags.status, flags.card]).toEqual([true, false])
    // A string-to-string `metadata` (the Agent Skills rule, and SKILL.md's) carries the manifest as JSON.
    const json = Extension.declared(
      listed({ tui: JSON.stringify({ keys: [{ key: "alt+z", label: "Review" }], status: true }) })
    )
    expect(json.problems).toEqual([])
    expect(json.keys.map((key) => key.key)).toEqual(["alt+z"])
    expect(json.status).toBe(true)
    expect(Extension.declared(listed({ tui: "{not json" })).problems[0]).toStartWith("review: ")
    expect(Extension.declared(listed({ tui: { status: "yes" } })).problems).toHaveLength(1)
  })

  test("no manifest contributes nothing", () => {
    expect(Extension.declared(listed())).toEqual({
      owner: "repo:review",
      keys: [],
      status: false,
      card: false,
      problems: []
    })
  })
})

describe("project", () => {
  test("reads the registry descriptor fields the TUI needs, never the body", () => {
    const projected = Extension.project({
      name: "review",
      description: "Reviews the change.",
      modelInvocable: false,
      body: { _tag: "Markdown" },
      model: { _tag: "Some", value: "openai:gpt-6-sol" },
      flows: ["read"],
      capabilities: ["fs:read:**"],
      path: "/repo/flows/review/flow.mdx",
      frontmatter: { effort: "high", metadata: { tui: { status: true } } }
    })
    expect(projected).toEqual({
      name: "review",
      description: "Reviews the change.",
      modelInvocable: false,
      kind: "markdown",
      seat: "openai:gpt-6-sol",
      effort: "high",
      flows: ["read"],
      capabilities: ["fs:read:**"],
      path: "/repo/flows/review/flow.mdx",
      tui: { status: true }
    })
    expect(Extension.project({ ...projected, body: { _tag: "Module" }, model: { _tag: "None" }, frontmatter: {} }))
      .toEqual({
        name: "review",
        description: "Reviews the change.",
        modelInvocable: false,
        kind: "module",
        flows: ["read"],
        capabilities: ["fs:read:**"],
        path: "/repo/flows/review/flow.mdx"
      })
  })
})

/** Compile-time: a real registry descriptor is a projection source. */
export const fromRegistry = (descriptor: FlowDescriptor): Extension.Descriptor => Extension.project(descriptor)
