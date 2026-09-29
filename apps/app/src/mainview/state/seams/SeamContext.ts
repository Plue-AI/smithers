/*
 * The context a domain seam factory receives from the controller: the tapped
 * fetch, the store, and the transcript helpers. Seams own one backend domain
 * each (issues, landings, keys, …), dispatch typed transitions, and answer
 * the [flow result contract](../../flows/entries/Declare.ts): an honest error
 * string, void for success without data, or { readonly value: string } for
 * success with data. Model-invocable reads must return a bounded value built
 * from the same parsed payload as their card: the model reads the value,
 * never the card. See [FilesSeam](./FilesSeam.ts) for a read example.
 * Cards carry the human presentation; raw backend payloads are not results.
 */
import { Data } from "effect"
import { isRecord } from "@smthrs/canonical/Record"
import { clientRefusal, refusalOf } from "@smthrs/rpc/Refusal"
import type { Refusal } from "@smthrs/rpc/Refusal"
import { refusalLine, refusalSentence } from "@smthrs/rpc/RefusalCopy"
import type { FailureController } from "../controller/failures"
import type { AppStore } from "../AppStore"

export type SeamFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface SeamContext {
  readonly http: SeamFetch
  /**
   * The unbounded streaming door: the tapped fetch WITHOUT boundedFetch's
   * body buffering and deadline (state/controller/context.ts), for long-lived
   * SSE reads (the agent session transcript stream). A stream through `http`
   * would buffer until the server closed and deliver nothing. Optional: a
   * seam that can stream must read its REST fallback honestly when the door
   * is absent.
   */
  readonly stream?: SeamFetch
  readonly checkout?: boolean
  readonly baseUrl: string
  readonly store: AppStore
  readonly dispatch: AppStore["dispatch"]
  readonly resolveToast?: FailureController["resolveToast"]
  /** Run user-requested background work through the app's shared debounced toast stack. */
  readonly withToast?: FailureController["withToast"]
  readonly isDisposed?: () => boolean
  /** The acting principal for dispatches: "user", or "smithers" in the agent's actor projection (ActorBindings). */
  readonly actor: () => "user" | "smithers"
  /** The next transcript ordinal — new cards surface at the end, never mid-history. */
  readonly nextOrdinal: () => number
  /** A rejected repository read uses the same transcript door as an unmet requirement. */
  readonly promptSignIn?: (summary?: string) => void
  /** Offer the Cloud sign-in button this host actually registers, including reauthentication. */
  readonly promptCloudSignIn?: () => void
  /**
   * Report a failure no seam designed a sentence for. The seam shows its own
   * product sentence; the raw error goes here and never onto the screen.
   */
  readonly report?: (subject: string, error: unknown) => void
}

/**
 * A repository read the account is not signed in for.
 *
 * Thrown rather than returned because it travels through the prepared-view
 * machinery, which answers a plain string by painting it onto the view's card.
 * This one is not a card's sentence: the caller answers it with the sign-in
 * step and its button, and a view that stops for it produced no view at all.
 * PreparedView reads it through {@link signInRequired} so a refusal that is
 * already answered never leaves a FAILED card beside the answer.
 */
export class RepositorySignInRequired extends Data.TaggedError("RepositorySignInRequired")<{ readonly message: string }> {
  constructor(message = "Sign in to reach this repository.") { super({ message }) }
}

/** Whether a thrown value is the sign-in refusal the caller has already answered. */
export const signInRequired = (error: unknown): error is RepositorySignInRequired =>
  error instanceof RepositorySignInRequired

/** A bounded model-readable answer; the card retains the full parsed payload. */
export const readResult = (value: string): { readonly value: string } => {
  const cap = 16_000
  const suffix = "\n[truncated]"
  return { value: value.length <= cap ? value : value.slice(0, cap - suffix.length) + suffix }
}

/** A refresh by the same owner stays current; sign-out and account changes retire pending work. */
export const captureCloudOwner = (ctx: SeamContext, requireCloudSignIn = true): (() => boolean) => {
  const cloud = ctx.store.collections.cloudSessions.get("cloud")
  const identity = ctx.store.collections.identitySessions.get("identity")
  const identityOwnerRevision = identity?.ownerRevision ?? identity?.revision
  const cloudOwnerRevision = cloud?.ownerRevision ?? cloud?.revision
  return () => ctx.isDisposed?.() !== true
    && (!requireCloudSignIn || cloud?.state === "signed-in")
    && (!requireCloudSignIn || ctx.store.collections.cloudSessions.get("cloud")?.state === "signed-in")
    && (ctx.store.collections.identitySessions.get("identity")?.ownerRevision ?? ctx.store.collections.identitySessions.get("identity")?.revision) === identityOwnerRevision
    && (ctx.store.collections.cloudSessions.get("cloud")?.ownerRevision ?? ctx.store.collections.cloudSessions.get("cloud")?.revision) === cloudOwnerRevision
}

