import { expect, test } from "bun:test"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { memoryStorage } from "./TestFixtures"
import type { FileCard } from "@smthrs/rpc/FileCard"
import type { AgentPort } from "../runtime/AgentPort"
const controller = scopedControllers()
const agent: AgentPort = { available: false, startTurn: async () => ({ status: "error", message: "Unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} }
const file: FileCard = { branch: "main", path: "README.md", language: "markdown", digest: "fixture-one", content: { kind: "text", text: "literal mirror bytes\n" }, mode: "read_only", diagnostics: [], authors: [], editors: [] }
test("controller forwards authenticated branch options to the existing seam", async () => {
  const requests: string[] = []
  const app = controller(await createAppStore({ kind: "localStorage", storage: memoryStorage() }), agent, {
    branchOptions: { ready: () => true, scope: () => ({ branch: "main", member: "ben", revision: 1, sleeping: false }) },
    fetchImpl: async url => { requests.push(String(url)); return new Response(JSON.stringify(file)) }
  })
  expect(await app.branchFiles.read("main", "README.md")).toEqual({ ok: file })
  expect(requests).toEqual(["/api/branches/main/files/README.md"])
})
test("controller without provider receipts keeps branch reads dark", async () => {
  const requests: string[] = []
  const app = controller(await createAppStore({ kind: "localStorage", storage: memoryStorage() }), agent, {
    fetchImpl: async url => { requests.push(String(url)); return new Response(JSON.stringify(file)) }
  })
  expect(await app.branchFiles.read("main", "README.md")).toEqual({ error: "Branch files are unavailable." })
  expect(requests).toEqual([])
})

test("seeded Follow keeps the File card identity and moves its existing file row", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const app = controller(store, agent, { fetchImpl: async () => new Response("{}", { status: 404 }) })
  const file = app.design.world().files.find(file => file.gone?.kind === "renamed") ?? app.design.world().files[0]!
  app.design.patch("files", file.id, current => ({ ...current, gone: { kind: "renamed", to: "src/deliver.ts", by: "maya" } }))
  await app.commands.submit({ name: "file", payload: { path: file.path, branch: file.branch }, actor: "user" })
  const opened = [...store.collections.cards.values()].find(card => card.kind === "file" && card.payload.path === file.path)
  expect(opened?.kind).toBe("file")
  expect((await app.commands.submit({ name: "file.follow-rename", payload: { path: file.path, branch: file.branch }, actor: "user" })).status).toBe("executed")
  const followed = store.collections.cards.get(opened!.id)
  if (followed?.kind !== "file") throw new Error("Missing followed file")
  expect(followed.payload.path).toBe("src/deliver.ts")
  expect(app.design.world().files.find(row => row.id === file.id)?.path).toBe("src/deliver.ts")
  expect(app.design.world().files.find(row => row.id === file.id)?.gone).toBeUndefined()
})
