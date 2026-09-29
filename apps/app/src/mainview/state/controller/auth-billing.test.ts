import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"

import type { AgentPort } from "../../runtime/AgentPort"
import { createAppStore } from "../AppStore"
import { createAuthBillingController } from "./auth-billing"
import { createControllerContext } from "./context"
import { createFailureController } from "./failures"
import { settle, waitFor } from "../TestFixtures"
import { ADMIN_ALLOWLIST_PATH, ADMIN_GRANT_PATH, ADMIN_HEALTH_PATH, ADMIN_REQUESTS_PATH, IDENTITY_REQUEST_ACCESS_PATH } from "@smthrs/rpc/AgentApiRoutes"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}


const agent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", code: "native-required", message: "native unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const signedIn = {
  state: "signed-in" as const,
  login: "will",
  allowlisted: true,
  admin: false
}

for (const balance of [false, true]) for (const checkout of [false, true]) for (const failure of [false, true]) {
  test(`balance support ${balance}, checkout ${checkout}, upstream failure ${failure}: automatic reads honor the balance route`, async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let reads = 0
    const ctx = createControllerContext(store, agent, {
      bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", authFlow: "credentials", sandbox: null,
        capabilities: ["identity", ...(balance ? ["billing.balance" as const] : []), ...(checkout ? ["billing.checkout" as const] : [])] },
      toastDebounceMs: 0,
      fetchImpl: async input => {
        if (String(input).endsWith("/api/billing/balance")) reads += 1
        return failure ? new Response(null, { status: 503 }) : Response.json({ state: "ok", allowedToStartWork: true,
          balance: { totalUsd: "25", lifetimeChargedUsd: "0", chargeCount: 0 } })
      }
    })
    ctx.withToast = createFailureController(ctx).withToast
    const controller = createAuthBillingController(ctx, store.nextOrdinal)
    try {
      await controller.adoptSession(signedIn)
      await settle()
      expect(reads).toBe(balance ? 1 : 0)
      controller.settleTurnBilling()
      await controller.refreshBalance()
      if (balance && failure) await waitFor(() => [...store.collections.toasts.values()].some(row => row.status === "failed"))
      else if (balance) expect(store.collections.billingAccounts.get("billing")?.totalUsd).toBe("25")
      else expect(store.collections.toasts.size).toBe(0)
      const result = await controller.showBalance()
      if (!balance) {
        expect(reads).toBe(0)
        expect(store.collections.cards.has("billing-balance")).toBe(false)
        expect(store.collections.toasts.size).toBe(0)
      } else if (failure) {
        expect(typeof result).toBe("string")
        expect(store.collections.cards.has("billing-balance")).toBe(false)
      } else expect(result).toMatchObject({ value: expect.stringContaining("$25") })
    } finally { await ctx.dispose(); await store.dispose?.() }
  })
}

const runSignedInEntry = async (entry: "load" | "adopt", sessionAnswer: Record<string, unknown> = signedIn) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const calls: string[] = []
  const ctx = createControllerContext(store, agent, {
    fetchImpl: async () => {
      const body = {
          state: "ok",
          allowedToStartWork: true,
          balance: { totalUsd: "500", lifetimeChargedUsd: "0", chargeCount: 0 }
        }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }
  })
  ctx.identityChanged = () => calls.push("identityChanged")
  ctx.resumeWorkflowRuns = () => calls.push("resumeWorkflowRuns")
  ctx.resumeDeferredCommand = () => calls.push("resumeDeferredCommand")
  ctx.withToast = async <T>(
    key: string,
    _title: string,
    _doneTitle: string,
    work: () => Promise<T | string>
  ): Promise<T | string> => {
    if (key === "billing.balance.refresh") calls.push("refreshBalance")
    return work()
  }

  const controller = createAuthBillingController(ctx, () => 0, {
    current: async () => ({ username: String(sessionAnswer.login), admin: sessionAnswer.admin === true, scopes: null }),
    signInPath: "/api/auth/github"
  })
  if (entry === "load") await controller.loadSession()
  else await controller.adoptSession(signedIn)
  await new Promise((resolve) => setTimeout(resolve, 0))

  return {
    calls,
    transitions: [...store.collections.transitions.values()].map(({ actor, type, payload }) => ({
      actor,
      type,
      payload: JSON.parse(payload) as unknown
    }))
  }
}

describe("signed-in session adoption", () => {
  test("a selected backend identity supplies its own admin authority", async () => {
    const publicSession = await runSignedInEntry("load", { login: "new-user", admin: true })
    expect(publicSession.transitions[0]?.payload).toMatchObject({ login: "new-user", allowlisted: true, admin: true })
    expect(publicSession.calls).toContain("resumeWorkflowRuns")
  })
  test("live and server-resolved sessions share every transition and follow-on call", async () => {
    const live = await runSignedInEntry("load")
    const adopted = await runSignedInEntry("adopt")

    expect(adopted.transitions).toEqual(live.transitions)
    expect(live.transitions.map(({ type }) => type)).toEqual([
      "identity.session.loaded", "cloud.session.loaded", "billing.refreshed"
    ])
    expect(live.transitions).toContainEqual({
        actor: "system",
        type: "identity.session.loaded",
        payload: { ...signedIn, scopesPlain: null, provider: "github" }
      })
    expect(live.transitions).toContainEqual({
        actor: "system", type: "cloud.session.loaded",
        payload: { state: "signed-in", username: "will", expiresAt: null, scopes: null }
      })
    expect(live.transitions).toContainEqual({
        actor: "system",
        type: "billing.refreshed",
        payload: {
          state: "ok",
          totalUsd: "500",
          allowedToStartWork: true,
          lifetimeChargedUsd: "0",
          chargeCount: 0
        }
      })
    expect(adopted.calls).toEqual(live.calls)
    expect(live.calls).toEqual([
      "identityChanged",
      "refreshBalance",
      "resumeWorkflowRuns",
      "resumeDeferredCommand"
    ])
  })
})

/*
 * The sign-in return path. From a repository page (`/owner/name`) the
 * sign-in door names that page as `return_to`; from the landing page it
 * names nothing. Coming back, `?signed-in=github` on either page counts as
 * handled (so the boot strips it) without a chat message: the session probe
 * already says who signed in.
 */
describe("sign-in return path", () => {
  interface WindowStub {
    location: { pathname: string; search: string; assign: (url: string) => void }
  }
  const withWindow = async (pathname: string, search: string, run: (assigned: string[]) => Promise<void>) => {
    const assigned: string[] = []
    const stub: WindowStub = { location: { pathname, search, assign: (url) => void assigned.push(url) } }
    const globals = globalThis as unknown as { window?: unknown }
    const had = "window" in globals
    const previous = globals.window
    globals.window = stub
    try {
      await run(assigned)
    } finally {
      if (had) globals.window = previous
      else delete globals.window
    }
  }

  const signedOutController = async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const ctx = createControllerContext(store, agent, {
      fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    })
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-out",
      login: null,
      allowlisted: false,
      admin: false,
      scopesPlain: null
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { store, controller: createAuthBillingController(ctx, () => 0) }
  }

  test("from a repository page the sign-in door names that page as return_to", async () => {
    const { controller } = await signedOutController()
    await withWindow("/smithersai/smithers", "?tab=issues", async (assigned) => {
      controller.signIn()
      // The redirect waits for the durable queue first (DurableCollection.settled), so it lands a tick later.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(assigned).toEqual(["/api/auth/github/start?return_to=%2Fsmithersai%2Fsmithers%3Ftab%3Dissues"])
    })
  })

  test("from the landing page the sign-in door carries no return path", async () => {
    const { controller } = await signedOutController()
    await withWindow("/", "?repo=smithersai/smithers", async (assigned) => {
      controller.signIn()
      // The redirect waits for the durable queue first (DurableCollection.settled), so it lands a tick later.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(assigned).toEqual(["/api/auth/github/start"])
    })
  })

  test("a selected Go backend uses its GitHub start route", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const ctx = createControllerContext(store, agent, {
      fetchImpl: async () => Response.json({})
    })
    const controller = createAuthBillingController(ctx, () => 0, {
      current: async () => null,
      signInPath: "/api/auth/github"
    })
    await controller.loadSession()
    await withWindow("/", "", async (assigned) => {
      controller.signIn()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(assigned).toEqual(["/api/auth/github"])
    })
  })

  test("the signed-in marker is handled silently; a failed return still speaks", async () => {
    const { store, controller } = await signedOutController()
    const messages = () => [...store.collections.messages.values()].length
    const before = messages()
    expect(controller.handleAuthReturn("?signed-in=github")).toBe(true)
    expect(messages()).toBe(before)
    expect(controller.handleAuthReturn("?tab=issues")).toBe(false)
    expect(controller.handleAuthReturn("?auth=failed")).toBe(true)
    expect(messages()).toBe(before + 1)
  })
})

