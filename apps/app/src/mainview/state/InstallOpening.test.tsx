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

test("a reload while the GitHub App step runs shows Setup and stays on the page; only the person's press goes to GitHub (#3455)", async () => {
  const { installFixture } = await import("./seams/InstallFixtures.test-support")
  const model = installFixture()
  model.github = { signed_in: false, app_installed: false }
  delete model.repository; delete model.repositories
  model.steps = model.steps.map(step => ({ id: step.id, state: step.id === "address" ? "done" : step.id === "app_manifest" ? "running" : "pending" }))
  const action_url = "https://github.com/settings/apps/new?state=earlier"
  const submits: string[] = []
  const submit = HTMLFormElement.prototype.submit
  HTMLFormElement.prototype.submit = function (this: HTMLFormElement) { submits.push(this.action) }
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "install.requests.changed", actor: "user", requests: [{ id: "earlier", origin: "", step: "app_manifest", body: { owner: "acme" },
    state: "running", handoff: { action_url, manifest: { name: "Smithers" }, state: "earlier" }, expires_at: new Date(Date.now() + 60_000).toISOString() }] }).isPersisted.promise
  const posts: string[] = []
  const controller = createAppController(store, silentAgent, { bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", authFlow: "redirect", sandbox: null, capabilities: ["identity", "install"] },
    fetchImpl: async (input, init) => {
      if (init?.method === "POST") posts.push(String(input))
      return String(input).endsWith("/api/install") ? Response.json(model) : new Response("", { status: 404 })
    } })
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(<ControllerTestProvider controller={controller}><App /></ControllerTestProvider>))
    for (let n = 0; n < 50 && !host.querySelector('[data-step="app_manifest"] form button'); n++) await settled()
    expect(submits).toEqual([])
    expect(host.querySelector('[data-step="app_manifest"]')?.getAttribute("data-state")).toBe("running")
    const button = host.querySelector<HTMLButtonElement>('[data-step="app_manifest"] form button')!
    expect(button.textContent).toBe("Create GitHub App"); expect(button.disabled).toBe(false)
    expect(host.querySelector<HTMLInputElement>('[data-step="app_manifest"] form input')?.value).toBe("acme")
    button.click()
    for (let n = 0; n < 50 && submits.length === 0; n++) await settled()
    expect(submits).toEqual([action_url])
    expect(posts.filter(path => path.endsWith("/api/install/setup/app"))).toEqual([])
  } finally { HTMLFormElement.prototype.submit = submit; flushSync(() => root.unmount()); host.remove() }
})

test("Setup Sign in follows the GitHub door after the setup-only identity answers unauthenticated (#3455)", async () => {
  const { installFixture } = await import("./seams/InstallFixtures.test-support")
  const model = installFixture()
  model.github = { signed_in: false, app_installed: false }
  model.steps = model.steps.map((step, index) => ({ id: step.id, state: index < 2 ? "done" : "pending" }))
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, { bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", authFlow: "redirect", sandbox: null, capabilities: ["identity", "install"] },
    fetchImpl: async input => String(input).endsWith("/api/install") ? Response.json(model) : Response.json({ code: "unauthenticated", class: "permission", message: "Sign in required" }, { status: 401 }) })
  await settled()
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(<ControllerTestProvider controller={controller}><App /></ControllerTestProvider>))
    await settled()
    await controller.loadSession()
    expect(store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
    const button = host.querySelector<HTMLButtonElement>('[data-step="sign_in"] button')!
    expect(button.textContent).toBe("Sign in")
    button.click(); await settled()
    expect(window.location.pathname).toBe("/api/auth/github")
    expect(host.textContent).not.toContain("Sign-in isn't available")
  } finally { window.history.replaceState({}, "", "/"); flushSync(() => root.unmount()); host.remove() }
})
