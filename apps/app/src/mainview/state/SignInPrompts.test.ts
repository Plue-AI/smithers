import { expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, settle, unavailableAgent } from "./TestFixtures"
import { createControllerContext } from "./controller/context"
import { createFailureController } from "./controller/failures"

const createAppController = scopedControllers()
const WEB: AppBootstrap = { apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false }),
  authFlow: "redirect", sandbox: null }
const signedIn = { state: "signed-in" as const, login: "codeplanesmithers", allowlisted: true, admin: false }
const signedOut = { state: "signed-out" as const, login: null, allowlisted: false, admin: false }

const setup = async (web = true, storage = memoryStorage(), initiallySignedIn = false) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  let identity = initiallySignedIn
  let cloud: "signed-out" | "signed-in" | "degraded" | "offline" = "signed-out"
  const controller = createAppController(store, unavailableAgent, {
    ...(web ? { bootstrap: WEB } : {}),
    fetchImpl: async input => {
      const path = new URL(String(input), "https://app.test").pathname
      if (path === "/api/auth/session") return Response.json(identity ? signedIn : signedOut)
      if (path === "/api/cloud-auth/session") return cloud === "offline" ? new Response(null, { status: 503 })
        : Response.json({ state: cloud === "degraded" ? "signed-in" : cloud,
          username: cloud === "signed-out" ? null : "codeplanesmithers", expiresAt: null,
          ...(cloud === "degraded" ? { scopes: "degraded" } : {}) })
      return Response.json({}, { status: 404 })
    }
  })
  await controller.adoptSession(initiallySignedIn ? signedIn : signedOut)
  return { controller, store, storage,
    signIn: async () => { identity = true; await controller.loadSession(); await settle() },
    cloud: async (state: typeof cloud) => { cloud = state; await controller.loadCloudSession(); await settle() } }
}

const producers = ["identity", "required identity", "OAuth retry", "chat gate", "requirement"] as const
for (const producer of producers) {
  test(`${producer}: sign-in answers the same prompt without deleting its history`, async () => {
    const h = await setup()
    if (producer === "identity") await h.controller.commands.runForAgent("auth.prompt")
    else if (producer === "required identity") h.controller.promptSignIn(true, { summary: "Read issues" })
    else if (producer === "OAuth retry") h.controller.handleAuthReturn("?auth=failed")
    else if (producer === "chat gate") h.controller.send("Keep this draft")
    else if (producer === "requirement") await h.controller.commands.run("secrets.list", "smithersai/smithers")
    await settle()
    const prompt = [...h.store.collections.messages.values()].find(row => row.action?.flow === "auth.sign-in")
    expect(prompt).toBeDefined()
    // The transcript prompt owns sign-in; parking a command adds no duplicate toast.
    expect(h.store.collections.toasts.get("toast-command.requirement")).toBeUndefined()
    if (producer === "requirement") expect(h.store.session().pendingCommand).toMatchObject({
      name: "secrets.list", args: "smithersai/smithers", requirement: "signed-in"
    })
    await h.signIn()
    const answered = h.store.collections.messages.get(prompt!.id)
    expect(answered?.action).toBeUndefined()
    expect(answered).toMatchObject({ id: prompt!.id, text: prompt!.text, ordinal: prompt!.ordinal, createdAt: prompt!.createdAt,
      answeredAction: { flow: "auth.sign-in", answer: "Signed in with GitHub as @codeplanesmithers." } })
    expect(h.store.collections.toasts.get("toast-command.requirement")).toBeUndefined()
    if (producer === "requirement") {
      // Continuing the parked act has its own observation; the original prompt keeps its answer.
      expect(h.store.collections.toasts.get("toast-command.resume.secrets.list")).toBeDefined()
    }
    if (producer === "chat gate") expect(h.store.session().draft).toBe("Keep this draft")
    // A later outage never reopens a completed step (explicit account removal
    // has its own existing privacy policy, which clears the transcript).
    await h.controller.adoptSession({ ...signedOut, state: "unavailable" })
    expect(h.store.collections.messages.get(prompt!.id)).toEqual(answered)
  })
}