test("selected backend identity also supplies the Cloud capability session", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requested: string[] = []
  const ctx = createControllerContext(store, agent, {
    fetchImpl: async (input) => {
      requested.push(String(input))
      return Response.json({
        state: "ok",
        allowedToStartWork: true,
        balance: { totalUsd: "0", lifetimeChargedUsd: "0", chargeCount: 0 }
      })
    }
  })
  ctx.withToast = async (_key, _title, _done, work) => work()
  const settled: string[] = []
  const controller = createAuthBillingController(ctx, () => 0, {
    current: async () => ({ username: "owner", admin: true, scopes: "degraded" }),
    signInPath: "/api/auth/github",
    settled: () => settled.push("settled")
  })

  await controller.loadSession()

  expect(store.collections.identitySessions.get("identity")).toMatchObject({
    state: "signed-in",
    login: "owner",
    allowlisted: true,
    admin: true
  })
  expect(store.collections.cloudSessions.get("cloud")).toMatchObject({
    state: "signed-in",
    username: "owner",
    scopes: "degraded"
  })
  expect(settled).toEqual(["settled"])
  expect(requested.some((url) => url.includes("/api/user") || url.includes("/api/cloud-auth/session"))).toBe(false)
})

describe("native sign-in handoff ownership", () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => { resolve = done })
    return { promise, resolve }
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  const json = (body: unknown) => Response.json(body)
  const setup = async (pause: "start" | "wait" | "claim" | "session" | "reopen" | "start-body" | "claim-body" | "session-body") => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const reached = deferred<void>()
    const response = deferred<Response>()
    const reopened = deferred<boolean>()
    const opened: string[] = []
    const requests: string[] = []
    let requestSignal: AbortSignal | null | undefined
    const ctx = createControllerContext(store, agent, {
      baseUrl: "https://app.test",
      handoffPollMs: pause === "wait" || pause === "reopen" ? 30 : 1,
      openExternal: async (url) => {
        opened.push(url)
        if (pause === "wait") reached.resolve()
        if (pause === "reopen" && opened.length === 2) {
          reached.resolve()
          return reopened.promise
        }
        return true
      },
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname
        requests.push(path)
        const stage = pause.replace("-body", "")
        if (path.endsWith(`/auth/native/${stage}`)) {
          requestSignal = init?.signal
          // Deliberately ignore abort: late answers still need continuation fences.
          // boundedFetch buffers the body at the seam, so a stalled body is a
          // stream that withholds its chunk, not a slow `json()` on the Response.
          if (pause.endsWith("-body")) {
            return new Response(
              new ReadableStream<Uint8Array>({
                async pull(stream) {
                  reached.resolve()
                  const late = await response.promise
                  try {
                    stream.enqueue(new TextEncoder().encode(await late.text()))
                    stream.close()
                  } catch {
                    // The seam cancelled the reader first; the late answer is fenced.
                  }
                }
              }),
              { headers: { "content-type": "application/json" } }
            )
          }
          reached.resolve()
          return response.promise
        }
        if (path.endsWith("/start")) return json({ handoffId: "handoff-1", pollSecret: "secret-1" })
        if (path.endsWith("/claim")) return json({ status: pause.startsWith("session") ? "ready" : "failed" })
        return json(signedIn)
      }
    })
    ctx.withToast = async (_key, _title, _doneTitle, work) => work()
    ctx.resolveToast = (key, outcome) => {
      store.dispatch({ type: "toast.resolved", actor: "system", key, ...outcome })
    }
    store.dispatch({ type: "identity.session.loaded", actor: "system", ...signedIn,
      state: "signed-out", login: null, scopesPlain: null })
    const controller = createAuthBillingController(ctx, () => 0, {
      current: async signal => {
        requests.push("/api/user")
        requestSignal = signal
        if (!pause.startsWith("session")) return { username: "will", admin: false, scopes: null }
        reached.resolve()
        const aborted = new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
        })
        const answer = await Promise.race([response.promise, aborted])
        const body = await answer.json() as { status?: string; username?: string; login?: string; admin?: boolean }
        return body.status === "signed-out" ? null : { username: body.username ?? body.login ?? "will", admin: body.admin === true, scopes: null }
      },
      signInPath: "/api/auth/github"
    })
    const transitions = () => [...store.collections.transitions.values()]
    return { ctx, controller, store, reached, response, reopened, opened, requests, transitions,
      signal: () => requestSignal }
  }

  test("a second click before start answers prepares sign-in without opening an empty URL", async () => {
    const h = await setup("start")
    try {
      h.controller.signIn()
      await h.reached.promise
      h.controller.signIn()
      await tick()
      expect(h.opened).toEqual([])
      expect(h.requests).toEqual(["/api/auth/native/start"])
      const notice = h.store.collections.toasts.get("toast-auth.sign-in.handoff.reopened")
      expect(notice?.title).toBe("Preparing sign-in…")
      expect(notice?.detail).toBe("Sign-in is being prepared — your browser will open when it's ready.")
      expect(notice?.status).toBe("ok")
    } finally {
      await h.ctx.dispose()
      h.response.resolve(json({ handoffId: "handoff-1", pollSecret: "secret-1" }))
      await tick()
    }
  })

  test("disposal during the wait prevents any later claim or dispatch", async () => {
    const h = await setup("wait")
    h.controller.signIn()
    await h.reached.promise
    await tick()
    await h.ctx.dispose()
    const before = h.transitions()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.requests).toEqual(["/api/auth/native/start"])
    expect(h.transitions()).toEqual(before)
  })

  for (const pause of ["start", "claim", "session", "start-body", "claim-body", "session-body"] as const) {
    test(`disposal aborts the ${pause} request and fences its late answer`, async () => {
      const h = await setup(pause)
      h.controller.signIn()
      await h.reached.promise
      // Captured before disposal: an answer that lands *during* dispose is as
      // much a fenced late answer as one that lands after it.
      const before = h.transitions()
      const requestsBefore = [...h.requests]
      await h.ctx.dispose()
      h.response.resolve(json(pause.startsWith("start")
        ? { handoffId: "handoff-1", pollSecret: "secret-1" }
        : pause.startsWith("claim") ? { status: "ready" } : signedIn))
      await tick()
      await tick()
      expect(h.signal()?.aborted).toBe(true)
      expect(h.requests).toEqual(requestsBefore)
      expect(h.transitions()).toEqual(before)
      if (pause.startsWith("start")) expect(h.opened).toEqual([])
    })
  }

  test("a reopen finishing after disposal cannot dispatch its notice", async () => {
    const h = await setup("reopen")
    h.controller.signIn()
    while (h.opened.length === 0) await tick()
    h.controller.signIn()
    await h.reached.promise
    await h.ctx.dispose()
    const before = h.transitions()
    h.reopened.resolve(true)
    await tick()
    expect(h.transitions()).toEqual(before)
  })

  test.each([
    { name: "refused", response: new Response("no", { status: 503 }), detail: "Sign-in couldn't start. Try again. (no)" },
    { name: "malformed", response: json({ handoffId: 5, pollSecret: null }),
      detail: "Sign-in couldn't start — the identity service answered in an unexpected shape." }
  ])("a $name native handoff start leaves one visible failure and opens no browser", async ({ response, detail }) => {
    const h = await setup("start")
    try {
      const starting = h.controller.signIn()
      await h.reached.promise
      h.response.resolve(response)
      await starting
      await waitFor(() => h.store.collections.toasts.get("toast-auth.sign-in.handoff")?.status === "failed")
      expect(h.store.collections.toasts.get("toast-auth.sign-in.handoff")?.detail).toBe(detail)
      expect(h.opened).toEqual([])
      expect(h.requests).toEqual(["/api/auth/native/start"])
    } finally { await h.ctx.dispose(); await h.store.dispose?.() }
  })

  test.each([
    { name: "expired", response: new Response("", { status: 404 }), detail: "That sign-in expired — try again." },
    { name: "malformed", response: json({ status: "mystery" }),
      detail: "Sign-in couldn't be confirmed — the identity service answered in an unexpected shape." }
  ])("$name native handoff claim settles the pending toast as failed", async ({ response, detail }) => {
    const h = await setup("claim")
    try {
      await h.controller.signIn()
      await h.reached.promise
      h.response.resolve(response)
      await waitFor(() => h.store.collections.toasts.get("toast-auth.sign-in.handoff")?.status === "failed")
      expect(h.store.collections.toasts.get("toast-auth.sign-in.handoff")?.detail).toBe(detail)
      expect(h.opened).toHaveLength(1)
      expect(h.requests).toEqual(["/api/auth/native/start", "/api/auth/native/claim"])
    } finally { await h.ctx.dispose(); await h.store.dispose?.() }
  })

  test("a browser that cannot open leaves a visible handoff failure without claiming sign-in", async () => {
    const h = await setup("start")
    try {
      const starting = h.controller.signIn(async () => false)
      await h.reached.promise
      h.response.resolve(json({ handoffId: "handoff-1", pollSecret: "secret-1" }))
      await starting
      expect(h.store.collections.toasts.get("toast-auth.sign-in.handoff")).toMatchObject({ status: "failed",
        detail: "Your browser couldn't be opened. Try again." })
      expect(h.requests).toEqual(["/api/auth/native/start"])
      expect(h.store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
    } finally { await h.ctx.dispose(); await h.store.dispose?.() }
  })

  test("a ready claim without a received session refuses to call sign-in complete", async () => {
    const h = await setup("session")
    try {
      await h.controller.signIn()
      await h.reached.promise
      h.response.resolve(json({ status: "signed-out" }))
      await waitFor(() => h.store.collections.toasts.get("toast-auth.sign-in.handoff")?.status === "failed")
      expect(h.store.collections.toasts.get("toast-auth.sign-in.handoff")?.detail)
        .toContain("the sign-in cookie never reached it")
      expect(h.store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
      expect(h.requests).toEqual(["/api/auth/native/start", "/api/auth/native/claim", "/api/user"])
    } finally { await h.ctx.dispose(); await h.store.dispose?.() }
  })
})

