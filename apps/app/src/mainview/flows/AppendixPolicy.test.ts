import { expect, test } from "bun:test"
import b from "./fixtures/AppendixBPolicy.json"
import c from "./fixtures/AppendixC.json"
import cli from "../../../../../packages/smithers/test/CatalogCli.fixture.json"
import { assertCatalogPolicy, auditAppIds, auditCliPaths, auditRuntimeTags } from "../../../../../scripts/catalog-policy"

test("literal B inventory expands shorthand without authorizing renamed aliases", () => {
  expect(b.rows).toHaveLength(118)
  expect(b.rows.flatMap(row => row.ids)).toContain("chat.queue.edit")
  expect(b.rows.flatMap(row => row.ids)).toContain("storage.recovery.export")
  expect(b.rows.flatMap(row => row.ids)).not.toContain("chat.edit")
  expect(auditAppIds(b.publicIds)).toEqual([])
  expect(b.rows.find(row => row.ids.includes("branch.archive"))).toEqual({ section: "B.2", ids: ["branch.archive"], status: "keep", who: "P, A✓, X✓" })
  expect(auditAppIds(["branch.archive", "branch.archive-all"])).toEqual([{ id: "branch.archive-all", reason: "unlisted" }])
  expect(auditAppIds(["auth.email", "todo.takeover", "history.bootstrap", "runs.graph.execution", "wiki.card.select"])).toEqual([])
  expect(auditAppIds(["history.todo", "box.open", "prs.land", "change.land", "chat.clear", "world.page", "invented"])).toEqual([
    { id: "history.todo", reason: "renamed" }, { id: "box.open", reason: "renamed" },
    { id: "prs.land", reason: "renamed" }, { id: "change.land", reason: "renamed" },
    { id: "chat.clear", reason: "cut" }, { id: "world.page", reason: "cut" }, { id: "invented", reason: "unlisted" }
  ])
  expect(auditAppIds(["search.secrets", "flows", "issues", "workspace.rename.edit"])).toEqual([
    { id: "workspace.rename.edit", reason: "cut" }
  ])
})

test("literal B.6 policy rejects unknown paths and forbidden groups", () => {
  expect(auditCliPaths([...cli.commands.map(row => row.path), ...cli.b6])).toEqual([])
  for (const group of cli.excluded) expect(auditCliPaths([`${group} invented`])).toEqual([{ id: `${group} invented`, reason: "unlisted" }])
  expect(auditCliPaths(["history todo", "workspace children", "host invented"])).toHaveLength(3)
})

test("literal C rejects cut, replaced, unknown and misplaced registry entries", () => {
  expect(c.rows).toHaveLength(389)
  for (const row of c.rows.filter(row => !row.id.includes("<"))) {
    const tags = [{ id: row.id, runtime: row.runtime as "install" | "machine", kind: row.kind }]
    const expected = row.status === "cut" ? "cut" : row.status === "replaced" && !(row.id in c.engineeringOverrides) ? "replaced" : null
    expect(auditRuntimeTags(tags), row.id).toEqual(expected === null ? [] : [{ id: row.id, reason: expected }])
  }
  expect(auditRuntimeTags([{ id: "coding/Request", runtime: "machine" }, { id: "coding/Vibe", runtime: "machine" }])).toEqual([
    { id: "coding/Request", reason: "replaced" }, { id: "coding/Vibe", reason: "replaced" }
  ])
  expect(auditRuntimeTags([{ id: "coding/Verify", runtime: "machine" }, { id: "review/change", runtime: "machine" }])).toEqual([])
  expect(auditRuntimeTags([{ id: "coding/ImplementPlan", runtime: "install" }])).toEqual([{ id: "coding/ImplementPlan", reason: "runtime" }])
  expect(auditRuntimeTags([{ id: "invented/Flow", runtime: "machine" }])).toEqual([{ id: "invented/Flow", reason: "unlisted" }])
})

test("parameterized actions require their inventoried source, and failures name the offending row", () => {
  expect(auditRuntimeTags([{ id: "model/parked", kind: "action", runtime: "machine", source: "packages/smithers/agent/src/Agent.ts" }])).toEqual([])
  expect(auditRuntimeTags([{ id: "model/parked", kind: "action", runtime: "machine", source: "flows/invented.ts" }])).toEqual([{ id: "model/parked", reason: "unlisted" }])
  expect(() => assertCatalogPolicy(auditAppIds(["chat.clear", "invented"]))).toThrow("cut: chat.clear\nunlisted: invented")
  expect(() => assertCatalogPolicy([])).not.toThrow()
})

test("build command rejects injected aliases and Replaced entry points without loading repository bodies", async () => {
  const script = new URL("../../../../../scripts/catalog-allowlist.ts", import.meta.url)
  for (const [args, diagnostic] of [
    [["--app-id", "box.open", "invented"], "renamed: box.open\nunlisted: invented"],
    [["--cli-path", "history todo", "host invented"], "unlisted: history todo\nunlisted: host invented"],
    [["--tag", "machine", "coding/Request"], "replaced: coding/Request"],
    [["--tag", "machine", "coding/Vibe"], "replaced: coding/Vibe"],
    [["--tag", "install", "coding/ImplementPlan"], "runtime: coding/ImplementPlan"]
  ] as const) {
    const child = Bun.spawn([Bun.which("bun")!, script.pathname, ...args], { stdout: "pipe", stderr: "pipe" })
    const output = await new Response(child.stderr).text()
    expect(await child.exited).toBe(1)
    expect(output).toContain(diagnostic)
  }
}, 120_000)