for (const web of [true, false]) {
  test(`${web ? "web" : "native"} Cloud prompt waits for usable Cloud access, independently of identity`, async () => {
    const h = await setup(web)
    await h.controller.commands.runForAgent("cloud.prompt")
    const prompt = [...h.store.collections.messages.values()].at(-1)!
    expect(prompt.action?.flow).toBe(web ? "auth.sign-in" : "cloud.sign-in")
    await h.signIn()
    expect(h.store.collections.messages.get(prompt.id)?.action).toBeDefined()
    await h.cloud("degraded")
    expect(h.store.collections.messages.get(prompt.id)?.action).toBeDefined()
    await h.cloud("offline")
    expect(h.store.collections.messages.get(prompt.id)?.action).toBeDefined()
    await h.cloud("signed-in")
    expect(h.store.collections.messages.get(prompt.id)).toMatchObject({ text: prompt.text,
      answeredAction: { answer: "Signed in to Smithers Cloud as @codeplanesmithers." } })
    expect(h.store.collections.messages.get(prompt.id)?.action).toBeUndefined()
  })
}

for (const flow of ["auth.sign-in", "cloud.sign-in"] as const) {
  test(`failure toast with ${flow} answers without claiming the failed command succeeded`, async () => {
    const h = await setup(false)
    const ctx = createControllerContext(h.store, unavailableAgent, {})
    ctx.commands = h.controller.commands
    try {
      createFailureController(ctx).surfaceCommandFailure("test.read", { status: "failed", error: `Sign in first — /${flow}.` })
      const before = h.store.collections.toasts.get("toast-command.failed.test.read")!
      expect(before.action?.flow).toBe(flow)
      if (flow === "auth.sign-in") await h.signIn()
      else await h.cloud("signed-in")
      const after = h.store.collections.toasts.get(before.id)!
      expect(after.action).toBeUndefined()
      expect(after.answeredAction?.answer).toContain("@codeplanesmithers")
      expect(after.status).toBe("failed")
      expect(after.detail).toBe(before.detail)
    } finally { await ctx.dispose() }
  })
}

test("an OAuth reload answers legacy persisted prompts; the answer survives the next reload", async () => {
  const h = await setup()
  h.controller.promptSignIn()
  const prompt = [...h.store.collections.messages.values()].at(-1)!
  // This producer has the old action shape: no requirement or completion metadata.
  expect(prompt.action).toEqual({ flow: "auth.sign-in", label: "Sign in with GitHub" })
  await h.store.settled?.()
  await h.controller.dispose()
  await settle()
  await h.store.settled?.()
  const restored = await setup(true, h.storage)
  expect(restored.store.collections.messages.get(prompt.id)?.action).toBeDefined()
  await restored.signIn()
  const answered = restored.store.collections.messages.get(prompt.id)!
  expect(answered.action).toBeUndefined()
  expect(answered.answeredAction?.answer).toContain("@codeplanesmithers")
  await restored.store.settled?.()
  await restored.controller.dispose()
  await settle()
  await restored.store.settled?.()
  const again = await setup(true, h.storage, true)
  expect(again.store.collections.messages.get(prompt.id)).toEqual(answered)
})

test("an owner backend names its credential door without promising GitHub", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, {
    applicationTarget: resolveApplicationTarget({
      apiVersion: 1,
      mode: "web-selfhost",
      apiOrigin: "",
      auth: { kind: "session" },
      cors: "same-origin",
      developerExternal: false
    }, "https://owner.test"),
    localIdentity: {
      status: async () => ({ enabled: true, initialized: true }),
      login: async ({ username }) => ({ user: { id: 1, username } }),
      bootstrap: async ({ username }) => ({ user: { id: 1, username } })
    }
  })
  await controller.adoptSession(signedOut)

  controller.promptSignIn()

  expect([...store.collections.messages.values()].at(-1)).toMatchObject({
    text: "Sign in to continue.",
    action: { flow: "auth.sign-in", label: "Sign in" }
  })
})

