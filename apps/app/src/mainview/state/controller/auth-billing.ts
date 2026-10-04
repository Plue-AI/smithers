
import { accountProviderChanged } from "../AccountOwner"
import { identityProviderFor, signInByHandoff } from "../IdentityProvider"
import {


AUTH_LOGOUT_PATH,
AUTH_NATIVE_CLAIM_PATH,
AUTH_NATIVE_START_PATH,
AUTH_RETURN_TO_PARAM,
AUTH_SCOPES_PATH,
AUTH_SIGN_IN_PATH,
AUTH_SIGNED_IN_PARAM,
BILLING_BALANCE_PATH
} from "@smthrs/rpc/AgentApiRoutes"
import { signInReturnTo } from "../../RepoLink"
import type { ControllerContext } from "./context"
import type { FailureController } from "./failures"
import { TOAST_SUPERSEDED } from "./failures"
import type { ApplicationIdentityClient } from "../../runtime/ApplicationClient"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { presentAppFailure } from "./AppFailure"

/* Sign-out failures with no tagged cause. Reloading cannot finish either, so neither says to. */
const SIGN_OUT_UNCONFIRMED: UserFailureCopy = {
  fault: "infra",
  sentence: "Smithers could not confirm you are signed out. Not your fault. Try again.",
  actions: ["retry"]
}
const SIGN_OUT_CLEANUP_UNFINISHED: UserFailureCopy = {
  fault: "infra",
  sentence: "Smithers could not finish clearing this browser's data. Not your fault.",
  actions: ["retry", "reset-local-data"]
}

/** One address, loosely: the browser's own `type="email"` check is the strict one. */
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface AuthBillingController {
  readonly handleAuthReturn: (search: string) => boolean
  readonly adoptSession: (session: ResolvedSession) => Promise<void>
  readonly loadSession: () => Promise<void>
  readonly signIn: (reservedOpen?: (url: string) => Promise<boolean>) => Promise<void> | void
  readonly signInWithEmail: (email: string) => string | void
  readonly signOut: () => Promise<string | void>
  readonly refreshBalance: () => Promise<void>
  readonly settleTurnBilling: () => void
  readonly watchIdentityAcrossTabs: () => void
}

export interface ResolvedSession {
  readonly state: "signed-in" | "signed-out" | "unavailable"
  readonly login: string | null
  /** The profile name `GET /api/user` returned; it only prefills the signup's Full name. */
  readonly displayName?: string
  readonly admin: boolean
  readonly scopes?: "degraded" | null
}

export interface SelectedBackendIdentity extends ApplicationIdentityClient {
  readonly signInPath: string
  readonly settled?: () => void
}