/*
 * A refresh whose account moved out from under it writes nothing: the reply
 * describes an account the app no longer has open. Reporting "Balance is up
 * to date" for a balance nobody wrote is the silent-lie shape — the toast
 * must leave without claiming a result.
 */
describe("a balance refresh the account outlives", () => {
  test("an epoch change mid-request leaves no 'up to date' toast and no balance", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let release: (response: Response) => void = () => {}
    const ctx = createControllerContext(store, agent, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
      toastDebounceMs: 0,
      toastAutoDismissMs: 10_000
    })
    ctx.withToast = createFailureController(ctx).withToast
    const controller = createAuthBillingController(ctx, () => 0)

    const pending = controller.refreshBalance()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.collections.toasts.get("toast-billing.balance.refresh")?.status).toBe("running")

    // A focus re-read adopted a different session while the request was out.
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other",
      allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    release(
      new Response(
        JSON.stringify({
          state: "ok",
          allowedToStartWork: true,
          balance: { totalUsd: "500", lifetimeChargedUsd: "0", chargeCount: 0 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    )
    await pending
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(store.collections.billingAccounts.get("billing")?.state).not.toBe("ok")
    expect(store.collections.toasts.get("toast-billing.balance.refresh")).toBeUndefined()
  })
})

test("a selected identity read completes before resuming a parked act", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const ctx = createControllerContext(store, agent, {
      fetchImpl: async () => Response.json(signedIn)
    })
    ctx.withToast = async (_key, _title, _done, work) => work()
    const calls: string[] = []
    let release!: (identity: { username: string; admin: boolean; scopes: null }) => void
    const identity = new Promise<{ username: string; admin: boolean; scopes: null }>(resolve => { release = resolve })
    ctx.resumeDeferredCommand = () => calls.push("resume")
    const controller = createAuthBillingController(ctx, () => 0, {
      current: async () => { calls.push("identity"); return identity },
      signInPath: "/api/auth/github"
    })
    const loading = controller.loadSession()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toEqual(["identity"])
    release({ username: "will", admin: false, scopes: null })
    await loading
    expect(calls).toEqual(["identity", "resume"])
  })

/*
 * A balance read nobody asked for says nothing at all: the reads a session
 * load and a settled turn fire leave the toast stack empty while they run and
 * once they land, and signed out they do not run. A real failure still states
 * what failed and a later read clears it, a superseded one still writes
 * nothing, and the read a user asks for keeps its own notice and its own
 * result even when an automatic read answers first.
 */
