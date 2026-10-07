import { expect, test } from "bun:test"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Flow"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, silentAgent, waitFor, settle } from "./TestFixtures"
const controllerFor = scopedControllers()
const fixture = async (storage = memoryStorage()) => {
 const store = await createAppStore({ kind: "localStorage", storage })
 let resolve!: (response: Response) => void, reads = 0
 const response = new Promise<Response>(yes => { resolve = yes })
 const controller = controllerFor(store, silentAgent, {
  bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "none", sandbox: null },
  fetchImpl: async input => { if (new URL(String(input), "https://app.test").pathname === "/api/flows") { reads++; return response } return Response.json({}, { status: 404 }) }
 })
 await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "member", admin: false, scopesPlain: null }).isPersisted.promise
 return { store, storage, controller, resolve, reads: () => reads }
}
test("installed /flows stays usable through an unresolved read and presents only served flows", async () => {
 const h = await fixture()
 expect(await h.controller.commands.run("flows")).toMatchObject({ status: "executed", value: "Requested" })
 expect(await h.controller.commands.run("flows")).toMatchObject({ status: "executed", value: "Requested" })
 expect(h.reads()).toBe(1)
 expect(h.store.collections.cards.size).toBe(0)
 await h.controller.presentRun("unrelated", "Unrelated", false)
 h.resolve(Response.json([fixtures.repository.model]))
 await waitFor(() => h.store.collections.cards.has("flow:checks"))
 expect([...h.store.collections.cards.values()].filter(card => card.kind === "flow").map(card => card.payload.name)).toEqual(["checks"])
 expect(h.reads()).toBe(1)
})
test("failed and stale installed flow reads create no seeded cards", async () => {
 for (const outcome of ["failed", "stale"] as const) {
  const h = await fixture()
  await h.controller.commands.run("flows")
  if (outcome === "stale") await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "another", admin: false, scopesPlain: null }).isPersisted.promise
  h.resolve(outcome === "failed" ? Response.json({}, { status: 503 }) : Response.json([fixtures.repository.model]))
  if (outcome === "failed") await waitFor(() => [...h.store.collections.toasts.values()].some(toast => toast.key === "flows.list" && toast.status === "failed"))
  else await settle(5)
  expect([...h.store.collections.cards.values()].filter(card => card.kind === "flow")).toEqual([])
  if (outcome === "stale") expect(h.store.session().flowInventoryRequest).toBeUndefined()
 }
})

test("reload resumes the same durable inventory request without replaying the retired alias", async () => {
 const first = await fixture()
 await first.controller.commands.run("flows")
 await waitFor(() => first.reads() === 1)
 const original = first.store.session().flowInventoryRequest!
 expect(["requested", "running"]).toContain(original.state)
 await first.controller.dispose()
 const second = await fixture(first.storage)
 await waitFor(() => second.reads() === 1)
 expect(second.store.session().flowInventoryRequest?.id).toBe(original.id)
 expect(await second.controller.commands.run("flows")).toMatchObject({ value: "Requested" })
 expect(second.reads()).toBe(1)
 first.resolve(Response.json([fixtures.active.model]))
 second.resolve(Response.json([fixtures.repository.model]))
 await waitFor(() => second.store.session().flowInventoryRequest?.state === "completed")
 expect(second.store.collections.cards.has("flow:checks")).toBe(true)
 expect(second.store.collections.cards.has("flow:todo")).toBe(false)
})
