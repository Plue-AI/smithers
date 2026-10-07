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

test("Return and Keep share the numbered TODO door and retain person/agent policy", async () => {
  const { pendingControls } = await import("../src/app-operations/controls")
  const { Schema } = await import("effect")
  const rows = generateCatalog()
  for (const [name, op, agent, actors] of [["todo.return-to-item", "return-to-item", "run", ["person", "app_agent"]], ["todo.keep-moved", "keep-moved", "never", ["person"]]] as const) {
    const row = rows.find(row => row.name === name)!
    expect(row).toMatchObject({ agent, actors, minimumRole: "member", visibility: "in-card", cli: null, slash: null, http: { method: "POST", path: "/api/todos/{n}", defaults: { op } } })
    const declaration = pendingControls.find(row => row.name === name)!
    const decode = Schema.decodeUnknownSync(declaration.input)
    expect(decode({ n: 2, id: "moved-original" })).toEqual({ n: 2, id: "moved-original" })
    expect(decode({ n: 2 })).toEqual({ n: 2 })
    expect(() => decode({ n: 0, id: "moved-original" })).toThrow()
    expect(() => decode({ n: 2, id: "" })).toThrow()
  }
})


test("source co-edit declares its batch and excludes general app-agent authority", async () => {
  const { Schema } = await import("effect")
  const row = httpProjections.find(row => row.name === "flow.source-coedit")!
  expect(row).toMatchObject({ actors: ["person", "external_agent"], agent: "run", minimumRole: "member", credentialScope: "write:repository", visibility: "hidden", cli: null, slash: null,
    http: { method: "PUT", path: "/api/repos/{owner}/{repo}/workspaces/{id}/files/content" } })
  const decode = Schema.decodeUnknownSync(row.input)
  const input = { changes: [
    { path: "src/a.ts", base_digest: "absent", content: "hello" },
    { path: "src/delete.ts", base_digest: "a".repeat(64), content: null },
    { path: "asset.bin", base_digest: "absent", content: "AA==", encoding: "base64" }
  ] }
  expect(decode(input)).toEqual(input)
  expect(() => decode({ changes: [{ path: "src/a.ts", content: "hello" }] })).toThrow()
  expect(() => decode({ changes: [{ path: "src/a.ts", base_digest: "absent" }] })).toThrow()
  expect(() => decode({ changes: [{ path: "asset.bin", base_digest: "absent", content: "AA==", encoding: "unknown" }] })).toThrow()
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

test("system descriptors have no person or delegated doors",()=>{
 const rows=generateCatalog()
 for (const [name,scope] of [
 ["stack.candidate","write:repository"],["stack.propose","write:repository"],
 ["workspace.head","write:repository"],["workspace.children.list","read:workspace"],
 ["workspace.children.spawn","write:workspace"],["workspace.children.stop","write:workspace"],
 ["workspace.provider-pool","read:workspace"]] as const) {
 expect(rows.find(row=>row.name===name)).toMatchObject({name,credentialScope:scope,visibility:"hidden",agent:"never",actors:[],slash:null,cli:null})
 }
})

test("retained label writes keep their owner-only person HTTP doors", () => {
  const rows = generateCatalog()
  for (const [name, method, path] of [
    ["labels.create", "POST", "/api/repos/{owner}/{repo}/labels"],
    ["labels.update", "PATCH", "/api/repos/{owner}/{repo}/labels/{id}"],
    ["labels.delete", "DELETE", "/api/repos/{owner}/{repo}/labels/{id}"],
  ]) {
    expect(rows.find(row => row.name === name)).toMatchObject({
      minimumRole: "owner", agent: "never", actors: ["person"], credentialScope: "write:repository",
      visibility: "hidden", cli: null, slash: null, http: { method, path }
    })
  }
})

test("external reads expose no raw transcript HTTP door", () => {
  const row = generateCatalog().find(row => row.name === "external.read")!
  expect(row).toMatchObject({ agent: "never", minimumRole: "owner", actors: ["person"] })
  expect(row.http).toBeNull()
  expect(httpProjections.some(row => row.http?.path === "/api/external/sessions")).toBe(false)
})