describe("automatic balance refreshes", () => {
  const TOAST_ID = "toast-billing.balance.refresh"
  const balanceOk = {
    state: "ok",
    allowedToStartWork: true,
    balance: { totalUsd: "500", lifetimeChargedUsd: "0", chargeCount: 0 }
  }
  const setupBilling = async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const pending: Array<(response: Response) => void> = []
    const ctx = createControllerContext(store, agent, {
      fetchImpl: () => {
        return new Promise<Response>((resolve) => {
            pending.push(resolve)
          })
      },
      toastDebounceMs: 0,
      toastAutoDismissMs: 10_000
    })
    ctx.withToast = createFailureController(ctx).withToast
    const toast = () => store.collections.toasts.get(TOAST_ID)
    const until = async (ready: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !ready(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect(ready()).toBe(true)
    }
    return {
      ctx,
      controller: createAuthBillingController(ctx, () => 0, {
        current: async () => ({ username: "will", admin: false, scopes: null }), signInPath: "/api/auth/github"
      }),
      toast,
      balance: () => store.collections.billingAccounts.get("billing"),
      // Every request this harness holds open is a balance read.
      reads: () => pending.length,
      // The read is held open until the test answers it, so "while it runs" is
      // an observable window and not a race with the answer.
      inFlight: (count = 1) => until(() => pending.length >= count),
      answer: (index: number, response: Response) => pending[index]?.(response),
      release: (response: Response) => pending[pending.length - 1]?.(response),
      signedOut: () =>
        store.dispatch({
          type: "identity.session.loaded",
          actor: "system",
          state: "signed-out",
          login: null,
          allowlisted: false,
          admin: false,
          scopesPlain: null
        }).isPersisted.promise,
      running: () => until(() => toast()?.status === "running"),
      until
    }
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  // Past the 300ms law's debounce: whatever the toast stack holds now is what
  // the read chose to say, not what it had not got round to saying yet.
  const pastDebounce = async () => {
    await tick()
    await tick()
  }
  // Long enough for a read that was going to be issued to have reached the
  // seam, so "no request" is a decision and not a measurement taken too early.
  const settle = async () => {
    for (let turn = 0; turn < 20; turn += 1) await tick()
  }

  test("a session load's refresh writes the balance and leaves no notice", async () => {
    const h = await setupBilling()
    void h.controller.loadSession()
    await h.inFlight()
    await pastDebounce()
    expect(h.toast()).toBeUndefined()
    h.release(Response.json(balanceOk))
    await h.until(() => h.balance()?.state === "ok")
    await tick()
    expect(h.balance()?.totalUsd).toBe("500")
    expect(h.toast()).toBeUndefined()
  })

  test("a settled turn's refresh writes the balance and leaves no notice", async () => {
    const h = await setupBilling()
    h.controller.settleTurnBilling()
    await h.inFlight()
    await pastDebounce()
    expect(h.toast()).toBeUndefined()
    h.release(Response.json(balanceOk))
    await h.until(() => h.balance()?.state === "ok")
    await tick()
    expect(h.balance()?.totalUsd).toBe("500")
    expect(h.toast()).toBeUndefined()
  })

  /*
   * Anonymous turns are a supported door on a public catalog repository, and
   * the server refuses a balance read for a session it never validated
   * (sign_in_required, 401). That refusal is the expected answer, not news:
   * the visitor has no balance and asked for nothing, so the read never goes
   * out. "unavailable" is left reading — a native deployment authenticates
   * the seam with its own bearer and has no session at all.
   */
  test("a settled turn while signed out reads nothing and says nothing", async () => {
    const h = await setupBilling()
    await h.signedOut()
    h.controller.settleTurnBilling()
    await settle()
    expect(h.reads()).toBe(0)
    expect(h.toast()).toBeUndefined()
  })

  test("a failed automatic refresh states the failure and nothing before it", async () => {
    const h = await setupBilling()
    h.controller.settleTurnBilling()
    await h.inFlight()
    await pastDebounce()
    expect(h.toast()).toBeUndefined()
    h.release(new Response("", { status: 500 }))
    await h.until(() => h.toast()?.status === "failed")
    expect(h.toast()).toMatchObject({
      title: "Refreshing your balance…",
      status: "failed",
      detail: "Your balance couldn't be refreshed right now."
    })
    expect(h.balance()?.state).not.toBe("ok")
  })

  /*
   * A failure nothing can clear is a permanent toast: the next automatic read
   * succeeds, the balance is fresh, and the sentence on screen is now false.
   * The read that heals it is still quiet on the way — it paints no notice
   * over the failure it is about to take down.
   */
  test("a later automatic refresh clears the failure an earlier one left", async () => {
    const h = await setupBilling()
    h.controller.settleTurnBilling()
    await h.inFlight()
    await pastDebounce()
    h.answer(0, new Response("", { status: 500 }))
    await h.until(() => h.toast()?.status === "failed")
    h.controller.settleTurnBilling()
    await h.inFlight(2)
    await pastDebounce()
    expect(h.toast()?.status).toBe("failed")
    h.answer(1, Response.json(balanceOk))
    await h.until(() => h.balance()?.state === "ok")
    await pastDebounce()
    expect(h.toast()).toBeUndefined()
  })

  test("an automatic refresh the account outlives writes no balance", async () => {
    const h = await setupBilling()
    h.controller.settleTurnBilling()
    await h.inFlight()
    await pastDebounce()
    await h.ctx.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other",
      allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    h.release(Response.json(balanceOk))
    await pastDebounce()
    expect(h.balance()?.state).not.toBe("ok")
    expect(h.toast()).toBeUndefined()
  })

  test("the balance a user asks for still states its result", async () => {
    const h = await setupBilling()
    const asked = h.controller.showBalance()
    await h.running()
    h.release(Response.json(balanceOk))
    expect(await asked).toEqual({ value: "balance: $500 left; $0 spent across 0 turn(s)" })
    expect(h.toast()).toMatchObject({ title: "Balance is up to date", status: "ok" })
  })

  test("an automatic refresh answering first leaves the asked-for read its notice", async () => {
    const h = await setupBilling()
    const asked = h.controller.showBalance()
    await h.running()
    h.controller.settleTurnBilling()
    await h.inFlight(2)
    h.answer(1, Response.json(balanceOk))
    await h.until(() => h.balance()?.state === "ok")
    await pastDebounce()
    expect(h.toast()).toMatchObject({ title: "Refreshing your balance…", status: "running" })
    h.answer(0, Response.json(balanceOk))
    expect(await asked).toEqual({ value: "balance: $500 left; $0 spent across 0 turn(s)" })
    expect(h.toast()).toMatchObject({ title: "Balance is up to date", status: "ok" })
  })
})

/*
 * Window focus, a sibling tab's ping and any 401 re-read the session. Only an
 * answer naming another owner is an account change: a re-probe of the same
 * owner refreshes the row and fences nothing, while a probe that a later probe
 * or a sign-out overtook writes nothing at all.
 */
describe("identity re-probes", () => {
  const probes = async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const answers: Array<(identity: { username: string; admin: boolean; scopes: null }) => void> = []
    const ctx = createControllerContext(store, agent, {
      fetchImpl: (input, init) => {
        const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test").pathname
        if (path.endsWith("/auth/logout") && init?.method === "POST") return Promise.resolve(Response.json({}))
        // The balance read a signed-in answer starts is not under test: it never answers.
        return new Promise<Response>(() => {})
      }
    })
    ctx.withToast = async (_key, _title, _done, work) => work()
    const controller = createAuthBillingController(ctx, () => 0, {
      current: () => new Promise(resolve => { answers.push(resolve) }), signInPath: "/api/auth/github"
    })
    const until = async (ready: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !ready(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
      expect(ready()).toBe(true)
    }
    return {
      ctx, controller,
      identity: () => store.collections.identitySessions.get("identity"),
      probe: async (answer: Record<string, unknown>) => {
        const loading = controller.loadSession()
        await until(() => answers.length > 0)
        answers.shift()!({ username: String(answer.login), admin: answer.admin === true, scopes: null })
        await loading
      },
      held: async (count: number) => { await until(() => answers.length >= count); return answers.splice(0) },
      dispose: async () => { await ctx.dispose(); await store.dispose?.() }
    }
  }

  test("a same-login re-probe records the answer and changes no account", async () => {
    const h = await probes()
    try {
      await h.probe(signedIn)
      const epoch = h.ctx.accountEpoch
      const observed = h.identity()?.sessionObservation?.revision ?? -1
      await h.probe(signedIn)
      await h.probe(signedIn)
      expect(h.ctx.accountEpoch).toBe(epoch)
      expect(h.identity()?.sessionObservation?.revision).toBeGreaterThan(observed)
      await h.probe({ ...signedIn, login: "other" })
      expect(h.ctx.accountEpoch).toBe(epoch + 1)
    } finally { await h.dispose() }
  })

  test("a probe a later probe overtook writes nothing", async () => {
    const h = await probes()
    try {
      const first = h.controller.loadSession()
      const second = h.controller.loadSession()
      const [older, newer] = await h.held(2)
      newer!({ username: "newer", admin: false, scopes: null })
      await second
      older!({ username: "older", admin: false, scopes: null })
      await first
      expect(h.identity()).toMatchObject({ state: "signed-in", login: "newer" })
    } finally { await h.dispose() }
  })

  test("signing out changes the account once and discards the probe it overtook", async () => {
    const h = await probes()
    try {
      await h.probe(signedIn)
      const epoch = h.ctx.accountEpoch
      const reading = h.controller.loadSession()
      const [late] = await h.held(1)
      expect(await h.controller.signOut()).toBeUndefined()
      expect(h.ctx.accountEpoch).toBe(epoch + 1)
      late!({ username: "will", admin: false, scopes: null })
      await reading
      expect(h.identity()).toMatchObject({ state: "signed-out", login: null })
      expect(h.ctx.accountEpoch).toBe(epoch + 1)
    } finally { await h.dispose() }
  })
})

/*
 * An account answer lands only on the account that asked. A reply that
 * arrives after sign-out or another login describes an account this page no
 * longer holds: it writes no card, no transcript line, no access state and
 * no toast.
 */
describe("account answers that outlive their account", () => {
  const setup = async (identity: { login: string; allowlisted: boolean; admin: boolean }) => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", ...identity, scopesPlain: null })
      .isPersisted.promise
    const held: Array<{ path: string; answer: (response: Response) => void }> = []
    const ctx = createControllerContext(store, agent, {
      fetchImpl: (input, init) => {
        const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test").pathname
        if (path.endsWith("/auth/logout") && init?.method === "POST") return Promise.resolve(Response.json({}))
        return new Promise<Response>(answer => { held.push({ path, answer }) })
      },
      toastDebounceMs: 0,
      toastAutoDismissMs: 10_000
    })
    ctx.withToast = createFailureController(ctx).withToast
    const until = async (ready: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !ready(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
      expect(ready()).toBe(true)
    }
    const written = () => ({
      cards: [...store.collections.cards.keys()],
      messages: [...store.collections.messages.values()].map(message => message.text),
      toasts: [...store.collections.toasts.values()].map(toast => `${toast.status}:${toast.detail ?? toast.title}`)
    })
    return {
      store, ctx, until, written,
      controller: createAuthBillingController(ctx, () => 0),
      answer: async (path: string, response: Response) => {
        await until(() => held.some(request => request.path === path))
        held.find(request => request.path === path)!.answer(response)
      },
      dispose: async () => { await ctx.dispose(); await store.dispose?.() }
    }
  }
  const admin = { login: "will", allowlisted: true, admin: true }
  const queue = { requests: [{ login: "stranger", note: "let me in", createdAt: "2026-09-23T00:00:00Z" }] }
  const health = { services: [{ name: "billing", status: "failed", detail: "down" }], queueDepth: 1, checkedAt: "2026-09-23T00:00:00Z" }
  const cases: ReadonlyArray<readonly [string, (controller: ReturnType<typeof createAuthBillingController>) => Promise<unknown>, string, () => Response]> = [
    ["the request queue", (c) => c.adminRequests(), ADMIN_REQUESTS_PATH, () => Response.json(queue)],
    ["a refused request queue", (c) => c.adminRequests(), ADMIN_REQUESTS_PATH, () => new Response("down", { status: 500 })],
    ["service health", (c) => c.adminHealth(), ADMIN_HEALTH_PATH, () => Response.json(health)],
    ["a refused service health read", (c) => c.adminHealth(), ADMIN_HEALTH_PATH, () => new Response("down", { status: 500 })],
    ["an allowlist change", (c) => c.adminAllowlist("add", "stranger"), ADMIN_ALLOWLIST_PATH, () => Response.json({ applied: true })],
    ["a queue approval", (c) => c.adminQueueApprove("stranger"), ADMIN_ALLOWLIST_PATH, () => new Response("down", { status: 500 })]
  ]
  for (const [name, act, path, response] of cases) {
    test(`${name} answered after sign-out writes nothing`, async () => {
      const h = await setup(admin)
      try {
        const acting = act(h.controller)
        await h.until(() => h.store.collections.toasts.size > 0)
        expect(await h.controller.signOut()).toBeUndefined()
        const cleared = h.written()
        await h.answer(path, response())
        await acting
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(h.written()).toEqual(cleared)
      } finally { await h.dispose() }
    })
  }

  test("a grant answered after sign-out writes nothing", async () => {
    const h = await setup(admin)
    try {
      h.controller.adminGrant(10, "stranger")
      const card = [...h.store.collections.cards.values()].find(row => row.kind === "grant-confirm")!
      const granting = h.controller.adminGrantConfirm(card.id)
      await h.until(() => h.store.collections.toasts.size > 0)
      expect(await h.controller.signOut()).toBeUndefined()
      const cleared = h.written()
      await h.answer(ADMIN_GRANT_PATH, new Response("down", { status: 500 }))
      await granting
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(h.written()).toEqual(cleared)
    } finally { await h.dispose() }
  })

  for (const [name, response] of [["refused", () => new Response("down", { status: 500 })], ["filed", () => Response.json({})]] as const) {
    test(`an access request ${name} after another login leaves the new account's access state alone`, async () => {
      const h = await setup({ login: "will", allowlisted: false, admin: false })
      try {
        const requesting = h.controller.requestAccess()
        await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other",
          allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
        await h.answer(IDENTITY_REQUEST_ACCESS_PATH, response())
        expect(await requesting).toBeUndefined()
        expect(h.store.collections.identitySessions.get("identity")).toMatchObject({ login: "other", accessRequested: false, accessError: null })
      } finally { await h.dispose() }
    })
  }
})

test.each([
  { body: { state: "mystery", allowedToStartWork: true, balance: { totalUsd: "20" } }, name: "unknown state" },
  { body: { state: "ok", allowedToStartWork: "yes", balance: { totalUsd: "20" } }, name: "non-boolean permission" },
  { body: { state: "ok", allowedToStartWork: true, balance: { totalUsd: 20 } }, name: "non-string amount" },
  { body: { state: "ok", allowedToStartWork: true }, name: "missing balance" }
])("a balance answer with $name cannot invent an amount or a balance card", async ({ body }) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const ctx = createControllerContext(store, agent, { toastDebounceMs: 0, toastAutoDismissMs: 10_000,
    fetchImpl: async () => Response.json(body) })
  ctx.withToast = createFailureController(ctx).withToast
  const controller = createAuthBillingController(ctx, store.nextOrdinal)
  try {
    expect(await controller.showBalance()).toBe("The billing service didn't answer, so there is no balance to state right now.")
    expect(store.collections.billingAccounts.get("billing")?.state).toBe("unavailable")
    expect(store.collections.cards.has("billing-balance")).toBe(false)
    expect(store.collections.toasts.get("toast-billing.balance.refresh")).toMatchObject({ status: "failed",
      detail: "Your balance couldn't be refreshed right now." })
  } finally { await ctx.dispose(); await store.dispose?.() }
})

