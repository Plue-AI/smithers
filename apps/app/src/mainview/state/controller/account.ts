import { installRequestId } from "../seams/InstallRequestId"
/*
 * The account card's controller half (factory mock 21, design session §6c):
 * `account.show` renders who is signed in as one read-only card of seam
 * facts. Every row comes from a seam the app already has: the identity
 * session (login, allowlist answer, access request), the identity worker's
 * scopes read (GET /api/auth/scopes, the same read the signed-out consent
 * copy makes), and the cloudWorkspaces collection (the boxes the workspaces
 * seam has listed, across every repository). A row whose seam did not answer
 * is absent. No billing, usage or seat rows exist because no seam holds them.
 *
 * Signed out, the card IS the sign-in step: the flow renders auth.prompt's
 * message, never an empty account.
 */
import { AUTH_SCOPES_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { actorSharedState } from "../ActorBindings"
import type { Card } from "../AppState"
import type { ControllerContext } from "./context"
import { TOAST_SUPERSEDED } from "./failures"

export interface AccountController {
  /** The `account.show` handler: the account card, or the sign-in step when no session is signed in. */
  readonly showAccount: () => Promise<string | { readonly value: string }>
  readonly resumeAccount: () => void
}

export interface AccountControllerDeps {
  readonly provider: "github" | "local"
  /**
   * Whether this origin serves the identity worker's scopes read
   * (GET /api/auth/scopes). A selected backend identity (the canonical user
   * API, `services.applicationIdentity`) has no such route, so its card
   * states the sign-in scope alone and asks nothing more.
   */
  readonly readsScopes: boolean
  /** The next transcript ordinal — the card surfaces at the end, never mid-history. */
  readonly nextOrdinal: () => number
  /** auth.prompt's renderer: the sign-in step as a message whose action is the sign-in button. */
  readonly promptSignIn: (required?: boolean, request?: { readonly name: string }) => void
}

/** The one card: re-surfaced at the end of the transcript each time it is asked for. */
export const ACCOUNT_CARD_ID = "account"

/** What the tool result says when the flow answered signed out; the model tells the human to click, never to type. */
export const SIGNED_OUT_VALUE = "signed out: the sign-in step is in the chat"

/** The honest refusal while the identity seam has not answered yet. */
export const IDENTITY_PENDING_TEXT = "Still checking who is signed in. Try again in a moment."

interface ScopeRow {
  readonly scope: string
  readonly plain: string
}

type AccountCard = Extract<Card, { kind: "account" }>
type Answer = string | { readonly value: string }
interface Flight {
  readonly id: string
  readonly epoch: number
  readonly owner: string
  admission: Promise<Answer>
}
const REQUESTED = { value: "Requested" } as const

export const createAccountController = (ctx: ControllerContext, deps: AccountControllerDeps): AccountController => {
  const { store } = ctx
  const refreshes = deps.provider === "github" && deps.readsScopes
  const reads = actorSharedState(ctx, "account.reads", () => ({ flight: undefined as Flight | undefined }))
  const card = (): AccountCard | undefined => {
    const row = store.collections.cards.get(ACCOUNT_CARD_ID)
    return row?.kind === "account" ? row : undefined
  }
  const superseded = () => ({ value: "Account request is no longer current." })
  const owns = (flight: Flight): boolean => !ctx.disposed && reads.flight === flight && flight.epoch === ctx.accountEpoch &&
    ctx.accountOwner() === flight.owner && store.collections.identitySessions.get("identity")?.state === "signed-in"

  const readScopes = async (): Promise<{ scopes: ScopeRow[] } | { error: string }> => {
    try {
      const response = await ctx.boundedFetch(`${ctx.baseUrl}${AUTH_SCOPES_PATH}`)
      if (!response.ok) {
        await response.body?.cancel()
        return { error: `Permissions could not be loaded (HTTP ${response.status}).` }
      }
      const body: unknown = await response.json()
      if (typeof body !== "object" || body === null || !("scopes" in body) || !Array.isArray(body.scopes)) return { error: "Invalid permission response." }
      const scopes: ScopeRow[] = []
      const seen = new Set<string>()
      for (const row of body.scopes) {
        if (typeof row !== "object" || row === null || typeof row.scope !== "string" || typeof row.plain !== "string" ||
            row.scope.trim() === "" || row.plain.trim() === "" || seen.has(row.scope.trim())) return { error: "Invalid permission response." }
        seen.add(row.scope.trim())
        scopes.push({ scope: row.scope.trim(), plain: row.plain.trim() })
      }
      return { scopes }
    } catch { return { error: "Permissions could not be loaded." } }
  }

  const launch = (flight: Flight): void => {
    const currentRequest = () => owns(flight) && card()?.payload.refresh?.id === flight.id
    void ctx.withToast("account.permissions", "Loading permissions…", "Permissions loaded", async () => {
      if (!currentRequest()) return TOAST_SUPERSEDED
      const answer = await readScopes()
      if (!owns(flight)) return TOAST_SUPERSEDED
      const current = card()
      if (current?.payload.refresh?.id !== flight.id || current.payload.refresh.state !== "requested") return TOAST_SUPERSEDED
      const failed = "error" in answer
      await store.dispatch({ type: "card.upsert", actor: "system", card: { ...current, status: failed ? "error" : "active", payload: {
        ...current.payload, scopes: failed ? [] : answer.scopes,
        refresh: failed ? { id: flight.id, state: "failed", error: answer.error } : { id: flight.id, state: "complete" }
      } } }).isPersisted.promise
      if (!currentRequest()) return TOAST_SUPERSEDED
      return failed ? answer.error : true
    }, false, currentRequest, ACCOUNT_CARD_ID).then(outcome => {
      if (!currentRequest()) {
        if (reads.flight === flight) reads.flight = undefined
        return
      }
      if (typeof outcome === "string") ctx.resolveToast("account.permissions", { status: "failed", detail: outcome, action: { flow: "account.show", label: "Retry" } })
      reads.flight = undefined
    }).catch(error => {
      const current = currentRequest()
      if (reads.flight === flight) reads.flight = undefined
      if (current) ctx.failures.report("toast.work", error, "account.permissions")
    })
  }

  const resumeAccount = (): void => {
    if (ctx.disposed || !refreshes) return
    const identity = store.collections.identitySessions.get("identity"), current = card()
    if (identity?.state !== "signed-in" || identity.login === null || current?.payload.login !== identity.login ||
        current.payload.provider !== deps.provider || current.payload.refresh?.state !== "requested") return
    if (reads.flight && owns(reads.flight)) return
    const flight: Flight = { id: current.payload.refresh.id, epoch: ctx.accountEpoch, owner: identity.login, admission: Promise.resolve(REQUESTED) }
    reads.flight = flight
    launch(flight)
  }

  const showAccount = async (): Promise<Answer> => {
    if (ctx.disposed) return superseded()
    const { collections } = store
    const identity = collections.identitySessions.get("identity")
    if (identity === undefined || identity.state === "unknown") return IDENTITY_PENDING_TEXT
    if (identity.state !== "signed-in" || identity.login === null) {
      deps.promptSignIn(false, { name: "account.show" })
      return { value: SIGNED_OUT_VALUE }
    }
    const current = card()
    if (reads.flight && owns(reads.flight) &&
        (!refreshes || current?.payload.refresh?.id === reads.flight.id)) return reads.flight.admission
    if (refreshes && current?.payload.provider === "github" && current.payload.login === identity.login && current.payload.refresh?.state === "requested") {
      resumeAccount()
      return REQUESTED
    }
    const flight: Flight = { id: installRequestId(), epoch: ctx.accountEpoch, owner: identity.login, admission: Promise.resolve(REQUESTED) }
    // The shared flight owns admission too: neither another actor nor an identity
    // re-probe may start the remote read before this card has actually been saved.
    reads.flight = flight
    const boxes = [...collections.cloudWorkspaces.values()]
      .map(({ id, repoId, name, status }) => ({ id, repoId, name, status }))
      .sort((left, right) => left.repoId.localeCompare(right.repoId) || left.name.localeCompare(right.name))
    const next: AccountCard = { id: ACCOUNT_CARD_ID, kind: "account", title: `Account · @${identity.login}`, status: "active", createdAt: Date.now(), ordinal: deps.nextOrdinal(),
      payload: { login: identity.login, provider: deps.provider, scopes: [], boxes,
        ...(refreshes ? { refresh: { id: flight.id, state: "requested" as const } } : {}) } }
    try {
      flight.admission = store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: next }).isPersisted.promise.then(() => {
        if (!owns(flight) || (refreshes && card()?.payload.refresh?.id !== flight.id)) {
          if (reads.flight === flight) reads.flight = undefined
          return superseded()
        }
        if (refreshes) { launch(flight); return REQUESTED }
        reads.flight = undefined
        return { value: `account: @${identity.login}; ${boxes.length} box(es) listed` }
      }).catch(error => {
        const current = owns(flight)
        if (reads.flight === flight) reads.flight = undefined
        if (!current) return superseded()
        throw error
      })
      return await flight.admission
    } catch (error) { if (reads.flight === flight) reads.flight = undefined; throw error }
  }

  return { showAccount, resumeAccount }
}