/**
 * The one sentence for a failed seam response, bounded and fallback-safe.
 *
 * A message the upstream addressed to a person (the `message` or `error`
 * field of a JSON body) is shown only on a refusal the person can act on
 * (`refusalLine`). A Worker or desktop-host code speaks through its written
 * lead; a 5xx body, a router's `404 page not found`, an HTML error page or a
 * stack is plumbing with no contract with this product (§28.5), so the
 * caller's fallback names what failed and the lead says whose fault it was.
 */
export const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  const body: unknown = await response.json().catch(() => null)
  return refusalLine(refusalOf({ body, status: response.status, message: refusalWords(body, fallback, response.status) }), fallback)
}

/**
 * A request that threw before anything answered it: offline, DNS, TLS, a
 * connection reset, an abort.
 *
 * No server judged it, so no server can be blamed for it and the user
 * certainly cannot — `clientRefusal` is infra by construction
 * (@smthrs/rpc/Refusal). What this adds is that every seam builds the same
 * shape for the same event: the throw used to reach the transcript, a card and
 * the chat model as a bare `Could not reach X: Load failed`, which reads as
 * something the reader did, and a dozen seams each worded it themselves.
 * The thrown text is never part of it: the tapped fetch already recorded the
 * failed request for diagnostics, and a person reads only what failed.
 */
export const unreachable = (what: string, error: unknown): Refusal =>
  clientRefusal(error, `Could not reach ${what}.`)

/** The one sentence a thrown request earns, with the verdict on the end of it. */
export const unreachableSentence = (what: string, error: unknown): string => refusalSentence(unreachable(what, error))

/** The words a JSON error body wrote, bounded; undefined when it wrote none. */
const bodyWords = (body: unknown): string | undefined => {
  if (!isRecord(body)) return undefined
  if (typeof body.message === "string" && body.message !== "") return body.message.slice(0, 240)
  if (typeof body.error === "string" && body.error !== "") return body.error.slice(0, 240)
  // Native routes use { error: { code, message } }.
  const native = isRecord(body.error) ? body.error : {}
  return typeof native.message === "string" && native.message !== "" ? native.message.slice(0, 240) : undefined
}

/**
 * The words an already decoded error body may put in front of a person: the
 * upstream's own message when `refusalLine` would show it (a refusal of
 * `status` the person can act on), otherwise `fallback`. It is the `message`
 * a seam hands `refusalOf`, so a refusal built from it never carries a 5xx
 * body or a Worker's words as its text.
 */
export const refusalWords = (body: unknown, fallback: string, status: number | null): string => {
  const words = bodyWords(body)
  if (words === undefined) return fallback
  return refusalLine(refusalOf({ body, status, message: words }), "") === words ? words : fallback
}


export const trustedHttpsUrl = (value: string, host: string): string | null => {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.hostname === host ? url.toString() : null
  } catch {
    return null
  }
}

/*
 * Lane sync (ADR 0005 "Rate limits"): a refused GitHub-proxied call. plue's
 * structured 429 (`pkg/errors.CodeGitHubRateLimited`, raised by
 * `internal/services/github_proxy.go`) answers `{ code:
 * "github_rate_limited", message, limit, remaining, reset_at, retry_after }`;
 * when the body carries it the caller gets the rate-limit facts for the
 * card's line (`… · 0 of 5 000 · resets 12:40 · Retry after`) beside the
 * refusal's line (`refusalLine`). No reset is ever invented for a plain 429.
 */
export interface GitHubRefusal {
  /** One sentence in product words (`refusalLine`), never the body's own words for a failure that is not the reader's. */
  readonly line: string
  readonly rateLimit?: { readonly limit: number; readonly remaining: number; readonly resetAt: string | null }
}

export const readGitHubRefusal = async (response: Response, fallback: string): Promise<GitHubRefusal> => {
  const text = (await response.text().catch(() => "")).trim()
  let body: unknown = null
  try {
    body = text === "" ? null : JSON.parse(text)
  } catch {
    // Not JSON at all: plumbing, never copy.
  }
  const line = refusalLine(refusalOf({ body, status: response.status, message: refusalWords(body, fallback, response.status) }), fallback)
  if (
    isRecord(body) && body.code === "github_rate_limited" &&
    typeof body.limit === "number" && Number.isInteger(body.limit) &&
    typeof body.remaining === "number" && Number.isInteger(body.remaining)
  ) {
    return {
      line,
      rateLimit: {
        limit: body.limit,
        remaining: body.remaining,
        resetAt: typeof body.reset_at === "string" && body.reset_at !== "" ? body.reset_at : null
      }
    }
  }
  return { line }
}