test("requesting access refuses ineligible states and recovers after a lost request", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let networkFails = true
  const calls: Array<{ path: string; body: unknown }> = []
  const ctx = createControllerContext(store, agent, { fetchImpl: async (input, init) => {
    calls.push({ path: String(input), body: init?.body === undefined ? null : JSON.parse(String(init.body)) })
    if (networkFails) throw Error("offline")
    return Response.json({})
  } })
  const controller = createAuthBillingController(ctx, store.nextOrdinal)
  try {
    expect(await controller.requestAccess()).toBe("Sign in with GitHub first — an access request needs an account to attach to.")
    await store.dispatch({ type: "identity.session.loaded", actor: "system", ...signedIn, scopesPlain: null }).isPersisted.promise
    expect(await controller.requestAccess()).toBe("You already have access as will — there is no request to file.")
    expect(calls).toEqual([])
    await store.dispatch({ type: "identity.session.loaded", actor: "system", ...signedIn, allowlisted: false, scopesPlain: null }).isPersisted.promise
    expect(await controller.requestAccess()).toBeUndefined()
    expect(store.collections.identitySessions.get("identity")).toMatchObject({ login: "will", accessRequested: false,
      accessError: "The access request did not go through. Try again." })
    networkFails = false
    expect(await controller.requestAccess()).toBeUndefined()
    expect(store.collections.identitySessions.get("identity")).toMatchObject({ login: "will", accessRequested: true, accessError: null })
    expect(calls.map(call => call.body)).toEqual([{ login: "will" }, { login: "will" }])
    expect(calls.every(call => call.path.endsWith(IDENTITY_REQUEST_ACCESS_PATH))).toBe(true)
  } finally { await ctx.dispose(); await store.dispose?.() }
})

test("a grant whose route fails remains retryable with one stable operation key", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will",
    allowlisted: true, admin: true, scopesPlain: null }).isPersisted.promise
  let networkFails = true
  const posted: Array<{ login: string; amountUsd: number; operationKey: string }> = []
  const ctx = createControllerContext(store, agent, { toastDebounceMs: 0, toastAutoDismissMs: 10_000,
    fetchImpl: async (input, init) => {
      if (!String(input).endsWith(ADMIN_GRANT_PATH)) throw Error("Unexpected route")
      posted.push(JSON.parse(String(init?.body)))
      if (networkFails) throw Error("offline")
      return Response.json({ grantId: "grant-from-host" })
    } })
  ctx.withToast = createFailureController(ctx).withToast
  const controller = createAuthBillingController(ctx, store.nextOrdinal)
  try {
    controller.adminGrant(25, "recipient")
    const card = [...store.collections.cards.values()].find(row => row.kind === "grant-confirm")!
    expect(card).toMatchObject({ title: "Grant $25 to recipient?", payload: { login: "recipient", amountUsd: 25, phase: "confirm" } })
    expect(posted).toEqual([])
    expect(await controller.adminGrantConfirm(card.id)).toBeUndefined()
    expect(store.collections.cards.get(card.id)).toMatchObject({ status: "error",
      payload: { phase: "failed", error: "The grant didn't go through — the admin route didn't answer." } })
    networkFails = false
    expect(await controller.adminGrantConfirm(card.id)).toBeUndefined()
    expect(store.collections.cards.get(card.id)).toMatchObject({ status: "acted",
      payload: { phase: "granted", grantId: "grant-from-host" } })
    expect(posted).toEqual([{ login: "recipient", amountUsd: 25, operationKey: card.id },
      { login: "recipient", amountUsd: 25, operationKey: card.id }])
    expect(await controller.adminGrantConfirm(card.id)).toBe("That grant was already posted.")
  } finally { await ctx.dispose(); await store.dispose?.() }
})

