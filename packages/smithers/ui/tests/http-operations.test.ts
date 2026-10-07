import { expect, test } from "bun:test"
import { httpProjections } from "../src/app-operations/http"
import { generateCatalog } from "../../../../scripts/catalog-mvp"

test("HTTP projections retain literal role and actor boundaries in the shipped catalog", () => {
  const rows = generateCatalog()
  for (const [name, minimumRole, agent, actors] of [
    ["install.read", "owner", "never", ["person"]],
    ["install.scorecard", "owner", "never", ["person"]],
    ["members.list", "member", "never", ["person"]],
    ["secrets.read", "member", "never", ["person"]],
    ["todo.read", "member", "run", ["person", "app_agent", "external_agent"]],
    ["confirmations.read", "member", "run", ["person", "app_agent", "external_agent"]],
  ] as const) {
    expect(rows.find(row => row.name === name)).toMatchObject({ name, minimumRole, agent, actors, visibility: "hidden", cli: null, slash: null })
  }
  expect(rows.find(row => row.name === "todo.control")).toBeUndefined()
  expect(new Set(rows.map(row => row.name)).size).toBe(rows.length)
  for (const projection of httpProjections) expect(rows.find(row => row.name === projection.name)?.http).toEqual(projection.http)
})

test("credential scopes are literal catalog inputs", () => {
  const rows = generateCatalog()
  for (const [name, credentialScope] of [["todo.new", "write:repository"], ["todo.read", "read:repository"], ["members.list", "read:repository"], ["self.read", "read:user"], ["agent.turn", "read:user"], ["telemetry.report", "read:user"]] as const) {
    expect(rows.find(row => row.name === name)).toMatchObject({ name, credentialScope })
  }
})

test("Bring in requires the displayed wait and head on the shared branch route", async () => {
  const { pendingControls } = await import("../src/app-operations/controls")
  const { Schema } = await import("effect")
  const bring = pendingControls.find(row => row.name === "branch.bring-in")!
  expect(bring.http).toEqual({ method: "POST", path: "/api/branches/{branch}", defaults: { op: "bring-in" } })
  expect(bring.agent).toBe("confirm")
  const decode = Schema.decodeUnknownSync(bring.input)
  const input = { branch: "todo/12", id: "foreign-12", revision: "a".repeat(40) }
  expect(decode(input)).toEqual(input)
  expect(() => decode({ branch: input.branch, revision: input.revision })).toThrow()
})


test("both system rebase doors encode the typed branch POST without a caller-selected target", async () => {
  const { catalogRequest } = await import("../../src/CatalogRequest")
  const rows = generateCatalog()
  for (const name of ["branch.rebase", "branch.rebase-now"]) {
    const row = rows.find(row => row.name === name)!
    expect(row.agent).toBe("run")
    expect(row.minimumRole).toBe("member")
    expect(catalogRequest(row, { branch: "scratch/ben/work" })).toEqual({
      method: "POST", path: "/api/branches/scratch%2Fben%2Fwork", body: name === "branch.rebase" ? { op: "rebase" } : { rebase: true }
    })
  }
})


test("scratch Done preserves the retained binding through the catalog command", async () => {
  const { catalogRequest } = await import("../../src/CatalogRequest")
  const row = generateCatalog().find(row => row.name === "branch.rebase")!
  expect(catalogRequest(row, { branch: "scratch/ben/work", conflict_change: "retained-change", onto_revision: "retained-onto" })).toEqual({
    method: "POST", path: "/api/branches/scratch%2Fben%2Fwork",
    body: { op: "rebase", conflict_change: "retained-change", onto_revision: "retained-onto" }
  })
})
