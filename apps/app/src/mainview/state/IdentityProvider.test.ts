import { CardSchema } from "@smthrs/rpc/Cards"
import { expect, test } from "bun:test"
import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import { createControllerContext } from "./controller/context"
import { createAppStore } from "./AppStore"
import type { AppServices } from "./AppController"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, scriptedToolAgent, settle } from "./TestFixtures"

const createAppController = scopedControllers()

const signedOut = { state: "signed-out" as const, login: null, admin: false }
const signedIn = { state: "signed-in" as const, login: "owner", admin: false }
const servicesFor = (mode: "owner" | "bearer" | "github"): AppServices => ({
  bootstrap: { apiVersion: 1, host: mode === "owner" ? "local" : "cloud", version: "test", buildSha: "test", capabilities: ["identity", "agent"], authFlow: mode === "owner" ? "credentials" : "redirect", sandbox: null },
  ...(mode === "github" ? {} : {
    applicationTarget: resolveApplicationTarget({ apiVersion: 1, mode: mode === "owner" ? "web-selfhost" : "web-plue", apiOrigin: "", auth: { kind: mode === "owner" ? "session" : "bearer" }, cors: "same-origin", developerExternal: false }, "https://owner.test"),
    applicationIdentity: { current: async () => null }
  }),
  fetchImpl: async () => Response.json({}, { status: 404 })
})

for (const mode of ["owner", "bearer", "github"] as const) {
  test(`${mode}: connector, completion receipt and agent context reflect the selected identity`, async () => {
    const storage = memoryStorage(), store = await createAppStore({ kind: "localStorage", storage })
    const { agent, requests } = scriptedToolAgent([() => [{ type: "done", reason: "stop" }]])
    const controller = createAppController(store, agent, servicesFor(mode))
    const provider = mode === "github" ? "github" : "local"
    try {
      await controller.adoptSession(signedOut)
      controller.promptSignIn()
      const prompt = [...store.collections.messages.values()].at(-1)!
      await settle()
      await controller.adoptSession(signedIn)
      expect(store.collections.identitySessions.get("identity")).toMatchObject({ provider })
      expect(store.collections.messages.get(prompt.id)?.answeredAction?.answer).toBe(`Signed in${provider === "github" ? " with GitHub" : ""} as @owner.`)
      await settle()
      controller.send("Describe the connected identity")
      await settle(80)
      expect(requests.length).toBeGreaterThan(0)
      expect(requests[0]?.context?.github).toMatchObject({ connected: provider === "github", login: provider === "github" ? "owner" : null, repositories: provider === "github" ? 0 : null })
      expect(requests[0]?.instructions).toContain(provider === "github" ? "GitHub is connected as owner" : "GitHub is NOT connected")
      await controller.signIn()
      expect(store.collections.toasts.get("toast-auth.sign-in.already")?.detail).toBe(provider === "github" ? "GitHub is connected." : "Signed in.")
      await controller.dispose()
      const reopened = await createAppStore({ kind: "localStorage", storage })
      try {
        expect((await reopened.verifyState()).valid).toBe(true)
        expect(reopened.collections.messages.get(prompt.id)?.answeredAction?.answer).toBe(`Signed in${provider === "github" ? " with GitHub" : ""} as @owner.`)
      } finally { await reopened.dispose?.() }
    } finally { await controller.dispose(); await store.dispose?.() }
  })
}

test("restored sign-in prompts use the observed local provider without rewriting their archive", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const { agent } = scriptedToolAgent([() => [{ type: "done", reason: "stop" }]])
  const controller = createAppController(store, agent, servicesFor("owner"))
  try {
    await controller.adoptSession(signedOut)
    controller.promptSignIn()
    await settle()
    const prompt = [...store.collections.messages.values()].at(-1)!
    const { activeBranchId: branchId, activeFrameId: frameId, activeWorkspaceId: workspaceId } = store.session()
    await store.dispatch({ type: "conversation.cleared", actor: "user", branchId: "after-local-prompt", notes: [] }).isPersisted.promise
    const archive = store.collections.branches.get(branchId!)!.snapshot!
    await controller.adoptSession(signedIn)
    await store.dispatch({ type: "frame.navigated", actor: "user", workspaceId: workspaceId!, branchId: branchId!, frameId: frameId! }).isPersisted.promise
    expect(store.collections.messages.get(prompt.id)?.answeredAction?.answer).toBe("Signed in as @owner.")
    expect(store.collections.branches.get(branchId!)!.snapshot).toEqual(archive)
    expect((await store.verifyState()).valid).toBe(true)
  } finally { await controller.dispose(); await store.dispose?.() }
})

test("the same login on another provider clears private state and advances the account fence", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const { agent } = scriptedToolAgent([() => [{ type: "done", reason: "stop" }]])
  const ctx = createControllerContext(store, agent, {})
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", ...signedIn, scopesPlain: null, provider: "github" }).isPersisted.promise
    await store.dispatch({ type: "message.appended", actor: "system", text: "Private GitHub account data" }).isPersisted.promise
    const epoch = ctx.accountEpoch, ownerRevision = store.collections.identitySessions.get("identity")!.ownerRevision!
    await store.dispatch({ type: "identity.session.loaded", actor: "system", ...signedIn, scopesPlain: null, provider: "local" }).isPersisted.promise
    expect(ctx.accountEpoch).toBeGreaterThan(epoch)
    expect(store.collections.identitySessions.get("identity")!.ownerRevision).toBeGreaterThan(ownerRevision)
    expect([...store.collections.messages.values()].some(row => row.text.includes("Private GitHub"))).toBe(false)
    const settled = ctx.accountEpoch
    await store.dispatch({ type: "identity.session.loaded", actor: "system", ...signedOut, state: "unavailable", scopesPlain: null, provider: "github" }).isPersisted.promise
    expect(store.collections.identitySessions.get("identity")?.provider).toBe("local")
    expect(ctx.accountEpoch).toBe(settled)
    expect((await store.verifyState()).valid).toBe(true)
  } finally { await ctx.dispose(); await store.dispose?.() }
})

test("a legacy connector retires on read and never supplies an identity claim", async () => {
  const storage = memoryStorage(), store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "card.upsert", actor: "system", card: CardSchema.parse({ id: "legacy-connect", kind: "connect", title: "Connect", status: "active", createdAt: 1, ordinal: 1,
    payload: { github: { connected: false, login: null }, nativeAvailable: false } }) }).isPersisted.promise
  await store.dispatch({ type: "identity.session.loaded", actor: "system", ...signedIn, scopesPlain: null }).isPersisted.promise
  const hash = (await store.verifyState()).actualHash
  await store.dispose?.()
  const reopened = await createAppStore({ kind: "localStorage", storage })
  try {
    expect((await reopened.verifyState()).valid).toBe(true)
    expect((await reopened.verifyState()).actualHash).toBe(hash)
    expect(reopened.collections.cards.get("legacy-connect")).toMatchObject({ kind: "retired", title: "", status: "acted", payload: {} })
    await reopened.dispatch({ type: "identity.session.loaded", actor: "system", ...signedIn, scopesPlain: null, provider: "local" }).isPersisted.promise
    expect(reopened.collections.cards.get("legacy-connect")).toMatchObject({ kind: "retired", payload: {} })
    expect((await reopened.verifyState()).valid).toBe(true)
  } finally { await reopened.dispose?.() }
})
