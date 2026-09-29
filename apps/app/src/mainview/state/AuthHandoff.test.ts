import { describe, expect, test } from "bun:test"
import { scopedControllers } from "./ControllerTestScope"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"
import { json, memoryStorage, unavailableAgent } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * The native sign-in handoff: with the system-browser door (openExternal),
 * auth.sign-in mints a handoff, opens the OAuth start OUTSIDE the webview,
 * polls the claim until the session cookie lands, and re-probes the session.
 * Passkeys cannot run inside an embedded webview — this flow exists so they
 * never have to.
 */

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))
const until = async (predicate: () => boolean): Promise<void> => {
  for (let tick = 0; tick < 200 && !predicate(); tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const signedOut = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-out",
    login: null,
    allowlisted: false,
    admin: false,
    scopesPlain: null
  })
  await settled()
}

interface Harness {
  readonly store: AppStore
  readonly opened: string[]
  readonly requests: string[]
  readonly signIn: () => Promise<unknown>
  readonly dispose: () => Promise<void>
}

const harness = async (options: {
  readonly claims: ReadonlyArray<{ readonly status: number; readonly body: unknown }>
  readonly openResult?: boolean
  readonly startAnswer?: { readonly status: number; readonly body: unknown }
  /** What the session probe answers after a ready claim; default signed-in as will. */
  readonly sessionAnswer?: { readonly status: number; readonly body: unknown }
  readonly toastAutoDismissMs?: number
  /** While this returns true every claim answers pending, whatever the script says. */
  readonly holdClaims?: () => boolean
}): Promise<Harness> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const opened: string[] = []
  const requests: string[] = []
  const claims = [...options.claims]
  let handoffs = 0
  const services: AppServices = {
    baseUrl: "https://app.test",
    handoffPollMs: 1,
    ...(options.toastAutoDismissMs === undefined ? {} : { toastAutoDismissMs: options.toastAutoDismissMs }),
    openExternal: async (url) => {
      opened.push(url)
      return options.openResult ?? true
    },
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const path = new URL(url).pathname
      requests.push(`${init?.method ?? "GET"} ${path}`)
      if (path === "/api/auth/native/start") {
        handoffs += 1
        const answer = options.startAnswer ?? {
          status: 200,
          body: { handoffId: `handoff-${handoffs}`, pollSecret: `secret-${handoffs}`, expiresAt: Date.now() + 600_000 }
        }
        return json(answer.status, answer.body)
      }
      if (path === "/api/auth/native/claim") {
        if (options.holdClaims?.()) return json(200, { status: "pending" })
        const next = claims.length > 1 ? claims.shift() : claims[0]
        return json(next?.status ?? 404, next?.body ?? { status: "error", message: "expired" })
      }
      if (path === "/api/user") {
        // After a ready claim the cookie is in the jar: the probe answers signed-in.
        const answer = options.sessionAnswer ?? { status: 200, body: { id: 1, username: "will", is_admin: false } }
        return json(answer.status, answer.body)
      }
      return json(404, { status: "error", message: `no stub for ${path}` })
    }
  }
  const controller = createAppController(store, unavailableAgent, services)
  await signedOut(store)
  return { store, opened, requests, signIn: () => controller.commands.run("auth.sign-in"), dispose: async () => { await controller.dispose() } }
}

