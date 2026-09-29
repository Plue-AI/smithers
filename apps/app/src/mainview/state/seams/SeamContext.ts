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
import { clientRefusal } from "@smthrs/rpc/Refusal"
import type { Refusal } from "@smthrs/rpc/Refusal"
import { refusalSentence } from "@smthrs/rpc/RefusalCopy"
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
 * The honest message out of a failed seam response, bounded and fallback-safe.
 *
 * ONLY a message the upstream addressed to a person is surfaced: the `message`
 * or `error` field of a JSON body. Anything else is transport plumbing with no
 * contract with this product — a router's `404 page not found`, an HTML error
 * page, a stack trace — and reads to the user as a debug string leaking through
 * the UI (§28.5). The caller's fallback already names what failed in the
 * product's own voice, so that is what a plumbing body gets.
 */
export const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  return errorMessage(await response.json().catch(() => null), fallback)
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

/** The human-facing message in an already decoded response. */
export const errorMessage = (body: unknown, fallback: string): string => {
  if (!isRecord(body)) return fallback
  if (typeof body.message === "string" && body.message !== "") return body.message.slice(0, 240)
  if (typeof body.error === "string" && body.error !== "") return body.error.slice(0, 240)
  // Native routes use { error: { code, message } }.
  if (isRecord(body.error) && typeof body.error.message === "string" && body.error.message !== "") {
    return body.error.message.slice(0, 240)
  }
  return fallback
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
 * honest message. Any other refusal is the verbatim message alone — no reset
 * is ever invented for a plain 429.
 */
export interface GitHubRefusal {
  readonly message: string
  readonly rateLimit?: { readonly limit: number; readonly remaining: number; readonly resetAt: string | null }
}

export const readGitHubRefusal = async (response: Response, fallback: string): Promise<GitHubRefusal> => {
  const text = (await response.text().catch(() => "")).trim()
  if (text !== "") {
    try {
      const body = JSON.parse(text) as {
        code?: unknown
        message?: unknown
        error?: unknown
        limit?: unknown
        remaining?: unknown
        reset_at?: unknown
      }
      const message = typeof body.message === "string" && body.message !== ""
        ? body.message.slice(0, 240)
        : typeof body.error === "string" && body.error !== ""
        ? body.error.slice(0, 240)
        : fallback
      if (
        body.code === "github_rate_limited" &&
        typeof body.limit === "number" && Number.isInteger(body.limit) &&
        typeof body.remaining === "number" && Number.isInteger(body.remaining)
      ) {
        return {
          message,
          rateLimit: {
            limit: body.limit,
            remaining: body.remaining,
            resetAt: typeof body.reset_at === "string" && body.reset_at !== "" ? body.reset_at : null
          }
        }
      }
      return { message }
    } catch {
      // Not JSON at all: plumbing, never copy.
      return { message: fallback }
    }
  }
  return { message: fallback }
}
