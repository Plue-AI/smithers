import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, settled, silentAgent } from "./TestFixtures"
GlobalRegistrator.register({ url: "http://localhost:4000/" })
afterAll(async () => { await settled(); await GlobalRegistrator.unregister() })
const createAppController = scopedControllers()

test("the install capability opens Setup with a usable composer and no demo world or login takeover", async () => {
  const { installFixture } = await import("./seams/InstallFixtures.test-support")
  const model = installFixture()
  model.github = { signed_in: false, app_installed: false }
  delete model.repository; delete model.repositories
  model.steps = model.steps.map(step => ({ id: step.id, state: "pending" }))
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, { bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", authFlow: "redirect", sandbox: null, capabilities: ["identity", "install"] },
    fetchImpl: async input => String(input).endsWith("/api/install") ? Response.json(model) : new Response("", { status: 404 }) })
  await settled()
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(<ControllerTestProvider controller={controller}><App /></ControllerTestProvider>))
  const h = { host, markup: () => host.innerHTML }
  try {
  await settled()
  expect(h.host.querySelector('[data-kind="setup"]')).not.toBeNull()
  expect(h.markup()).not.toContain("acme/api")
  expect(h.markup()).not.toContain("Upgrade the Stripe")
  expect(h.markup()).not.toContain("Welcome to Smithers")
  expect(h.host.querySelector('[data-keyboard-pane="Chat controls"]')).not.toBeNull()
  } finally { flushSync(() => root.unmount()); host.remove() }
})
