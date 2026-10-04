/*
 * The registry's data tables read per-namespace exports (wave 0, 2026-09-07):
 * a namespace row, a requirement row or a recommendation row lives in the
 * module under ./entries that owns the flow it names, and registry.ts only
 * aggregates them in display order. These tests prove the aggregation is
 * complete and in the right module, so a lane that exports a row from its
 * module but forgets the registry line, or files a row under the wrong
 * namespace, fails here.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { FlowRequirement, Namespace, Recommendation } from "./registry"
import { flowRequirements, NAMESPACES, namespaceOf, recommendations } from "./registry"

interface EntriesModule {
  readonly namespace?: Namespace
  readonly requirements?: ReadonlyArray<FlowRequirement>
  readonly recommendations?: ReadonlyArray<Recommendation>
}

/** Every namespace module, keyed by its file name (the namespace id). */
const modules = async (): Promise<Map<string, EntriesModule>> => {
  const dir = fileURLToPath(new URL("./entries/", import.meta.url))
  const out = new Map<string, EntriesModule>()
  for (const file of readdirSync(dir).sort()) {
    /* A namespace module, never a suite beside one: importing a test file would run its cases here. */
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file === "Declare.ts") continue
    out.set(file.slice(0, -3), (await import(`./entries/${file}`)) as EntriesModule)
  }
  return out
}

describe("registry data tables read the namespace modules", () => {
  test("every namespace row is the row its own module exports, and every exported row is listed", async () => {
    const found = await modules()
    // These shared modules retain historical metadata; every app door in
    // these namespaces was explicitly Cut, so no palette row remains.
    const cutNamespaces = new Set(["connector", "notifications", "repository", "smithers", "system", "tab", "workspace"])
    const exported = [...found].flatMap(([id, module]) =>
      module.namespace === undefined || cutNamespaces.has(id) ? [] : [{ id, row: module.namespace }]
    )
    for (const id of cutNamespaces) expect(NAMESPACES.some(row => row.id === id)).toBe(false)
    expect(exported.length).toBeGreaterThan(30)
    for (const { id, row } of exported) {
      expect(row.id).toBe(id)
      expect(NAMESPACES.includes(row)).toBe(true)
    }
    expect(NAMESPACES.length).toBe(exported.length)
    expect(new Set(NAMESPACES.map((row) => row.id)).size).toBe(NAMESPACES.length)
  })

  test("the box namespace is labeled Boxes: the product says box, never computer (design session 2026-09-07, #2147)", () => {
    const row = NAMESPACES.find((candidate) => candidate.id === "box")
    expect(row?.label).toBe("Boxes")
    expect(row?.summary).toContain("box")
    expect(row?.summary.toLowerCase()).not.toContain("computer")
  })

  // A requirement that is a pure wait declares no fulfilling flow; it still
  // belongs to the namespace that owns the thing being waited on.
  test("every requirement row comes from a module whose flow fulfills it", async () => {
    const found = await modules()
    const exported = [...found].flatMap(([id, module]) => (module.requirements ?? []).map((row) => ({ id, row })))
    expect(exported.length).toBe(flowRequirements.length)
    for (const { id, row } of exported) {
      expect(flowRequirements.includes(row)).toBe(true)
      if (row.fulfill !== undefined) expect(namespaceOf(row.fulfill)).toBe(id)
    }
  })

  /* Bare flows whose module is not named after them: `connect` lives in connector.ts; mvp.md Appendix A renamed `chat.stop` and `auth.sign-in` to bare names their modules keep. */
  const BARE_OWNERS: Readonly<Record<string, string>> = { connect: "connector", stop: "chat", "sign-in": "auth" }

  test("every recommendation row comes from the module that owns the flow it offers", async () => {
    const found = await modules()
    const exported = [...found].flatMap(([id, module]) => (module.recommendations ?? []).map((row) => ({ id, row })))
    expect(exported.length).toBe(recommendations.length)
    for (const { id, row } of exported) {
      expect(recommendations.includes(row)).toBe(true)
      expect(namespaceOf(row.name) ?? BARE_OWNERS[row.name] ?? row.name).toBe(id)
    }
  })
})
