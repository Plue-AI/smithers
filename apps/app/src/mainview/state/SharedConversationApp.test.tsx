import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import { createAppStore } from "./AppStore"
import { createAppController } from "./AppController"
import { memoryStorage, silentAgent, waitFor } from "./TestFixtures"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 20)); await GlobalRegistrator.unregister() })
const ben = { id: "turn-ben", author: 1, authorLogin: "ben", runId: "run-ben", prompt: "List changed tests", state: "completed", frames: [
  { runId: "run-ben", type: "delta", kind: "text", text: "One changed test" }, { runId: "run-ben", type: "done", reason: "stop" }
] }

test("install shell reads shared authors and clears stale output across branch and account changes", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: string[] = []
  let finish!: (value: Response) => void
  let starts = 0
  const controller = createAppController(store, { ...silentAgent, startTurn: async () => { starts++; return { status: "started" } } }, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null },
    fetchImpl: async input => {
      const path = String(input); requests.push(path)
      if (path === "/api/conversations/main") return Response.json({ id: "main", entries: [ben] })
      if (path === "/api/conversations/feature") return new Promise(resolve => { finish = resolve })
      return new Response("{}", { status: 404 })
    }
  })
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "message.appended", actor: "system", text: "PRIVATE LEGACY HISTORY" }).isPersisted.promise
    flushSync(() => root.render(<ControllerTestProvider controller={controller}><App /></ControllerTestProvider>))
    await waitFor(() => host.querySelector("[data-shared-turn]") !== null)
    expect(host.textContent).toContain("Smithers for ben")
    expect(host.textContent).toContain("One changed test")
    expect(host.textContent).not.toContain("PRIVATE LEGACY HISTORY")
    await controller.selectConversationBranch("feature")
    await waitFor(() => requests.includes("/api/conversations/feature"))
    expect(host.querySelector("[data-shared-turn]")).toBeNull()
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
    finish(Response.json({ id: "feature", entries: [ben] }))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(host.querySelector("[data-shared-turn]")).toBeNull()
    expect(starts).toBe(0)
    expect(requests.some(path => /\/api\/(agent|chat)\/turn$/.test(path))).toBe(false)
  } finally { flushSync(() => root.unmount()); host.remove(); await controller.dispose() }
})
