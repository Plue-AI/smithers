import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import type { AppServices } from "./AppController"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { describe,expect,test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, settled, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()
const cloud: AppBootstrap = { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity"], authFlow: "redirect", sandbox: null }
const question = "What can I do without signing in?"

const setup = async (options: { services?: AppServices } = {}) => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
  // Prompts no longer start browser turns (90ef5aaccb); any call here is a regression.
  const requests: StartAgentTurnRequest[] = []
  const controller = createAppController(store, { ...silentAgent, available: true,
    startTurn: async request => { requests.push(request); return { status: "started" } },
  }, { bootstrap: cloud, fetchImpl: async input => Response.json(
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
})

const backendServices = (mode: "owner" | "bearer" | "github"): AppServices => mode === "github" ? { bootstrap: cloud } : {
  bootstrap: { ...cloud, host: mode === "owner" ? "local" : "cloud", authFlow: mode === "owner" ? "credentials" : "redirect" },
  applicationTarget: resolveApplicationTarget({ apiVersion: 1, mode: mode === "owner" ? "web-selfhost" : "web-plue", apiOrigin: "", auth: { kind: mode === "owner" ? "session" : "bearer" }, cors: "same-origin", developerExternal: false }, "https://app.test"),
  applicationIdentity: { current: async () => null }
}

for (const mode of ["owner", "bearer", "github"] as const) for (const newerDraft of [false, true]) {
  test(`${mode}: the signed-out chat gate names the selected sign-in door and retains the ${newerDraft ? "newer" : "original"} draft`, async () => {
    const { storage, store, controller, requests } = await setup({ services: backendServices(mode) })
    const draft = newerDraft ? "My next thought" : question
    if (newerDraft) await store.dispatch({ type: "composer.changed", actor: "user", draft }).isPersisted.promise
    expect(await controller.send(question)).toBe(false)
    await settled()
    expect(requests).toHaveLength(0)
    expect(store.session().phase).toBe("idle")
    expect(store.session().draft).toBe(draft)
    const prompt = [...store.collections.messages.values()].filter(message => message.action?.flow === "sign-in").at(-1)
    const label = mode === "bearer" ? "Sign in" : "Sign in with GitHub"
    expect(prompt).toMatchObject({ text: `${label} to send this message.`, action: { label } })
    expect([...store.collections.messages.values()].some(message => message.status === "failed")).toBe(false)
    await controller.dispose()
    const reopened = await createAppStore({ kind: "localStorage", storage })
    try {
      expect(reopened.session().draft).toBe(draft)
      expect(reopened.collections.messages.get(prompt!.id)).toMatchObject({ text: `${label} to send this message.`, action: { label } })
      expect((await reopened.verifyState()).valid).toBe(true)
    } finally { await reopened.dispose?.() }
  })
}