test("a refused grant keeps its exact confirmation card and does not claim credit", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will",
    allowlisted: true, admin: true, scopesPlain: null }).isPersisted.promise
  const posted: unknown[] = []
  const ctx = createControllerContext(store, agent, { toastDebounceMs: 0, toastAutoDismissMs: 10_000,
    fetchImpl: async (input, init) => {
      if (!String(input).endsWith(ADMIN_GRANT_PATH)) throw Error("Unexpected route")
      posted.push(JSON.parse(String(init?.body)))
      return new Response("Host denied", { status: 503 })
    } })
  ctx.withToast = createFailureController(ctx).withToast
  const controller = createAuthBillingController(ctx, store.nextOrdinal)
  try {
    controller.adminGrant(25, "recipient")
    const card = [...store.collections.cards.values()].find(row => row.kind === "grant-confirm")!
    expect(await controller.adminGrantConfirm(card.id)).toBeUndefined()
    expect(store.collections.cards.get(card.id)).toMatchObject({ status: "error",
      payload: { login: "recipient", amountUsd: 25, phase: "failed",
        error: "The grant didn't go through. (Host denied)" } })
    expect(posted).toEqual([{ login: "recipient", amountUsd: 25, operationKey: card.id }])
    expect(store.collections.toasts.get("toast-admin.grant")).toMatchObject({ status: "failed",
      detail: "The grant didn't go through. (Host denied)" })
  } finally { await ctx.dispose(); await store.dispose?.() }
})

test("grant cancellation removes an unposted card but cannot interrupt a posted operation", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will",
    allowlisted: true, admin: true, scopesPlain: null }).isPersisted.promise
  const remote = Promise.withResolvers<Response>()
  const posted: unknown[] = []
  const ctx = createControllerContext(store, agent, { fetchImpl: async (input, init) => {
    if (!String(input).endsWith(ADMIN_GRANT_PATH)) throw Error("Unexpected route")
    posted.push(JSON.parse(String(init?.body)))
    return remote.promise
  } })
  ctx.withToast = createFailureController(ctx).withToast
  const controller = createAuthBillingController(ctx, store.nextOrdinal)
  try {
    controller.adminGrant(5, "first")
    const first = [...store.collections.cards.values()].find(row => row.kind === "grant-confirm")!
    expect(controller.adminGrantCancel(first.id)).toBeUndefined()
    expect(store.collections.cards.has(first.id)).toBe(false)
    expect(await controller.adminGrantConfirm(first.id)).toBe("That grant confirmation is gone.")
    expect(posted).toEqual([])

    controller.adminGrant(7, "second")
    const second = [...store.collections.cards.values()].find(row => row.kind === "grant-confirm")!
    const posting = controller.adminGrantConfirm(second.id)
    await waitFor(() => posted.length === 1)
    expect(store.collections.cards.get(second.id)).toMatchObject({ payload: { phase: "sending" } })
    expect(controller.adminGrantCancel(second.id)).toBe("That grant is already being posted — a moment.")
    expect(store.collections.cards.has(second.id)).toBe(true)
    remote.resolve(Response.json({ grantId: "host-7" }))
    await posting
    expect(store.collections.cards.get(second.id)).toMatchObject({ status: "acted",
      payload: { phase: "granted", grantId: "host-7" } })
    expect(posted).toEqual([{ login: "second", amountUsd: 7, operationKey: second.id }])
  } finally { remote.resolve(Response.json({})); await ctx.dispose(); await store.dispose?.() }
})

test.each([
  { state: "unavailable" as const, key: "auth.sign-in.unavailable", status: "failed", detail: "No identity service is configured here — use the deployed app to sign in." },
  { state: "unknown" as const, key: "auth.sign-in.pending", status: "failed", detail: "The identity service hasn't answered yet — try again in a moment." },
  { state: "signed-in" as const, key: "auth.sign-in.already", status: "ok", detail: "GitHub is connected." }
])("sign-in from $state states the actual identity status without opening a browser", async ({ state, key, status, detail }) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  if (state !== "unknown") await store.dispatch({ type: "identity.session.loaded", actor: "system", state,
    login: state === "signed-in" ? "will" : null, allowlisted: state === "signed-in", admin: false,
    scopesPlain: null }).isPersisted.promise
  let fetches = 0
  const ctx = createControllerContext(store, agent, { fetchImpl: async () => { fetches++; throw Error("Unexpected network call") } })
  const controller = createAuthBillingController(ctx, store.nextOrdinal)
  try {
    await controller.signIn()
    expect(store.collections.toasts.get(`toast-${key}`)).toMatchObject({ status, detail })
    expect([...store.collections.toasts.values()]).toHaveLength(1)
    expect(fetches).toBe(0)
  } finally { await ctx.dispose(); await store.dispose?.() }
})

test.each(["http", "throw"] as const)("queue approval %s refusal stays on its card and a retry refreshes from the host", async refusal => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will",
    allowlisted: true, admin: true, scopesPlain: null }).isPersisted.promise
  let refuse: typeof refusal | false = refusal, waiting = true
  const posts: unknown[] = []
  const ctx = createControllerContext(store, agent, { toastDebounceMs: 0, toastAutoDismissMs: 10_000,
    fetchImpl: async (input, init) => {
      const path = String(input)
      if (path.endsWith(ADMIN_REQUESTS_PATH)) return Response.json({ requests: waiting
        ? [{ login: "recipient", note: "Please", createdAt: "2026-09-23T00:00:00Z" }] : [] })
      if (path.endsWith(ADMIN_ALLOWLIST_PATH)) {
        posts.push(JSON.parse(String(init?.body)))
        if (refuse === "throw") throw Error("offline")
        if (refuse === "http") return Response.json({ message: "Host refused approval" }, { status: 500 })
        waiting = false
        return Response.json({ applied: true })
      }
      throw Error("Unexpected route")
    } })
  ctx.withToast = createFailureController(ctx).withToast
  const controller = createAuthBillingController(ctx, store.nextOrdinal)
  try {
    await controller.adminRequests()
    expect(store.collections.cards.get("admin-requests")).toMatchObject({ title: "Request-access queue — 1 waiting",
      payload: { requests: [{ login: "recipient", note: "Please" }] } })
    await controller.adminQueueApprove("recipient")
    expect(store.collections.cards.get("admin-requests")).toMatchObject({ status: "error",
      payload: { approving: null, error: refusal === "http" ? "Host refused approval" :
        "Approving recipient didn't go through — the admin route didn't answer." } })
    expect(waiting).toBe(true)
    refuse = false
    await controller.adminQueueApprove("recipient")
    expect(store.collections.cards.get("admin-requests")).toMatchObject({ status: "active",
      title: "Request-access queue — 0 waiting", payload: { requests: [] } })
    expect(posts).toEqual([{ login: "recipient", action: "add" }, { login: "recipient", action: "add" }])
  } finally { await ctx.dispose(); await store.dispose?.() }
})

