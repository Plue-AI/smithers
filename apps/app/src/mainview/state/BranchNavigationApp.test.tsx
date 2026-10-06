import { createWebAgent } from "../native/WebAgent"
import historyFixture from "./testdata/earlier-history.json"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import { createAppStore } from "./AppStore"
import { createAppController, type AppController } from "./AppController"
import { memoryStorage, silentAgent, waitFor } from "./TestFixtures"
import { branchTree } from "./seams/BranchNavigationSeam"

GlobalRegistrator.register()
const controllers: AppController[] = []
const controllerFor: typeof createAppController = (...args) => { const controller = createAppController(...args); controllers.push(controller); return controller }
const cleanups: Array<() => void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) cleanup(); for (const controller of controllers.splice(0)) await controller.dispose() })
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 20)); await GlobalRegistrator.unregister() })
const row = (name: string, from = "main", state = "awake") => ({ name, kind: "scratch", state, machine: { id: name }, forked_from: { ref: from } })

const mount = (controller: ReturnType<typeof controllerFor>) => {
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(<ControllerTestProvider controller={controller}><App /></ControllerTestProvider>))
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  return host
}

test("/branches mounts the install tree before an unresolved read, then shows real rows and readonly Earlier", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let finish!: (value: Response) => void
  const read = new Promise<Response>(resolve => { finish = resolve })
  let starts = 0
  const controller = controllerFor(store, { ...silentAgent, startTurn: async () => { starts++; return { status: "started" } } }, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null },
    fetchImpl: async input => String(input).includes("/api/branches?") ? read : new Response("{}", { status: 404 })
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "message.appended", actor: "system", text: "Archived greeting" }).isPersisted.promise
  await store.dispatch({ type: "conversation.cleared", actor: "user", branchId: "new-conversation", notes: [] }).isPersisted.promise
  const host = mount(controller)
  const result = await controller.submitCommand({ name: "branches", payload: {}, actor: "user" })
  expect(result.status).toBe("executed")
  await waitFor(() => host.querySelector('nav[aria-label="Branches"]') !== null)
  expect(store.session().branchNavigation?.nodes).toEqual([])
  finish(Response.json([row("retry"), row("nested", "retry"), row("closed", "main", "closed")]))
  await waitFor(() => host.querySelector('[data-node="nested"]') !== null)
  expect(host.querySelector('[data-node="closed"]')).toBeNull()
  expect(host.querySelector('[data-node="b-retry"]')).toBeNull()
  expect(host.querySelector('[data-node="nested"]')?.closest("li")?.getAttribute("data-depth")).toBe("2")
  flushSync(() => host.querySelector<HTMLButtonElement>('[data-node="earlier"]')!.click())
  await waitFor(() => host.querySelector('[aria-label="Earlier"]') !== null)
  flushSync(() => host.querySelector<HTMLButtonElement>('[data-archive="branch-main"]')!.click())
  await waitFor(() => host.querySelector(".archive-entries")?.textContent?.includes("Archived greeting") === true)
  expect(host.querySelector(".archive-entries button")).toBeNull()
  expect(starts).toBe(0)
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
  await waitFor(() => host.querySelector('[aria-label="Earlier"]') === null)
})

test("tree refuses cycles and repeated branch identities", () => {
  expect(() => branchTree([row("a", "b"), row("b", "a")])).toThrow("Cyclic")
  expect(() => branchTree([row("a"), row("a")])).toThrow("Repeated")
})


test("Earlier combines two browser archives with private journal replay without restoring execution", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: Array<{ path: string; method: string; body?: unknown }> = []
  const history = createWebAgent({ fetchImpl: async (input, init) => {
    const path = String(input)
    requests.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    return Response.json(store.collections.identitySessions.get("identity")?.login === "alice" ? { status: "ok", conversations: [], next: null } : path.endsWith("/replay") ? historyFixture.replay : historyFixture.index)
  } }).history
  let starts = 0
  const controller = controllerFor(store, { ...silentAgent, history, startTurn: async () => { starts++; return { status: "started" } } }, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null },
    fetchImpl: async input => String(input).includes("/api/branches?") ? Response.json([]) : new Response("{}", { status: 404 })
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "message.appended", actor: "system", text: "First browser archive" }).isPersisted.promise
  await store.dispatch({ type: "conversation.cleared", actor: "user", branchId: "local-two", notes: [] }).isPersisted.promise
  await store.dispatch({ type: "message.appended", actor: "system", text: "Second browser archive" }).isPersisted.promise
  await store.dispatch({ type: "conversation.cleared", actor: "user", branchId: "current", notes: [] }).isPersisted.promise
  await store.dispatch({ type: "message.appended", actor: "system", text: "Current conversation" }).isPersisted.promise
  const messages = [...store.collections.messages.values()].map(row => row.text)
  const host = mount(controller)
  expect((await controller.submitCommand({ name: "branches", payload: {}, actor: "user" })).status).toBe("executed")
  await waitFor(() => store.collections.branches.has("earlier:journal:legacy-journal"))
  expect([...store.collections.messages.values()].map(row => row.text)).toEqual(messages)
  expect(store.session().activeBranchId).toBe("current")
  flushSync(() => host.querySelector<HTMLButtonElement>('[data-node="earlier"]')!.click())
  await waitFor(() => host.querySelectorAll("[data-archive]").length === 3)
  flushSync(() => host.querySelector<HTMLButtonElement>('[data-archive="earlier:journal:legacy-journal"]')!.click())
  await waitFor(() => host.querySelector(".archive-entries")?.textContent?.includes("Archived journal greeting") === true)
  expect(host.querySelector(".archive-entries")?.textContent).toContain("Legacy journal question")
  expect(host.querySelectorAll(".archive-entries button")).toHaveLength(0)
  expect(starts).toBe(0)
  expect(requests).toEqual([
    { path: "/api/agent/conversations", method: "GET" },
    { path: "/api/agent/conversations/replay", method: "POST", body: { runId: "legacy-turn", legId: "legacy-leg" } }
  ])
  expect(store.collections.httpTurns.size).toBe(0)
  expect(store.collections.runtimeApprovals.size).toBe(0)
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
  await waitFor(() => host.querySelector(".archive-entries") === null)
  await controller.submitCommand({ name: "branches", payload: {}, actor: "user" })
  await waitFor(() => host.querySelector('[data-node="earlier"]') !== null)
  flushSync(() => host.querySelector<HTMLButtonElement>('[data-node="earlier"]')!.click())
  await waitFor(() => host.querySelector('[aria-label="Earlier"]') !== null)
  expect(host.querySelectorAll("[data-archive]")).toHaveLength(0)
})
