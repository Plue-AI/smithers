import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import type { AppServices } from "./AppController"
import type { StartAgentTurnRequest,StartAgentTurnResult } from "@smthrs/rpc/NativeAgent"
import { describe,expect,test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, settled, silentAgent, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()
const cloud: AppBootstrap = { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity"], authFlow: "redirect", sandbox: null }
const question = "What can I do without signing in?"

const setup = async (options: { bootstrap?: AppBootstrap; services?: AppServices; journal?: boolean; state?: "signed-in" | "signed-out" | "unknown"; result?: () => Promise<StartAgentTurnResult> } = {}) => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  if (options.state !== "unknown") {
    const state = options.state ?? "signed-out"
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state, login: state === "signed-in" ? "will" : null, admin: false, scopesPlain: null }).isPersisted.promise
  }
  const requests: StartAgentTurnRequest[] = []
  const controller = createAppController(store, { ...silentAgent, available: true,
    ...(options.journal ? { journal: { subscribe: () => () => {}, read: async () => ({ status: "error" as const, code: "not-found" as const }), retire: async () => {}, disconnect: () => {} } } : {}),
    startTurn: async request => { requests.push(request); return options.result ? options.result() : { status: "started" } },
  }, { bootstrap: options.bootstrap ?? cloud, fetchImpl: async input => Response.json(
    String(input).endsWith("/api/public/repos") ? { repos: [{ name: "smithersai/smithers" }] } : {},
  ), ...options.services })
  return { storage, store, controller, requests }
}

describe("anonymous tutorial chat", () => {

  test("commands still execute while signed out", async () => {
    const { controller, store, requests } = await setup()
    controller.send("/help")
    await settled()
    expect(requests).toHaveLength(0)
    expect([...store.collections.messages.values()].some(message => message.action?.flow === "sign-in")).toBe(false)
    expect(store.session().draft).toBe("")
  })

  test("signed-in, local, and public catalog chat retain their existing backend path", async () => {
    for (const mode of ["signed-in", "local", "catalog", "no-identity"] as const) {
      const { store, controller, requests } = await setup({
        state: mode === "signed-in" ? "signed-in" : "signed-out",
        bootstrap: mode === "local" ? { ...cloud, host: "local" } : mode === "no-identity" ? { ...cloud, capabilities: ["agent"] } : cloud,
      })
      if (mode === "catalog") {
        await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "smithersai/smithers", org: "smithersai", ownerKind: "user", name: "smithers", head: null, catalog: true }] }).isPersisted.promise
        await store.dispatch({ type: "repo.selected", actor: "user", id: "smithersai/smithers" }).isPersisted.promise
      }
      controller.send(question)
      await settled()
      expect(requests).toHaveLength(1)
      expect(store.session().draft).toBe("")
    }
  })

  test.each([false, true])("a sign-in refusal while identity is loading preserves text (new draft: %s)", async newerDraft => {
    let refuse!: (result: StartAgentTurnResult) => void
    const pending = new Promise<StartAgentTurnResult>(resolve => { refuse = resolve })
    const { store, controller, requests } = await setup({ state: "unknown", result: () => pending })
    controller.send(question)
    if (newerDraft) await store.dispatch({ type: "composer.changed", actor: "user", draft: "My next thought" }).isPersisted.promise
    refuse({ status: "error", message: "Smithers web agent failed (HTTP 401): Sign in to run a Smithers turn.", refusal: { code: "sign_in_required", message: "Sign in to run a Smithers turn.", retryAt: null } })
    await settled()
    expect(requests).toHaveLength(1)
    expect(store.session().phase).toBe("idle")
    expect(store.session().draft).toBe(newerDraft ? "My next thought" : question)
    expect([...store.collections.messages.values()].some(message => message.status === "failed")).toBe(false)
    expect([...store.collections.messages.values()].some(message => message.action?.flow === "sign-in")).toBe(true)
  })
})

const backendServices = (mode: "owner" | "bearer" | "github"): AppServices => mode === "github" ? { bootstrap: cloud } : {
  bootstrap: { ...cloud, host: mode === "owner" ? "local" : "cloud", authFlow: mode === "owner" ? "credentials" : "redirect" },
  applicationTarget: resolveApplicationTarget({ apiVersion: 1, mode: mode === "owner" ? "web-selfhost" : "web-plue", apiOrigin: "", auth: { kind: mode === "owner" ? "session" : "bearer" }, cors: "same-origin", developerExternal: false }, "https://app.test"),
  applicationIdentity: { current: async () => null }
}

for (const mode of ["github", "bearer"] as const) {
  test(`${mode}: the signed-out chat gate names the selected sign-in door and retains the draft`, async () => {
    const { storage, store, controller, requests } = await setup({ services: backendServices(mode) })
    controller.send(question)
    await settled()
    expect(requests).toHaveLength(0)
    expect(store.session().draft).toBe(question)
    const prompt = [...store.collections.messages.values()].filter(message => message.action?.flow === "sign-in").at(-1)
    const label = mode === "github" ? "Sign in with GitHub" : "Sign in"
    expect(prompt).toMatchObject({ text: `${label} to send this message.`, action: { label } })
    await controller.dispose()
    const reopened = await createAppStore({ kind: "localStorage", storage })
    try {
      expect(reopened.session().draft).toBe(question)
      expect(reopened.collections.messages.get(prompt!.id)).toMatchObject({ text: `${label} to send this message.`, action: { label } })
      expect((await reopened.verifyState()).valid).toBe(true)
    } finally { await reopened.dispose?.() }
  })
}

for (const mode of ["owner", "bearer", "github"] as const) for (const journal of [false, true]) for (const newerDraft of [false, true]) {
  test(`${mode}, journal=${journal}: a delayed sign-in refusal uses its provider and preserves the ${newerDraft ? "newer" : "original"} draft`, async () => {
    let refuse!: (result: StartAgentTurnResult) => void
    const pending = new Promise<StartAgentTurnResult>(resolve => { refuse = resolve })
    const { store, controller, requests } = await setup({ services: backendServices(mode), journal, state: "unknown", result: () => pending })
    controller.send(question)
    await waitFor(() => requests.length === 1)
    if (newerDraft) await store.dispatch({ type: "composer.changed", actor: "user", draft: "My next thought" }).isPersisted.promise
    refuse({ status: "error", message: "Sign in to continue.", refusal: { code: "sign_in_required", message: "Sign in to continue.", retryAt: null } })
    await waitFor(() => [...store.collections.messages.values()].some(message => message.action?.flow === "sign-in"))
    const prompt = [...store.collections.messages.values()].filter(message => message.action?.flow === "sign-in").at(-1)
    const label = mode === "github" ? "Sign in with GitHub" : "Sign in"
    expect(prompt).toMatchObject({ text: `${label} to send this message.`, action: { label } })
    expect(store.session().phase).toBe("idle")
    expect(store.session().draft).toBe(newerDraft ? "My next thought" : question)
    expect([...store.collections.messages.values()].some(message => message.status === "failed")).toBe(false)
  })
}