test.each([
  { name: "malformed", answer: () => Response.json({ services: "not-a-list" }), message: "The health read answered in a shape I didn't understand." },
  { name: "unreachable", answer: () => { throw Error("offline") }, message: "The health read didn't answer — the admin route is unreachable." }
])("$name health answer reports one refusal without inventing a service card", async ({ answer, message }) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will",
    allowlisted: true, admin: true, scopesPlain: null }).isPersisted.promise
  const ctx = createControllerContext(store, agent, { toastDebounceMs: 0, toastAutoDismissMs: 10_000,
    fetchImpl: async input => {
      if (!String(input).endsWith(ADMIN_HEALTH_PATH)) throw Error("Unexpected route")
      return answer()
    } })
  ctx.withToast = createFailureController(ctx).withToast
  const controller = createAuthBillingController(ctx, store.nextOrdinal)
  try {
    expect(await controller.adminHealth()).toBeUndefined()
    expect(store.collections.cards.has("admin-health")).toBe(false)
    expect([...store.collections.messages.values()].map(row => row.text)).toEqual([message])
    expect(store.collections.toasts.get("toast-admin.health")).toMatchObject({ status: "failed", detail: message })
  } finally { await ctx.dispose(); await store.dispose?.() }
})

test("health reread filters invalid rows and replaces failed service evidence with the host's recovery", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will",
    allowlisted: true, admin: true, scopesPlain: null }).isPersisted.promise
  let recovered = false
  const ctx = createControllerContext(store, agent, { fetchImpl: async input => {
    if (!String(input).endsWith(ADMIN_HEALTH_PATH)) throw Error("Unexpected route")
    return Response.json(recovered
      ? { services: [{ name: "billing", status: "ok", detail: "Recovered" }], charges: null, queueDepth: 0,
        checkedAt: "2026-09-24T00:00:00Z" }
      : { services: [{ name: "billing", status: "failed", detail: "Unavailable" },
        { name: "bad", status: "mystery", detail: "Ignore" }],
      charges: { chargeCount: 3, lifetimeChargedUsd: "12" }, queueDepth: 2, checkedAt: "2026-09-23T00:00:00Z" })
  } })
  ctx.withToast = createFailureController(ctx).withToast
  const controller = createAuthBillingController(ctx, store.nextOrdinal)
  try {
    await controller.adminHealth()
    const first = store.collections.cards.get("admin-health")!
    expect(first).toMatchObject({ kind: "admin-health", status: "error", payload: {
      services: [{ name: "billing", status: "failed", detail: "Unavailable" }],
      charges: { chargeCount: 3, lifetimeChargedUsd: "12" }, queueDepth: 2, checkedAt: "2026-09-23T00:00:00Z" } })
    recovered = true
    await controller.adminHealth()
    expect(store.collections.cards.get("admin-health")).toMatchObject({ status: "active", createdAt: first.createdAt,
      payload: { services: [{ name: "billing", status: "ok", detail: "Recovered" }], charges: null,
        queueDepth: 0, checkedAt: "2026-09-24T00:00:00Z" } })
    expect([...store.collections.cards.values()].filter(card => card.kind === "admin-health")).toHaveLength(1)
  } finally { await ctx.dispose(); await store.dispose?.() }
})

test("an unreachable queue reread reports failure without replacing the last confirmed queue", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will",
    allowlisted: true, admin: true, scopesPlain: null }).isPersisted.promise
  let offline = false
  const ctx = createControllerContext(store, agent, { toastDebounceMs: 0, toastAutoDismissMs: 10_000,
    fetchImpl: async input => {
      if (!String(input).endsWith(ADMIN_REQUESTS_PATH)) throw Error("Unexpected route")
      if (offline) throw Error("offline")
      return Response.json({ requests: [{ login: "recipient", note: "Please", createdAt: "2026-09-23T00:00:00Z" }] })
    } })
  ctx.withToast = createFailureController(ctx).withToast
  const controller = createAuthBillingController(ctx, store.nextOrdinal)
  try {
    await controller.adminRequests()
    const confirmed = store.collections.cards.get("admin-requests")!
    expect(confirmed).toMatchObject({ title: "Request-access queue — 1 waiting",
      payload: { requests: [{ login: "recipient" }] } })
    offline = true
    await controller.adminRequests()
    expect(store.collections.cards.get("admin-requests")).toEqual(confirmed)
    expect([...store.collections.messages.values()].map(row => row.text))
      .toEqual(["The request queue didn't answer — the admin route is unreachable."])
    expect(store.collections.toasts.get("toast-admin.requests")).toMatchObject({ status: "failed",
      detail: "The request queue didn't answer — the admin route is unreachable." })
  } finally { await ctx.dispose(); await store.dispose?.() }
})

test.each([
  { name: "signed-out", current: async () => null, state: "signed-out" },
  { name: "provider error", current: async () => { throw Error("offline") }, state: "unavailable" }
] as const)("$name selected identity records $state without waiting for scopes or billing", async ({ current, state }) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const paths: string[] = []
  const ctx = createControllerContext(store, agent, { fetchImpl: async input => {
    const path = String(input)
    paths.push(path)
    if (path.endsWith("/api/auth/scopes")) return Response.json({ scopes: [
      { plain: "See your GitHub profile." }, { plain: "Read your repositories." }
    ] })
    throw Error("Unexpected request")
  } })
  const controller = createAuthBillingController(ctx, store.nextOrdinal, { current, signInPath: "/api/auth/github" })
  try {
    await controller.loadSession()
    expect(store.collections.identitySessions.get("identity")?.state).toBe(state)
    expect(store.collections.identitySessions.get("identity")?.login).toBeNull()
    expect(store.collections.identitySessions.get("identity")?.scopesPlain).toBeNull()
    expect(paths).toEqual([])
  } finally { await ctx.dispose(); await store.dispose?.() }
})

test.each([
  { action: "add" as const, duplicate: false, text: "recipient added to the allowlist, recorded under your name." },
  { action: "add" as const, duplicate: true, text: "recipient was already on the allowlist — nothing changed." },
  { action: "remove" as const, duplicate: false, text: "recipient removed from the allowlist, recorded under your name." },
  { action: "remove" as const, duplicate: true, text: "recipient was already off the allowlist — nothing changed." }
])("allowlist $action with duplicate=$duplicate states the host's verdict", async ({ action, duplicate, text }) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will",
    allowlisted: true, admin: true, scopesPlain: null }).isPersisted.promise
  const posted: unknown[] = []
  const ctx = createControllerContext(store, agent, { toastDebounceMs: 0, toastAutoDismissMs: 10_000,
    fetchImpl: async (input, init) => {
      if (!String(input).endsWith(ADMIN_ALLOWLIST_PATH)) throw Error("Unexpected route")
      posted.push(JSON.parse(String(init?.body)))
      return Response.json({ applied: !duplicate, duplicate })
    } })
  ctx.withToast = createFailureController(ctx).withToast
  const controller = createAuthBillingController(ctx, store.nextOrdinal)
  try {
    expect(await controller.adminAllowlist(action, "recipient")).toBeUndefined()
    expect(posted).toEqual([{ login: "recipient", action }])
    expect([...store.collections.messages.values()].map(row => row.text)).toEqual([text])
    expect([...store.collections.toasts.values()].some(toast => toast.status === "running" || toast.status === "failed")).toBe(false)
  } finally { await ctx.dispose(); await store.dispose?.() }
})

test("three refused native claims end sign-in with the host's error", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null,
    allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
  const opened: string[] = []
  let claims = 0, sessionReads = 0
  const ctx = createControllerContext(store, agent, { handoffPollMs: 1, toastAutoDismissMs: 10_000,
    openExternal: async url => { opened.push(url); return true },
    fetchImpl: async input => {
      const path = String(input)
      if (path.endsWith("/auth/native/start")) return Response.json({ handoffId: "handoff", pollSecret: "secret" })
      if (path.endsWith("/auth/native/claim")) { claims++; return Response.json({ message: "Identity is unavailable" }, { status: 503 }) }
      if (path.endsWith("/api/user")) { sessionReads++; return Response.json(signedIn) }
      throw Error("Unexpected route")
    } })
  ctx.resolveToast = createFailureController(ctx).resolveToast
  const controller = createAuthBillingController(ctx, store.nextOrdinal)
  try {
    await controller.signIn()
    await waitFor(() => store.collections.toasts.get("toast-auth.sign-in.handoff")?.status === "failed")
    expect(store.collections.toasts.get("toast-auth.sign-in.handoff")?.detail).toBe("Sign-in couldn't be confirmed: Identity is unavailable")
    expect(claims).toBe(3)
    expect(sessionReads).toBe(0)
    expect(opened).toHaveLength(1)
    expect(store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
  } finally { await ctx.dispose(); await store.dispose?.() }
})

