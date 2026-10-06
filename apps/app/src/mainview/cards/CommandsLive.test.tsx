import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import { ControllerTestProvider } from "../ControllerContext"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { memoryStorage, settle } from "../state/TestFixtures"
import { renderCardBody } from "./CardRenderers"

GlobalRegistrator.register()
afterAll(async () => { await settle(); await GlobalRegistrator.unregister() })

// Keep the actual card mounted: server rendering on each assertion would hide
// missing subscriptions and falsely prove that the help catalog is live.
const mount = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, {
    available: false, startTurn: async () => ({ status: "error", message: "unavailable" }),
    cancelTurn: async () => {}, subscribe: () => () => {}
  }, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: [...cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: false, terminal: false }), "install"], authFlow: "none", sandbox: null },
    fetchImpl: async request => String(request).endsWith("/api/members") ? Response.json({ members: [
      { login: "will", name: "Will", avatar_url: "https://github.com/avatar.png", color_index: 0,
        role: "owner", needs_access: false, suspended: false, actions: [] }
    ], access_url: "https://github.com/smithersai/smithers/settings/access" }) : new Response("", { status: 404 })
  })
  const identity = async (state: "signed-in" | "signed-out", login: string | null) => {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state, login, admin: false, scopesPlain: null }).isPersisted.promise
    await settle()
  }
  await identity("signed-in", "will")
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: ["one", "two"].map(name => ({ id: `o/${name}`, org: "o", name, ownerKind: "user" as const, head: null })) }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: "o/one" }).isPersisted.promise
  await settle()
  expect((await controller.commands.run("help")).status).toBe("executed")
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const card = [...store.collections.cards.values()].find(row => row.kind === "commands")!
  flushSync(() => root.render(<ControllerTestProvider controller={controller}>{renderCardBody(card, {
    presentation: "embedded", onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {},
    onRetryRun: () => {}, onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {},
    onRunCommand: () => { throw new Error("Help must not execute catalog entries") }
  })}</ControllerTestProvider>))
  const project = async (repo: string, names: string[]) => {
    await store.dispatch({ type: "repository-flows.loaded", actor: "system", repo, flows: names.map(id => ({
      id, description: `Description ${id}`, summary: null, featured: false, model: null, modelInvocable: true
    })) }).isPersisted.promise
    await settle()
  }
  return { store, controller, host, identity, project, dispose: async () => { flushSync(() => root.unmount()); host.remove(); await controller.dispose() } }
}

test("mounted help follows repository catalog replacement and removal without reopening", async () => {
  const view = await mount()
  try {
    await view.project("o/one", ["release-notes"])
    expect(view.controller.commands.viewerCatalog()?.some(row => row.name === "release-notes")).toBe(true)
    expect(view.host.textContent).toContain("/release-notes")
    await view.project("o/one", ["changelog"])
    expect(view.host.textContent).not.toContain("/release-notes")
    expect(view.host.textContent).toContain("/changelog")
    await view.project("o/one", [])
    expect(view.host.textContent).not.toContain("/changelog")
    expect([...view.store.collections.commandIntents.values()].some(row => ["release-notes", "changelog"].includes(row.name))).toBe(false)
  } finally { await view.dispose() }
})

test("mounted help drops rows on sign-out and account changes, then recovers", async () => {
  const view = await mount()
  try {
    expect(view.host.textContent).toContain("/help")
    await view.identity("signed-out", null)
    expect(view.controller.commands.viewerCatalog()).toBeUndefined()
    expect(view.host.textContent).toBe("")
    await view.identity("signed-in", "will")
    expect(view.host.textContent).toContain("/help")
    await view.identity("signed-in", "unknown-member")
    expect(view.controller.commands.viewerCatalog()).toBeUndefined()
    expect(view.host.textContent).toBe("")
  } finally { await view.dispose() }
})

test("mounted help follows the selected repository and ignores another repository's catalog", async () => {
  const view = await mount()
  const select = async (id: string) => {
    await view.store.dispatch({ type: "repo.selected", actor: "user", id }).isPersisted.promise
    await settle()
  }
  try {
    await select("o/two")
    await view.project("o/two", ["second-repo-flow"])
    expect(view.host.textContent).toContain("/second-repo-flow")
    await select("o/one")
    expect(view.host.textContent).not.toContain("/second-repo-flow")
    await view.project("o/one", ["first-repo-flow"])
    expect(view.host.textContent).toContain("/first-repo-flow")
    await view.project("o/two", ["updated-second-flow"])
    expect(view.host.textContent).toContain("/first-repo-flow")
    expect(view.host.textContent).not.toContain("/updated-second-flow")
    await select("o/two")
    expect(view.host.textContent).not.toContain("/first-repo-flow")
    expect(view.host.textContent).toContain("/updated-second-flow")
  } finally { await view.dispose() }
})