test("the hosted cloud GitHub door bypasses owner-local auth and uses the cloud OAuth route", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const assigned: string[] = []
  let localStatusReads = 0
  let applicationIdentityReads = 0
  const globals = globalThis as unknown as { window?: unknown }
  const hadWindow = "window" in globals
  const previousWindow = globals.window
  globals.window = {
    location: {
      pathname: "/",
      search: "",
      assign: (url: string) => void assigned.push(url)
    }
  }
  const controller = createAppController(store, unavailableAgent, {
    bootstrap: WEB,
    applicationTarget: resolveApplicationTarget({
      apiVersion: 1,
      mode: "web-selfhost",
      apiOrigin: "",
      auth: { kind: "session" },
      cors: "same-origin",
      developerExternal: false
    }, "https://smithers.sh"),
    localIdentity: {
      status: async () => { localStatusReads += 1; return { enabled: true, initialized: true } },
      login: async ({ username }) => ({ user: { id: 1, username } }),
      bootstrap: async ({ username }) => ({ user: { id: 1, username } })
    },
    applicationIdentity: {
      current: async () => { applicationIdentityReads += 1; return null }
    }
  })
  try {
    await controller.adoptSession(signedOut)
    await controller.commands.run("auth.sign-in")
    await settle()

    expect(assigned).toEqual(["/api/auth/github/start"])
    expect(localStatusReads).toBe(0)
    expect(applicationIdentityReads).toBe(0)
  } finally {
    await controller.dispose()
    if (hadWindow) globals.window = previousWindow
    else delete globals.window
  }
})

test("a Plue bearer target reads its selected identity on a cloud host", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requested: string[] = []
  let selectedReads = 0
  const controller = createAppController(store, unavailableAgent, {
    bootstrap: WEB,
    applicationTarget: resolveApplicationTarget({
      apiVersion: 1, mode: "web-plue", apiOrigin: "", auth: { kind: "bearer" },
      cors: "same-origin", developerExternal: false
    }, "https://smithers.sh"),
    applicationIdentity: {
      current: async () => {
        selectedReads += 1
        return { username: "smithers-canary", admin: true, scopes: null }
      }
    },
    fetchImpl: async input => {
      requested.push(new URL(String(input), "https://smithers.sh").pathname)
      return Response.json({}, { status: 404 })
    }
  })
  await controller.loadSession()
  expect(selectedReads).toBe(1)
  expect(requested).not.toContain("/api/auth/session")
  expect(store.collections.identitySessions.get("identity")).toMatchObject({
    state: "signed-in", login: "smithers-canary"
  })
})

test("a refused Cloud seam on web still offers reauthentication when GitHub is already connected", async () => {
  const h = await setup()
  await h.signIn()
  await h.controller.commands.run("box.list")
  const prompt = [...h.store.collections.messages.values()].find(row => row.action?.flow === "auth.sign-in")
  expect(prompt).toBeDefined()
  await h.cloud("signed-in")
  expect(h.store.collections.messages.get(prompt!.id)?.action).toBeUndefined()
  expect(h.store.collections.messages.get(prompt!.id)?.answeredAction?.answer).toContain("Smithers Cloud")
})

test("the onboarding connector card answers its persisted GitHub sign-in door", async () => {
  const h = await setup()
  await h.controller.commands.runForAgent("connect")
  const before = h.store.collections.cards.get("connect-embedded")!
  expect(before).toMatchObject({ kind: "connect", payload: { github: { connected: false } } })
  await h.signIn()
  expect(h.store.collections.cards.get(before.id)).toMatchObject({ id: before.id, ordinal: before.ordinal,
    payload: { github: { connected: true, login: "codeplanesmithers" } } })
})

test("unavailable identity and unrelated fulfilled requirements cannot answer a sign-in prompt", async () => {
  const h = await setup(false)
  h.controller.promptSignIn()
  const prompt = [...h.store.collections.messages.values()].at(-1)!
  await h.store.dispatch({ type: "message.appended", actor: "system", text: "Request access to this repository.",
    action: { flow: "auth.request-access", label: "Request access" } }).isPersisted.promise
  const access = [...h.store.collections.messages.values()].at(-1)!
  await h.controller.adoptSession({ ...signedOut, state: "unavailable" })
  await h.cloud("signed-in")
  expect(h.store.collections.messages.get(prompt.id)?.action).toEqual(prompt.action)
  await h.controller.adoptSession({ ...signedIn, allowlisted: false })
  expect(h.store.collections.messages.get(prompt.id)?.action).toBeUndefined()
  expect(h.store.collections.messages.get(access.id)?.action).toEqual(access.action)
})