test.each([
  { name: "HTTP refusal", answer: () => new Response("denied", { status: 503 }),
    message: "The allowlist change didn't go through. (denied)" },
  { name: "network error", answer: () => { throw Error("offline") },
    message: "The allowlist change didn't go through — the admin route didn't answer." }
])("an allowlist $name records one refusal without claiming an update", async ({ answer, message }) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will",
    allowlisted: true, admin: true, scopesPlain: null }).isPersisted.promise
  const ctx = createControllerContext(store, agent, { toastDebounceMs: 0, toastAutoDismissMs: 10_000,
    fetchImpl: async input => {
      if (!String(input).endsWith(ADMIN_ALLOWLIST_PATH)) throw Error("Unexpected route")
      return answer()
    } })
  ctx.withToast = createFailureController(ctx).withToast
  const controller = createAuthBillingController(ctx, store.nextOrdinal)
  try {
    expect(await controller.adminAllowlist("add", "recipient")).toBeUndefined()
    expect([...store.collections.messages.values()].map(row => row.text)).toEqual([message])
    expect(store.collections.toasts.get("toast-admin.allowlist")).toMatchObject({ status: "failed", detail: message })
  } finally { await ctx.dispose(); await store.dispose?.() }
})

test("a selected identity provider that cannot answer leaves the session unavailable", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let settledCalls = 0, requests = 0
  const ctx = createControllerContext(store, agent, { fetchImpl: async () => { requests++; throw Error("Unexpected web probe") } })
  const controller = createAuthBillingController(ctx, store.nextOrdinal, {
    current: async () => { throw Error("provider offline") }, signInPath: "/api/auth/github", settled: () => { settledCalls++ }
  })
  try {
    await controller.loadSession()
    expect(store.collections.identitySessions.get("identity")?.state).toBe("unavailable")
    expect(store.collections.cloudSessions.get("cloud")?.state).not.toBe("signed-in")
    expect(settledCalls).toBe(0)
    expect(requests).toBe(0)
  } finally { await ctx.dispose(); await store.dispose?.() }
})

interface TestIdentityChannel {
  readonly name: string
  onmessage: ((event: MessageEvent) => void) | null
  readonly posted: unknown[]
  readonly closed: boolean
}
const withVisibleHost = async (
  run: (host: { doc: EventTarget; win: EventTarget; channels: TestIdentityChannel[] }) => Promise<void>,
  dispose: () => Promise<void>, broadcast = false
) => {
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible", documentElement: { dataset: {} } })
  const win = new EventTarget()
  const channels: TestIdentityChannel[] = []
  class Channel implements TestIdentityChannel {
    onmessage: ((event: MessageEvent) => void) | null = null
    posted: unknown[] = []
    closed = false
    constructor(readonly name: string) { channels.push(this) }
    postMessage(value: unknown) { this.posted.push(value) }
    close() { this.closed = true }
  }
  const originals = ["document", "window", "BroadcastChannel"].map(key => [key,
    Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc })
  Object.defineProperty(globalThis, "window", { configurable: true, value: win })
  Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: broadcast ? Channel : undefined })
  try { await run({ doc, win, channels }) }
  finally {
    try { await dispose() }
    finally {
      for (const [key, descriptor] of originals) {
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
        else Object.defineProperty(globalThis, key, descriptor)
      }
    }
  }
}

test("tab focus coalesces one session read and disposal removes its observer", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const answers: Array<(identity: null) => void> = []
  let sessionReads = 0
  const ctx = createControllerContext(store, agent, { fetchImpl: async input => {
    if (String(input).endsWith("/api/auth/scopes")) return Response.json({ scopes: [] })
    throw Error("Unexpected route")
  } })
  const controller = createAuthBillingController(ctx, store.nextOrdinal, {
    current: () => { sessionReads++; return new Promise(resolve => { answers.push(resolve) }) },
    signInPath: "/api/auth/github"
  })
  await withVisibleHost(async ({ doc, win }) => {
    controller.watchIdentityAcrossTabs()
    win.dispatchEvent(new Event("focus"))
    win.dispatchEvent(new Event("focus"))
    doc.dispatchEvent(new Event("visibilitychange"))
    expect(sessionReads).toBe(1)
    answers.shift()!(null)
    await waitFor(() => store.collections.identitySessions.get("identity")?.state === "signed-out")
    win.dispatchEvent(new Event("focus"))
    await waitFor(() => sessionReads === 2)
    answers.shift()!(null)
    await settle()
    await ctx.dispose()
    win.dispatchEvent(new Event("focus"))
    doc.dispatchEvent(new Event("visibilitychange"))
    expect(sessionReads).toBe(2)
    expect(store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
  }, async () => { await ctx.dispose(); await store.dispose?.() })
})

test("a failed focus refresh reports its callback error while keeping the signed-in answer", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const ctx = createControllerContext(store, agent, { fetchImpl: async () => Response.json({ state: "ok", allowedToStartWork: true,
      balance: { totalUsd: "25", lifetimeChargedUsd: "0", chargeCount: 0 } }) })
  ctx.withToast = createFailureController(ctx).withToast
  const controller = createAuthBillingController(ctx, store.nextOrdinal, {
    current: async () => ({ username: "will", admin: false, scopes: null }),
    signInPath: "/api/auth/github",
    settled: () => { throw Error("Selected identity callback failed") }
  })
  await withVisibleHost(async ({ win }) => {
    controller.watchIdentityAcrossTabs()
    win.dispatchEvent(new Event("focus"))
    await waitFor(() => ctx.failures.recent().some(failure => failure.seam === "command.boundary"))
    expect(ctx.failures.recent().filter(failure => failure.seam === "command.boundary"))
      .toEqual([expect.objectContaining({ subject: "identity.refresh", message: expect.stringContaining("Selected identity callback failed") })])
    expect(store.collections.identitySessions.get("identity")).toMatchObject({ state: "signed-in", login: "will" })
    expect(ctx.disposed).toBe(false)
  }, async () => { await ctx.dispose(); await store.dispose?.() })
})

test("a sibling identity signal rereads the session and closes its channel on dispose", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const answer = Promise.withResolvers<null>()
  let reads = 0
  const ctx = createControllerContext(store, agent, { fetchImpl: async input => {
    if (String(input).endsWith("/api/auth/scopes")) return Response.json({ scopes: [] })
    throw Error("Unexpected route")
  } })
  const controller = createAuthBillingController(ctx, store.nextOrdinal, {
    current: () => { reads++; return answer.promise }, signInPath: "/api/auth/github"
  })
  await withVisibleHost(async ({ channels }) => {
    controller.watchIdentityAcrossTabs()
    expect(channels).toHaveLength(1)
    expect(channels[0]?.name).toBe("smithers.identity")
    ctx.identityChanged()
    expect(channels[0]?.posted).toEqual(["changed"])
    channels[0]?.onmessage?.({ data: { login: "impostor" } } as MessageEvent)
    await waitFor(() => reads === 1)
    answer.resolve(null)
    await waitFor(() => store.collections.identitySessions.get("identity")?.state === "signed-out")
    expect(store.collections.identitySessions.get("identity")?.login).toBeNull()
    await ctx.dispose()
    expect(channels[0]?.closed).toBe(true)
    expect(channels[0]?.onmessage).toBeNull()
    ctx.identityChanged()
    expect(channels[0]?.posted).toEqual(["changed"])
  }, async () => { answer.resolve(null); await ctx.dispose(); await store.dispose?.() }, true)
})