export const createAuthBillingController = (
  ctx: ControllerContext,
  selectedIdentity?: SelectedBackendIdentity,
  openLocalAuth?: () => boolean
): AuthBillingController => {
  const { store, services, baseUrl, boundedFetch: http, errorMessageOf, unref } = ctx
  const balanceAvailable = services.bootstrap?.capabilities.includes("billing.balance") ?? true
  // Only a session validated during this controller lifetime can complete login.
  // A hydrated identity row, local capability or cloud PAT is not proof.
  let disposed = false
  ctx.onDispose(() => { disposed = true })
  // The context declares the announcing arity; the controller behind it is the
  // one createFailureController returns, quiet mode included.
  const withToast: FailureController["withToast"] = ctx.withToast
  /*
   * An account answer lands only on the account that asked. Sign-out and
   * another login advance the account epoch, so a reply after that describes
   * an account this page no longer holds: it writes nothing and its toast
   * leaves without a result.
   */
  const admitAccount = (): (() => boolean) => {
    const epoch = ctx.accountEpoch
    return () => !ctx.disposed && ctx.accountEpoch === epoch
  }
  const resumeWorkflowRuns = (): void => ctx.resumeWorkflowRuns()
  const resumeDeferredCommand = (): void => ctx.resumeDeferredCommand()
  const settleFirstRunTarget = (): void => ctx.settleFirstRunTarget()
  const mirrorSelectedCloud = async (session: ResolvedSession, current?: () => boolean): Promise<void> => {
    if (ctx.disposed || current?.() === false || selectedIdentity === undefined || session.state === "unavailable") return
    await store.dispatch({
      type: "cloud.session.loaded",
      actor: "system",
      state: session.state,
      username: session.login,
      expiresAt: null,
      scopes: session.state === "signed-in" ? session.scopes ?? null : null
    }).isPersisted.promise
    if (!ctx.disposed && current?.() !== false) selectedIdentity.settled?.()
  }
  /*
   * Session reads race: window focus, a sibling tab and a 401 each start one.
   * Only the latest read may write the row, and a sign-out outranks every read
   * already out. This sequence is private to the identity seam; the account
   * generation (`ctx.accountEpoch`) moves only when the written owner changes.
   */
  let probe = 0
  // A definitive owner change revokes the old turn before any asynchronous
  // follow-up can deliver frames or restart a pending leg. Availability alone
  // does not revoke ownership: the persisted owner survives an outage.
  const fenceAccountTurn = (nextOwner: string | null, force = false): void => {
    if (!force && ctx.accountOwner() === nextOwner) return
    const turn = ctx.activeTurn
    ctx.activeTurn = undefined
    if (turn !== undefined) void ctx.agent.cancelTurn(turn.id).catch(error => ctx.failures.report("turn.cancel", error, turn.id))
  }
  /**
   * Returning from a failed OAuth redirect is a chat message, never a bare
   * page. Returning from a finished one carries `?signed-in=github` on
   * whichever page asked (`/` or `/owner/name`); the session probe already
   * says who signed in, so the marker is only reported as handled and the
   * boot strips it from the address bar.
   */
  const handleAuthReturn = (search: string): boolean => {
    const params = new URLSearchParams(search)
    if (params.has(AUTH_SIGNED_IN_PARAM)) return true
    const auth = params.get("auth")
    if (auth !== "failed" && auth !== "error") return false
    store.dispatch({
      type: "message.appended",
      actor: "system",
      text: "GitHub sign-in didn't finish — nothing was signed in. Try again whenever you're ready.",
      action: { flow: "auth.sign-in", label: "Try sign-in again" }
    })
    return true
  }

  /*
   * Identity seam. Only definitive answers gate the app: a signed-out
   * response drives the landing state; "unavailable" (seam
   * unset or unreachable) is recorded honestly but never blocks the surface.
   */
  const fetchScopesPlain = async (signal?: AbortSignal): Promise<string | null> => {
    try {
      const response = await http(`${baseUrl}${AUTH_SCOPES_PATH}`, { signal })
      if (!response.ok) {
        await response.body?.cancel()
        return null
      }
      const body = (await response.json()) as { scopes?: unknown }
      if (!Array.isArray(body.scopes)) return null
      const plains = body.scopes
        .map((scope) =>
          typeof scope === "object" && scope !== null && "plain" in scope && typeof scope.plain === "string"
            ? scope.plain.trim()
            : ""
        )
        .filter((plain) => plain !== "")
      if (plains.length === 0) return null
      // The identity worker writes each scope as a whole sentence
      // ("See your GitHub profile — your username, name, and avatar."), so
      // they are stated after a lead-in, never spliced into one.
      return `Before GitHub asks, here is what Smithers will use: ${plains.join(" ")}`
    } catch {
      return null
    }
  }

  const dispatchSignedOut = async (mine: number, signal?: AbortSignal): Promise<void> => {
    if (ctx.disposed || probe !== mine || signal?.aborted) return
    fenceAccountTurn(null)
    const scopesPlain = selectedIdentity === undefined ? await fetchScopesPlain(signal) : null
    if (ctx.disposed || probe !== mine || signal?.aborted) return
    await store.dispatch({
      type: "identity.session.loaded",
      provider: identityProviderFor(services),
      actor: "system",
      state: "signed-out",
      login: null,
      admin: false,
      scopesPlain
    }).isPersisted.promise
    await mirrorSelectedCloud({ state: "signed-out", login: null, admin: false })
    // The read that WRITES the row makes the first run's target choice: a read
    // that returned at its probe guard has none to make, so a boot read raced
    // by a focus re-read (watchIdentityAcrossTabs) leaves no command parked.
    settleFirstRunTarget()
  }

  const dispatchUnavailable = (): void => {
    if (ctx.disposed) return
    store.dispatch({
      type: "identity.session.loaded",
      provider: identityProviderFor(services),
      actor: "system",
      state: "unavailable",
      login: null,
      admin: false,
      scopesPlain: null
    })
    settleFirstRunTarget()
  }

  const finishSignedInSession = async (
    session: Pick<ResolvedSession, "login" | "displayName" | "admin" | "scopes">,
    previous: ReturnType<typeof store.collections.identitySessions.get>,
    mine: number
  ): Promise<void> => {
    if (ctx.disposed || probe !== mine) return
    const providerChanged = accountProviderChanged(previous?.provider, identityProviderFor(services))
    fenceAccountTurn(session.login, providerChanged)
    const persisted = store.dispatch({
      type: "identity.session.loaded",
      provider: identityProviderFor(services),
      actor: "system",
      state: "signed-in",
      login: session.login,
      ...(session.displayName ? { displayName: session.displayName } : {}),
      admin: session.admin,
      scopesPlain: null
    })
    await persisted.isPersisted.promise
    if (ctx.disposed || probe !== mine) return
    await mirrorSelectedCloud({ state: "signed-in", ...session })
    if (ctx.disposed || probe !== mine) return
    if (previous?.state !== "signed-in" || previous.login !== session.login || providerChanged) ctx.identityChanged()
    // The balance read is driven by the session answer, not fired blind at
    // boot: signed out it could only come back 401 — the expected state,
    // logged by the browser as a console error anyway.
    void refreshBalanceSilently()
    if (disposed || probe !== mine) return
    // Wave 11: a live run card's event pump resumes from its lastSeq.
    resumeWorkflowRuns()
    // The signed-in answer can satisfy a parked command's requirement — the
    // command that deferred into this sign-in continues here, across the
    // OAuth redirect.
    resumeDeferredCommand()
  }

  const adoptSession = async (session: ResolvedSession): Promise<void> => {
    if (ctx.disposed) return
    const mine = ++probe
    const previous = store.collections.identitySessions.get("identity")
    if (session.state === "signed-in" && typeof session.login === "string" && session.login.trim() !== "") {
      await finishSignedInSession(session, previous, mine)
      return
    }
    if (session.state === "signed-out") {
      /*
       * The server renderer resolves the session but never the consent copy,
       * so an adopted signed-out answer must make the same scopes read the
       * client-probe path makes. Adopting with a bare null told every
       * signed-out web visitor "the identity service isn't configured" on a
       * deployment where it is.
       */
      await dispatchSignedOut(mine)
      return
    }
    dispatchUnavailable()
  }

  const loadSession = async (signal?: AbortSignal): Promise<void> => {
    if (ctx.disposed || signal?.aborted) return
    const mine = ++probe
    const previous = store.collections.identitySessions.get("identity")
    if (selectedIdentity !== undefined) {
      let identity: Awaited<ReturnType<ApplicationIdentityClient["current"]>>
      try {
        identity = await selectedIdentity.current(signal)
      } catch {
        if (probe !== mine || signal?.aborted) return
        dispatchUnavailable()
        return
      }
      if (probe !== mine || signal?.aborted) return
      if (identity === null) {
        await dispatchSignedOut(mine, signal)
        return
      }
      await finishSignedInSession({
        login: identity.username,
        displayName: identity.displayName,
        admin: identity.admin,
        scopes: identity.scopes
      }, previous, mine)
      return
    }
    dispatchUnavailable()
  }
  ctx.loadSession = loadSession

  /*
   * The native sign-in handoff (device-flow style): the embedded webview has
   * no platform authenticator, so GitHub passkeys CANNOT complete inside it
   * (the live failure: GitHub's cross-device Bluetooth fallback dying in the
   * window). OAuth runs in the SYSTEM browser instead — start mints a
   * one-time handoff, openExternal launches the browser at the OAuth start
   * bound to it, and the page polls the claim same-origin until the session
   * cookie lands in the app's own jar. One toast narrates the whole arc.
   */
  const handoffPollMs = services.handoffPollMs ?? 2000
  /*
   * ONE handoff at a time. The live failure (2026-08-30): two "Sign in"
   * clicks twelve seconds apart minted two handoffs. The first finished in
   * the browser and its loop toasted "Signed in"; the second was never
   * completed, polled for its full five minutes, and then wrote "Sign-in
   * timed out" over the SAME toast — so the app announced a timeout for a
   * sign-in that had succeeded. A second click while a handoff is pending now
   * reopens the pending handoff's browser page instead of minting another,
   * and a loop that has been superseded (or whose session already arrived)
   * exits without touching the toast.
   */
  let pendingHandoff: { readonly generation: number; readonly url: string } | undefined
  let handoffGeneration = 0
  const nativeSignIn = async (openExternal: (url: string) => Promise<boolean>): Promise<void> => {
    const key = "auth.sign-in.handoff"
    if (pendingHandoff !== undefined) {
      const pending = pendingHandoff
      const noticeKey = `${key}.reopened`
      if (pending.url === "") {
        const title = "Preparing sign-in…"
        store.dispatch({ type: "toast.shown", actor: "system", key: noticeKey, title })
        ctx.resolveToast(noticeKey, {
          status: "ok", title,
          detail: "Sign-in is being prepared — your browser will open when it's ready."
        })
        return
      }
      const reopened = await openExternal(pending.url)
      if (pendingHandoff?.generation !== pending.generation) return
      // The arc's own toast keeps running under `key` — the sign-in is still
      // in flight. The reopen is a notice beside it: settled ok, it leaves on
      // its own; a page that would not reopen stays until dismissed.
      store.dispatch({ type: "toast.shown", actor: "system", key: noticeKey, title: "Finishing sign-in in your browser…" })
      ctx.resolveToast(noticeKey, {
        status: reopened ? "ok" : "failed",
        title: "Finishing sign-in in your browser…",
        detail: reopened
          ? "That sign-in is still open in your browser — finish it there."
          : "That sign-in is still open in your browser, but the page couldn't be reopened."
      })
      return
    }
    const generation = ++handoffGeneration
    // A superseded loop never writes: only the newest handoff's outcome is the truth.
    const current = (): boolean => !ctx.disposed && pendingHandoff?.generation === generation
    const abort = new AbortController()
    let wake: (() => void) | undefined
    let polling: Promise<void> | undefined
    const settle = (status: "ok" | "failed", title: string, detail: string): void => {
      if (!current()) return
      pendingHandoff = undefined
      // The arc's outcome is always shown, even if its toast has gone.
      if (store.collections.toasts.get(`toast-${key}`) === undefined) {
        store.dispatch({ type: "toast.shown", actor: "system", key, title })
      }
      ctx.resolveToast(key, { status, title, detail })
    }
    const fail = (detail: string): void => settle("failed", "Sign-in didn't finish", detail)
    // Reserve the slot before the first await so a second click during the
    // start request joins this handoff instead of racing it.
    pendingHandoff = { generation, url: "" }
    ctx.onDispose(async () => {
      if (pendingHandoff?.generation === generation) {
        handoffGeneration += 1
        pendingHandoff = undefined
      }
      wake?.()
      abort.abort()
      await polling
    })
    if (!current()) return
    store.dispatch({ type: "toast.shown", actor: "system", key, title: "Finishing sign-in in your browser…" })
    let start: { handoffId?: unknown; pollSecret?: unknown } | undefined
    try {
      const response = await http(`${baseUrl}${AUTH_NATIVE_START_PATH}`, { method: "POST", signal: abort.signal })
      if (!current()) return
      if (!response.ok) {
        fail(await errorMessageOf(response, "Sign-in couldn't start. Try again."))
        return
      }
      start = (await response.json().catch(() => undefined)) as typeof start
    } catch {
      fail("Sign-in couldn't start — the identity service didn't answer.")
      return
    }
    if (!current()) return
    if (typeof start?.handoffId !== "string" || typeof start.pollSecret !== "string") {
      fail("Sign-in couldn't start — the identity service answered in an unexpected shape.")
      return
    }
    const origin = baseUrl !== "" ? baseUrl : typeof window === "undefined" ? "" : window.location.origin
    const url = `${origin}${selectedIdentity?.signInPath ?? AUTH_SIGN_IN_PATH}?handoff=${encodeURIComponent(start.handoffId)}`
    pendingHandoff = { generation, url }
    const opened = await openExternal(url)
    if (!current()) return
    if (!opened) {
      fail("Your browser couldn't be opened. Try again.")
      return
    }
    // The command settles when its handoff has opened. Authentication itself
    // is a separately observed session outcome. Keep the poll owned and joined
    // by this controller, so another sign-in gesture can reopen the same slot.
    const poll = async (): Promise<void> => {
      // ~5 minutes of patience: OAuth in another app takes as long as it takes.
      let consecutiveErrors = 0
      for (let attempt = 0; attempt < 150 && current(); attempt += 1) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => wake?.(), handoffPollMs)
          wake = () => {
            clearTimeout(timer)
            wake = undefined
            resolve()
          }
          unref(timer)
        })
        if (!current()) return
        // The session may arrive by another door (a sibling tab, a focus
        // re-read): a signed-in identity ends the wait as success, not timeout.
        if (store.collections.identitySessions.get("identity")?.state === "signed-in") {
          settle("ok", "Signed in", `Connected as ${store.collections.identitySessions.get("identity")?.login ?? "you"}.`)
          return
        }
        let claim: Response
        try {
          claim = await http(`${baseUrl}${AUTH_NATIVE_CLAIM_PATH}`, {
            method: "POST",
            signal: abort.signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ handoffId: start.handoffId, pollSecret: start.pollSecret })
          })
        } catch {
          continue // A dropped poll is not a failed sign-in.
        }
        if (!current()) return
        if (claim.status === 404) {
          fail("That sign-in expired — try again.")
          return
        }
        const body = (await claim.json().catch(() => undefined)) as
          | { status?: unknown; message?: unknown }
          | undefined
        if (!current()) return
        if (!claim.ok) {
          /*
           * An erroring claim used to read as "pending" and poll for the full
           * five minutes. Three in a row is an answer: the seam is refusing,
           * and the toast says what it said.
           */
          consecutiveErrors += 1
          if (consecutiveErrors >= 3) {
            fail(
              typeof body?.message === "string"
                ? `Sign-in couldn't be confirmed: ${body.message}`
                : `Sign-in couldn't be confirmed — the identity service answered ${claim.status}.`
            )
            return
          }
          continue
        }
        consecutiveErrors = 0
        if (body?.status === "pending") continue
        if (body?.status === "ready") {
          // The claim's Set-Cookie should now be in the jar; only the session probe can say so.
          await loadSession(abort.signal)
          if (!current()) return
          const identity = store.collections.identitySessions.get("identity")
          if (identity?.state === "signed-in") {
            settle("ok", "Signed in", `Connected as ${identity.login ?? "you"}.`)
          } else {
            fail(
              "Your browser finished the GitHub sign-in, but this app didn't receive the session — the sign-in cookie never reached it. Try again; if it repeats, that is a bug to report."
            )
          }
          return
        }
        if (body?.status === "failed") {
          fail(typeof body.message === "string" ? body.message : "Sign-in didn't finish. Try again.")
          return
        }
        fail("Sign-in couldn't be confirmed — the identity service answered in an unexpected shape.")
        return
      }
      fail("Sign-in timed out — try again whenever you're ready.")
    }
    polling = poll()
    void polling.catch(() => {})

  }

  /*
   * Sign-in navigates ONLY when the identity seam has answered that it
   * exists (multi's startSignIn discipline): navigating blindly off a build
   * with no seam just reloads the SPA — a flash with no answer, which reads
   * as a silent failure. Every refusal states itself as a toast. With the
   * native shell's openExternal door, sign-in runs the handoff instead of
   * navigating: the webview page survives, and passkeys work in the real
   * browser.
   */
  const signIn = (reservedOpen?: (url: string) => Promise<boolean>): Promise<void> | void => {
    if (ctx.disposed) return
    const identity = store.collections.identitySessions.get("identity")
    const toast = (key: string, title: string, detail: string): void => {
      store.dispatch({ type: "toast.shown", actor: "system", key, title })
      store.dispatch({ type: "toast.resolved", actor: "system", key, status: "failed", detail })
    }
    if (identity?.state === "signed-in") {
      const key = "auth.sign-in.already"
      store.dispatch({ type: "toast.shown", actor: "system", key, title: `Connected as ${identity.login ?? "you"}` })
      store.dispatch({ type: "toast.resolved", actor: "system", key, status: "ok", detail: identityProviderFor(services) === "github" ? "GitHub is connected." : "Signed in.",
        action: { flow: "auth.sign-out", label: "Sign out" } })
      return
    }
    if (openLocalAuth?.() === true) return
    if (identity === undefined || identity.state === "unavailable") {
      toast(
        "auth.sign-in.unavailable",
        "Sign-in isn't available on this build",
        "No identity service is configured here — use the deployed app to sign in."
      )
      return
    }
    if (identity.state === "unknown") {
      toast(
        "auth.sign-in.pending",
        "Still checking sign-in availability",
        "The identity service hasn't answered yet — try again in a moment."
      )
      return
    }
    // Reserve the popup synchronously in the keyboard/button gesture. OAuth
    // finishes on the upstream; the claim transfers its cookie to this origin.
    const popup = reservedOpen === undefined && services.openExternal === undefined && signInByHandoff(services.bootstrap) && typeof window !== "undefined"
      ? window.open("about:blank", "smithers-github-sign-in") : null
    if (popup) popup.opener = null
    const openExternal = reservedOpen ?? services.openExternal ?? (signInByHandoff(services.bootstrap)
      ? async (url: string) => {
        if (!popup || popup.closed) return false
        popup.location.href = url
        return true
      } : undefined)
    if (openExternal !== undefined) {
      return nativeSignIn(openExternal)
    }
    if (typeof window === "undefined") return
    // A repository page returns to itself; the landing needs a success marker
    // so its entrance resumes onboarding without a second Get started click.
    // The server validates either path against its own origin.
    const returnTo = window.location.pathname === "/" ? `/?${AUTH_SIGNED_IN_PARAM}=github` : signInReturnTo(window.location)
    const query = returnTo === null ? "" : `?${AUTH_RETURN_TO_PARAM}=${encodeURIComponent(returnTo)}`
    // The hop leaves the page: let the durable queue settle, or the state this click just changed is lost.
    return Promise.resolve(store.settled?.()).then(() => {
      if (!ctx.disposed) window.location.assign(`${baseUrl}${selectedIdentity?.signInPath ?? AUTH_SIGN_IN_PATH}${query}`)
    })
  }

  /*
   * The login screen's email door (Will, 2026-10-03). No identity seam signs
   * an email address in yet: the hosted session is GitHub OAuth, and self-host
   * takes the owner's credentials. The answer is one toast naming that, with
   * the GitHub door on it, never a silent redirect into GitHub (#3704).
   */
  const signInWithEmail = (email: string): string | void => {
    if (ctx.disposed) return
    if (!EMAIL_ADDRESS.test(email.trim())) return "Enter an email address."
    const key = "auth.email.unavailable"
    store.dispatch({ type: "toast.shown", actor: "system", key, title: "Email sign-in isn't available yet" })
    store.dispatch({ type: "toast.resolved", actor: "system", key, status: "failed", detail: "Continue with GitHub for now.",
      action: { flow: "auth.sign-in", label: "Continue with GitHub" } })
  }

  // Logout responses can clear cookies even on HTTP failure. An obsolete
  // request cannot retire the new account itself; only a fresh session answer
  // may establish that the browser's current credential was actually removed.
  const reconcileLogout = async (): Promise<string | void> => {
    if (ctx.disposed) return
    try { await loadSession() }
    catch (error) {
      if (!ctx.disposed) return presentAppFailure(error, unknown => ctx.failures.report("command.boundary", unknown, "auth.sign-out"), SIGN_OUT_UNCONFIRMED).sentence
    }
  }

  const signOut = async (): Promise<string | void> => {
    if (ctx.disposed) return
    const current = admitAccount()
    let response: Response
    try {
      response = await http(`${baseUrl}${AUTH_LOGOUT_PATH}`, { method: "POST" })
    } catch {
      const failure = await reconcileLogout()
      return failure ?? (current() ? "Sign-out could not be confirmed." : undefined)
    }
    void response.body?.cancel().catch(() => {})
    if (!current()) return reconcileLogout()
    if (!response.ok) {
      const failure = await reconcileLogout()
      return failure ?? (current() ? "Sign-out could not be confirmed." : undefined)
    }
    // Every session read already out describes the account this act ends.
    probe += 1
    ctx.endAccount()
    fenceAccountTurn(null, true)
    let retired = admitAccount()
    try {
      const cleared = store.dispatch({ type: "identity.session.cleared", actor: "user" })
      retired = admitAccount()
      await cleared.isPersisted.promise
    } catch (error) {
      if (retired()) return `Signed out. ${presentAppFailure(error, unknown => ctx.failures.report("command.boundary", unknown, "auth.sign-out"), SIGN_OUT_CLEANUP_UNFINISHED).sentence}`
      return
    }
    if (!retired()) return
    await mirrorSelectedCloud({ state: "signed-out", login: null, admin: false }, retired)
    if (retired()) ctx.identityChanged()
  }

  /**
   * Billing seam: dollars only; chat is complimentary, so a definitive $0
   * never pauses it. A reply that arrives after the account moved or the
   * controller closed is TOAST_SUPERSEDED, not success: it describes an
   * account the app no longer has open, so nothing is written and the toast
   * leaves without a result.
   */
  const refreshBalanceImpl = async (): Promise<true | typeof TOAST_SUPERSEDED | string> => {
    const identity = store.collections.identitySessions.get("identity")
    const epoch = ctx.accountEpoch
    const identityState = identity?.state
    const login = identity?.login
    const current = (): boolean => {
      if (ctx.disposed) return false
      const latest = store.collections.identitySessions.get("identity")
      return ctx.accountEpoch === epoch && latest?.state === identityState && latest?.login === login
    }
    let response: Response
    try {
      response = await http(`${baseUrl}${BILLING_BALANCE_PATH}`)
    } catch {
      if (!current()) return TOAST_SUPERSEDED
      store.dispatch({ type: "billing.unavailable", actor: "system" })
      return "Your balance couldn't be refreshed — the billing service didn't answer."
    }
    if (!current()) return TOAST_SUPERSEDED
    if (!response.ok) {
      await response.body?.cancel()
      store.dispatch({ type: "billing.unavailable", actor: "system" })
      return "Your balance couldn't be refreshed right now."
    }
    const body = (await response.json().catch(() => undefined)) as
      | {
        state?: unknown
        allowedToStartWork?: unknown
        balance?: { totalUsd?: unknown; lifetimeChargedUsd?: unknown; chargeCount?: unknown }
      }
      | undefined
    if (!current()) return TOAST_SUPERSEDED
    const state = body?.state
    if (
      body === undefined ||
      (state !== "ok" && state !== "low" && state !== "empty") ||
      typeof body.allowedToStartWork !== "boolean" ||
      typeof body.balance?.totalUsd !== "string"
    ) {
      store.dispatch({ type: "billing.unavailable", actor: "system" })
      return "Your balance couldn't be refreshed right now."
    }
    store.dispatch({
      type: "billing.refreshed",
      actor: "system",
      state,
      totalUsd: body.balance.totalUsd,
      allowedToStartWork: body.allowedToStartWork,
      lifetimeChargedUsd: typeof body.balance.lifetimeChargedUsd === "string" ? body.balance.lifetimeChargedUsd : "0",
      chargeCount: typeof body.balance.chargeCount === "number" ? body.balance.chargeCount : 0
    })
    return true
  }

  /*
   * A read nobody asked for runs quiet: no notice while it reads and no
   * result when it lands, because nothing on screen changed that a sentence
   * could name. A failure still states itself and the next quiet read that
   * succeeds takes it back down, and the read a user asks for keeps its
   * notice, its result, and the toast slot both reads share.
   */
  const readBalance = (announce: boolean): Promise<void> =>
    !balanceAvailable ? Promise.resolve() : withToast("billing.balance.refresh", "Refreshing your balance…", "Balance is up to date", refreshBalanceImpl, !announce)
      .then(() => undefined)

  /** The balance the user asked for: the read states its result. */
  const refreshBalance = (): Promise<void> => readBalance(true)

  /*
   * A session load, a settled turn: the next balance card is fresh and the
   * toast stack stays empty. Signed out there is no balance to read — the
   * seam refuses a session it never validated with sign_in_required, the
   * expected answer, and an anonymous turn on a public repository would earn
   * that refusal after every message. "unavailable" still reads: a native
   * deployment authenticates billing with its own bearer and has no session.
   */
  const refreshBalanceSilently = (): Promise<void> =>
    store.collections.identitySessions.get("identity")?.state === "signed-out"
      ? Promise.resolve()
      : readBalance(false)

  /*
   * Chat is complimentary during the alpha: the billing seam records each
   * turn's true cost and debits zero, so the UI carries NO per-turn dollar
   * line. The balance chip still refreshes from the real answer after a turn.
   */
  const settleTurnBilling = (): void => {
    void refreshBalanceSilently()
  }

  /*
   * §2.5 / §23.4 — identity is shared between tabs; the app's copy of it was
   * not. The session cookie is per-origin, so signing in on one tab signs in
   * every tab, yet a tab that had already read `/api/user` kept
   * rendering the signed-out card until someone reloaded it by hand — and the
   * same asymmetry ran the other way after a sign-out.
   *
   * A tab re-reads the session whenever it comes back to the foreground, and
   * a tab that changes identity itself tells its siblings at once. This is a
   * host subscription, not React lifecycle, so it lives with the state it
   * corrects.
   */
  const IDENTITY_CHANNEL = "smithers.identity"
  const watchIdentityAcrossTabs = (): void => {
    if (typeof document === "undefined" || typeof window === "undefined") return
    let reading = false
    const reread = (): void => {
      if (ctx.disposed || reading || document.visibilityState === "hidden") return
      reading = true
      void loadSession().catch(error => {
        // Failed privacy retirement closes the controller and has its own
        // host recovery surface. Never leak its raw storage error globally.
        if (!ctx.disposed && store.privacyWriteState() !== "failed") ctx.failures.report("command.boundary", error, "identity.refresh")
      }).finally(() => {
        reading = false
      })
    }
    document.addEventListener("visibilitychange", reread)
    window.addEventListener("focus", reread)
    // Everything opened here is released when the controller's scope closes.
    ctx.onDispose(() => {
      document.removeEventListener("visibilitychange", reread)
      window.removeEventListener("focus", reread)
    })
    if (typeof BroadcastChannel === "undefined") return
    const channel = new BroadcastChannel(IDENTITY_CHANNEL)
    channel.onmessage = () => {
      // A sibling's identity changed: re-read the seam rather than trust
      // the message — the cookie is the authority, not the announcement.
      reread()
    }
    ctx.onDispose(() => {
      channel.onmessage = null
      channel.close()
      ctx.identityChanged = () => {}
    })
    ctx.identityChanged = () => {
      channel.postMessage("changed")
    }
  }

  return {
    handleAuthReturn,
    adoptSession,
    loadSession,
    signIn,
    signInWithEmail,
    signOut,
    refreshBalance,
    settleTurnBilling,
    watchIdentityAcrossTabs
  }
}
