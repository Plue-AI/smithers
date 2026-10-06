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
