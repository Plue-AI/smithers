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