test("all outstanding steps answer even when the pending command has been superseded", async () => {
  const h = await setup()
  h.controller.deferCommand("secrets.list", "smithersai/smithers", "signed-in")
  h.controller.promptSignIn(true)
  h.controller.promptSignIn(true, { summary: "Read issues" })
  // Deferral and transcript have distinct lifetimes: cancelling a parked act
  // cannot leave its sign-in buttons behind after the account is connected.
  await h.store.dispatch({ type: "command.deferral.cleared", actor: "system" }).isPersisted.promise
  const before = [...h.store.collections.messages.values()]
  await h.signIn()
  expect([...h.store.collections.messages.values()].map(row => row.id)).toEqual(before.map(row => row.id))
  for (const prompt of before) {
    expect(h.store.collections.messages.get(prompt.id)?.action).toBeUndefined()
    expect(h.store.collections.messages.get(prompt.id)?.answeredAction?.answer).toContain("@codeplanesmithers")
  }
  expect(h.store.collections.toasts.get("toast-command.requirement")).toBeUndefined()
  expect(h.store.collections.toasts.get("toast-command.resume.secrets.list")).toBeUndefined()
})

test("Cloud sign-out does not reopen an answered historical Cloud step", async () => {
  const h = await setup(false)
  h.controller.promptCloudSignIn()
  const prompt = [...h.store.collections.messages.values()].at(-1)!
  await h.cloud("signed-in")
  const answered = h.store.collections.messages.get(prompt.id)!
  expect(answered.action).toBeUndefined()
  await h.cloud("signed-out")
  expect(h.store.collections.messages.get(prompt.id)).toEqual(answered)
})

test("reopening a conversation answers its old prompt from a later observed session without rewriting the archive", async () => {
  const h = await setup()
  h.controller.promptSignIn()
  const prompt = [...h.store.collections.messages.values()].at(-1)!
  const branchId = h.store.session().activeBranchId!
  const frameId = h.store.session().activeFrameId!
  const workspaceId = h.store.session().activeWorkspaceId!
  await h.store.dispatch({ type: "conversation.cleared", actor: "user", branchId: "after-sign-in-prompt", notes: [] }).isPersisted.promise
  const archive = h.store.collections.branches.get(branchId)!.snapshot!
  expect(archive.messages.find(row => row.id === prompt.id)?.action).toBeDefined()
  await h.signIn()
  await h.store.dispatch({ type: "frame.navigated", actor: "user", workspaceId, branchId, frameId }).isPersisted.promise
  expect(h.store.collections.messages.get(prompt.id)?.action).toBeUndefined()
  expect(h.store.collections.messages.get(prompt.id)?.answeredAction?.answer).toContain("@codeplanesmithers")
  expect(h.store.collections.branches.get(branchId)?.snapshot).toEqual(archive)
})

test("requesting access after a reauthentication prompt is not a new sign-in observation", async () => {
  const h = await setup()
  await h.signIn()
  h.controller.promptSignIn(true)
  const prompt = [...h.store.collections.messages.values()].at(-1)!
  const branchId = h.store.session().activeBranchId!
  const frameId = h.store.session().activeFrameId!
  const workspaceId = h.store.session().activeWorkspaceId!
  await h.store.dispatch({ type: "conversation.cleared", actor: "user", branchId: "after-reauth-prompt", notes: [] }).isPersisted.promise
  await h.store.dispatch({ type: "identity.access.requested", actor: "user" }).isPersisted.promise
  await h.store.dispatch({ type: "frame.navigated", actor: "user", workspaceId, branchId, frameId }).isPersisted.promise
  expect(h.store.collections.messages.get(prompt.id)?.action).toEqual(prompt.action)
  await h.signIn()
  expect(h.store.collections.messages.get(prompt.id)?.action).toBeUndefined()
})