describe("the native sign-in handoff", () => {
  test("mints the handoff, opens the system browser at the bound OAuth start, claims, and lands signed in", async () => {
    const h = await harness({
      claims: [
        { status: 200, body: { status: "pending" } },
        { status: 200, body: { status: "ready" } }
      ]
    })
    await h.signIn()
    await until(() => h.store.collections.identitySessions.get("identity")?.state === "signed-in")
    expect(h.opened).toEqual(["https://app.test/api/auth/github?handoff=handoff-1"])
    expect(h.requests).toContain("POST /api/auth/native/start")
    expect(h.requests.filter((line) => line === "POST /api/auth/native/claim").length).toBeGreaterThanOrEqual(2)
    const identity = h.store.collections.identitySessions.get("identity")
    expect(identity?.state).toBe("signed-in")
    expect(identity?.login).toBe("will")
    const toasts = [...h.store.collections.toasts.values()]
    expect(toasts.some((toast) => toast.title === "Signed in")).toBe(true)
  })

  /*
   * 2026-09-01: "Signed in — Connected as roninjin10" stood for the rest of
   * the session. The handoff resolved its toast directly and skipped the
   * self-dismissal every other settled-ok toast gets; an ok toast offers no
   * dismiss control, so nothing could clear it.
   */
  test("the 'Signed in' toast dismisses itself like every settled-ok toast", async () => {
    const h = await harness({ claims: [{ status: 200, body: { status: "ready" } }], toastAutoDismissMs: 20 })
    await h.signIn()
    await until(() => h.store.collections.toasts.get("toast-auth.sign-in.handoff")?.title === "Signed in")
    expect(h.store.collections.toasts.get("toast-auth.sign-in.handoff")?.status).toBe("ok")
    await until(() => h.store.collections.toasts.get("toast-auth.sign-in.handoff") === undefined)
    expect(h.store.collections.toasts.get("toast-auth.sign-in.handoff")).toBeUndefined()
  })

  test("a reopen notice leaves on its own while the arc's toast keeps running", async () => {
    // The claim never readies: the arc stays in flight for the whole test.
    const h = await harness({ claims: [{ status: 200, body: { status: "pending" } }], toastAutoDismissMs: 20 })
    await h.signIn()
    await until(() => h.opened.length === 1)
    await h.signIn()
    await until(() => h.store.collections.toasts.get("toast-auth.sign-in.handoff.reopened") !== undefined)
    expect(h.store.collections.toasts.get("toast-auth.sign-in.handoff.reopened")?.status).toBe("ok")
    expect(h.store.collections.toasts.get("toast-auth.sign-in.handoff")?.status).toBe("running")
    await until(() => h.store.collections.toasts.get("toast-auth.sign-in.handoff.reopened") === undefined)
    // The notice's departure never took the running arc with it.
    expect(h.store.collections.toasts.get("toast-auth.sign-in.handoff")?.status).toBe("running")
  })

  test("a failed OAuth propagates the recorded reason and never fabricates a session", async () => {
    const h = await harness({
      claims: [{ status: 200, body: { status: "failed", message: "GitHub said no." } }]
    })
    await h.signIn()
    await until(() => [...h.store.collections.toasts.values()].some((toast) => toast.detail === "GitHub said no."))
    expect(h.store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
  })

  test("an expired handoff states itself honestly", async () => {
    const h = await harness({ claims: [{ status: 404, body: { status: "error", message: "expired" } }] })
    await h.signIn()
    await until(() =>
      [...h.store.collections.toasts.values()].some((toast) => (toast.detail ?? "").includes("expired"))
    )
    expect(h.store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
  })

  /*
   * The live failure (2026-08-30): two clicks minted two handoffs; the first
   * signed in, the second timed out five minutes later and overwrote the
   * "Signed in" toast with "Sign-in timed out".
   */
  test("a second sign-in while a handoff is pending reopens it instead of minting another", async () => {
    // The claim stays pending until the second click lands; a 1 ms poll must
    // not ready the handoff before the test gets to click again.
    let held = true
    const h = await harness({
      claims: [
        { status: 200, body: { status: "pending" } },
        { status: 200, body: { status: "ready" } }
      ],
      holdClaims: () => held
    })
    await h.signIn()
    await until(() => h.opened.length === 1)
    await h.signIn()
    await until(() => h.opened.length === 2)
    held = false
    // Same handoff, same browser page — never a second start.
    expect(h.opened).toEqual([
      "https://app.test/api/auth/github?handoff=handoff-1",
      "https://app.test/api/auth/github?handoff=handoff-1"
    ])
    expect(h.requests.filter((line) => line === "POST /api/auth/native/start")).toHaveLength(1)
    await until(() => h.store.collections.identitySessions.get("identity")?.state === "signed-in")
    await settled()
    const toast = [...h.store.collections.toasts.values()].find((entry) => entry.id === "toast-auth.sign-in.handoff")
    expect(toast?.status).toBe("ok")
    expect(toast?.title).toBe("Signed in")
    // A third click after success is the "already connected" answer, not a new handoff.
    await h.signIn()
    await settled()
    expect(h.requests.filter((line) => line === "POST /api/auth/native/start")).toHaveLength(1)
    const already = [...h.store.collections.toasts.values()].find(entry => entry.id === "toast-auth.sign-in.already")
    expect(already?.action).toEqual({ flow: "auth.sign-out", label: "Sign out" })
    expect(already?.detail).not.toContain("/auth.sign-out")
  })

  test("a ready claim whose session never lands says so instead of 'Signed in'", async () => {
    const h = await harness({
      claims: [{ status: 200, body: { status: "ready" } }],
      sessionAnswer: { status: 401, body: { code: "unauthenticated" } }
    })
    await h.signIn()
    await until(() =>
      [...h.store.collections.toasts.values()].some((toast) => (toast.detail ?? "").includes("didn't receive the session"))
    )
    const toast = [...h.store.collections.toasts.values()].find((entry) => entry.id === "toast-auth.sign-in.handoff")
    expect(toast?.status).toBe("failed")
    expect(toast?.title).not.toBe("Signed in")
    expect(h.store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
  })

  test("a claim that keeps erroring fails within three polls instead of reading as pending", async () => {
    const h = await harness({ claims: [{ status: 502, body: { status: "error", message: "identity upstream unreachable" } }] })
    await h.signIn()
    await until(() =>
      [...h.store.collections.toasts.values()].some((toast) => (toast.detail ?? "").includes("identity upstream unreachable"))
    )
    expect(h.requests.filter((line) => line === "POST /api/auth/native/claim")).toHaveLength(3)
    expect(h.store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
  })

  test("a browser that will not open fails the arc without polling", async () => {
    const h = await harness({ claims: [], openResult: false })
    await h.signIn()
    await until(() =>
      [...h.store.collections.toasts.values()].some((toast) =>
        (toast.detail ?? "").includes("browser couldn't be opened")
      )
    )
    expect(h.requests.filter((line) => line.includes("claim"))).toHaveLength(0)
  })
})


test("disposing a pending native handoff aborts and joins its poll before releasing the store", async () => {
  const h = await harness({ claims: [{ status: 200, body: { status: "pending" } }] })
  await h.signIn()
  expect(h.opened).toHaveLength(1)
  await h.dispose()
  const requests = [...h.requests]
  await settled()
  await settled()
  expect(h.requests).toEqual(requests)
})
