import { copyRefusalMark, logSeamFailure, markCause, markRefusal } from "./RefusalLog"
import * as Effect from "effect/Effect"
import { upstreamProse } from "@smthrs/rpc/UpstreamProse"
import { workerRefusalEnvelope } from "@smthrs/rpc/Refusal"
import type { WorkerRefusalEnvelope } from "@smthrs/rpc/Refusal"
import { PLUE_FAILURES } from "@smthrs/rpc/PlueFailureCodes"
import type { PlueFailureCode } from "@smthrs/rpc/PlueFailureCodes"
import { WORKER_FAILURES } from "@smthrs/rpc/WorkerFailureCodes"
import type { WorkerFailureCode } from "@smthrs/rpc/WorkerFailureCodes"
import type { BodyFailure, StorageFailure, UpstreamFailure } from "./Failures"
import { readBoundedJson } from "./Http"

/*
 * The answers every route of this Worker composes: the JSON envelope with the
 * isolation headers the app's OPFS persistence needs, the canonical refusals,
 * and the sentences an upstream failure earns. Status codes and message text
 * are the HTTP contract the product renders verbatim, so they live here, once.
 */

/** The OPFS SQLite persistence in the SPA needs cross-origin isolation. */
export const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp"
} as const

export const withIsolationHeaders = (response: Response): Response => {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value)
  return copyRefusalMark(response, new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  }))
}

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...ISOLATION_HEADERS }
  })

/**
 * A refusal this Worker writes itself, in the one shape the app classifies.
 *
 * The refusals here are the ones plue never sees: no session, no such route,
 * a body past the ceiling, a secret this deployment never set, an upstream
 * that never answered. They used to be PROSE and nothing else, so the app had
 * to read English to tell "you are signed out" from "this deployment is
 * misconfigured" — and the second one is an INFRA failure whose audience is
 * whoever deployed this, not the person reading it.
 *
 * `code` is the machine fact that settles it. Its status comes from
 * @smthrs/rpc/WorkerFailureCodes rather than from the call site, so a route
 * and its code can never disagree, and the same table on the client side reads
 * the fault back without inferring anything (packages/rpc/src/Refusal.ts). The
 * envelope is unchanged otherwise: `status: "error"` and the seam's own
 * sentence, which the product still renders verbatim.
 *
 * A row whose `retryAfter` is more than zero also answers the `Retry-After`
 * header and the body's `retry_after`, which is the pair the client already
 * reads. A route that knows a better interval passes `retryAfterSeconds`.
 */
export const refuse = (
  code: WorkerFailureCode,
  message: string,
  options?: { readonly retryAfterSeconds?: number | null }
): Response => coded(workerRefusalEnvelope(code, message, { retryAfterSeconds: options?.retryAfterSeconds ?? undefined }))

/**
 * The same refusal at a status the route did not choose — an upstream's, kept
 * so a caller sees what the upstream actually said.
 *
 * The ONLY reason to use this instead of `refuse`: the status is evidence from
 * somewhere else. A route inventing its own status for a code would be exactly
 * the drift `refuse` reading the table prevents.
 */
export const refuseWithStatus = (
  status: number,
  code: WorkerFailureCode,
  message: string,
  options?: { readonly retryAfterSeconds?: number | null }
): Response => coded(workerRefusalEnvelope(code, message, { status, retryAfterSeconds: options?.retryAfterSeconds ?? null }))

/** The refusal envelope itself, from @smthrs/rpc so the app's classifier reads exactly what this writes. */
const coded = (envelope: WorkerRefusalEnvelope): Response => {
  const response = json(envelope.status, envelope.body)
  for (const [name, value] of Object.entries(envelope.headers)) response.headers.set(name, value)
  return markRefusal(response, envelope.body.code)
}

/**
 * A plue refusal this Worker passes on under plue's own code and status, such
 * as the model proxy's `out_of_credit`. The code is plue's, so the envelope
 * carries no Worker origin and the client reads it back against plue's table.
 */
/** A code a route answers with: its own, or Plue's `out_of_credit` relayed from the model proxy. */
export type RouteRefusalCode = WorkerFailureCode | "out_of_credit"

/** The registry status for a route refusal code, read from whichever table owns it. */
export const routeRefusalStatus = (code: RouteRefusalCode): number =>
  code === "out_of_credit" ? PLUE_FAILURES[code].status : WORKER_FAILURES[code].status

/**
 * A refusal on a route that answers with its own headers (the model relays),
 * in the same envelope. `detail`, when given, is operator evidence (an unset
 * variable, a native cause) and goes only to the `worker_refusal` log line.
 */
export const routeRefusal = (
  code: RouteRefusalCode,
  message: string,
  headers: Record<string, string>,
  detail?: { readonly seam: string; readonly cause: unknown }
): Response => {
  const response = new Response(JSON.stringify({ status: "error", code, message }), {
    status: routeRefusalStatus(code),
    headers: { "content-type": "application/json", ...headers }
  })
  if (code === "out_of_credit") return response
  markRefusal(response, code)
  return detail === undefined ? response : markCause(response, detail.seam, detail.cause)
}

export const relayPlue = (code: PlueFailureCode, message: string): Response =>
  json(PLUE_FAILURES[code].status, { status: "error", code, message })

/*
 * The canonical unknown-route answer. The admin surface is non-enumerable
 * (Launch Checklist §E): a non-admin — or signed-out — caller probing
 * /api/admin/* gets EXACTLY this response, byte-identical to any other
 * unknown /api/* route. Never 401, never 403, never a different shape.
 */
export const notFound = (): Response => refuse("route_not_found", "Not found.")

export const methodNotAllowed = (): Response => refuse("method_not_allowed", "Method not allowed.")

/**
 * A seam this deployment publishes with nothing configured behind it. INFRA,
 * and deliberately not the infra the capacity line describes: nothing is full,
 * a value was never set, and the fix belongs to whoever deployed this.
 */
export const notConfigured = (feature: string, detail: string): Response =>
  operatorRefusal("deployment_not_configured", `${feature} isn't set up on this deployment.`, feature, detail)

/**
 * A refusal whose cause is for the operator, not the reader: the body carries
 * one plain `sentence`, and `detail` (an unset variable, a native cause, a
 * storage operation) goes only to the `worker_refusal` log line.
 */
export const operatorRefusal = (
  code: WorkerFailureCode,
  sentence: string,
  seam: string,
  detail: unknown
): Response => markCause(refuse(code, sentence), seam, detail)

/** Durable Object storage failed under a route: one fixed sentence, the operation and cause in the log. */
export const STORAGE_FAILED = "Smithers couldn't save or read that just now."

export const storageRefusal = (failure: StorageFailure): Response =>
  operatorRefusal("storage_failed", STORAGE_FAILED, failure.operation, failure)

/**
 * A Durable Object's own answer when its storage failed. No request log line
 * covers the object's fetch, so the cause is written as a seam failure line
 * and the body carries only the fixed sentence.
 */
export const storageFailureAnswer = (seam: string, failure: unknown): Response => {
  logSeamFailure(seam, failure)
  return Response.json({ status: "error", code: "storage_failed" satisfies WorkerFailureCode, message: STORAGE_FAILED }, { status: 500 })
}

/**
 * Cap for a single turn request body. Every turn replays the whole transcript,
 * so this is a conversation-length ceiling, not a per-message one. At 64 KB
 * seven long answers wedged the seam permanently on canary and `/clear` could
 * not recover it, because `/clear` runs a model turn of its own and hit the
 * same refusal (repro apps/app/canary-repros/chat/4.13). The Vite dev boundary
 * (`src/server/AgentApi.ts`) allows 1 MB, so the two boundaries now agree and a
 * conversation that passes in dev passes here.
 */
export const MAX_BODY_BYTES = 1024 * 1024

/*
 * Every model call replays the whole transcript, so "too large" is a fact about
 * the CONVERSATION, not about the message that tripped it. The turn seam said
 * so; the model relay — which since the browser chain became the only backend
 * carries every turn — still answered the bare `Request body is too large.`,
 * which names nothing the reader can act on (repro
 * apps/app/canary-repros/chat/4.13). One sentence, both doors.
 */
export const TRANSCRIPT_TOO_LARGE =
  "This conversation has grown too long to send in one turn. Start a new conversation to keep going — nothing was charged, and the transcript above stays where it is."

export const BODY_TOO_LARGE = "Request body is too large."

export const BODY_UNREADABLE = "The request broke off before it ended. Try again."

/** The refusal a request body earns: the ceiling, non-JSON, or a stream that failed. */
export const bodyRefusal = (failure: BodyFailure, tooLarge: string = BODY_TOO_LARGE): Response => {
  switch (failure._tag) {
    case "BodyTooLarge":
      return refuse("request_body_too_large", tooLarge)
    case "BodyNotJson":
      return refuse("request_body_not_json", "Request body must be valid JSON.")
    case "BodyUnreadable":
      return operatorRefusal("request_body_unreadable", BODY_UNREADABLE, "request body", failure)
  }
}

/** A JSON request body under the turn ceiling, or the refusal it earns. */
export const readBody = (request: Request, tooLarge: string = BODY_TOO_LARGE): Effect.Effect<unknown | Response> =>
  readBoundedJson(request, MAX_BODY_BYTES).pipe(Effect.catch((failure) => Effect.succeed(bodyRefusal(failure, tooLarge))))

/**
 * A proxy whose upstream never answered. Returning the raw rejection would end
 * the fetch handler with an uncaught exception, and workerd answers that with
 * its own `Error 1101 Worker threw exception` HTML page — which the transcript
 * then renders verbatim to the user (repro apps/app/canary-repros/honesty/24.3,
 * the §24.4 note). A named JSON refusal is the honest answer instead.
 */
export const upstreamUnreachable = (seam: string, failure: UpstreamFailure): Response =>
  failure._tag === "UpstreamTimeout"
    ? operatorRefusal("upstream_timeout", `${seam} took too long to answer. Try again in a moment.`, seam, failure)
    : operatorRefusal("upstream_unreachable", `${seam} can't be reached right now. Try again in a moment.`, seam, failure)

/** The prose of a native cause, or the seam's placeholder. */
export const causeMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : "unknown error")

/**
 * The prose inside an upstream error body, or undefined when the body was
 * written for a machine. This is the rule the seam keeps: a Cloudflare HTML
 * page, a Go router's `404 page not found`, and a provider's error envelope
 * are never handed to a reader. Only a `message`/`error` string — a field an
 * upstream fills with a sentence — survives.
 *
 * The rule itself lives in @smthrs/rpc/UpstreamProse, because the desktop
 * app's native host proxies the same upstreams to the same reader and two
 * copies of this decision would be two rules.
 */
export { upstreamProse }

/**
 * One sentence a reader can act on for an upstream that refused. The status is
 * classified here rather than trusting every upstream to write user-facing
 * prose: a provider's raw rate-limit JSON was pasted straight into the
 * transcript on canary (repro apps/app/canary-repros/honesty/24.3), and a
 * Worker 500 arrived as a Cloudflare HTML page.
 */
export const upstreamFailureMessage = (status: number, body: string, retryAfter: string | null): string => {
  if (status === 429) {
    const seconds = Number(retryAfter ?? "")
    const when = Number.isFinite(seconds) && seconds > 0
      ? `Try again in about ${seconds < 90 ? `${Math.ceil(seconds)} seconds` : `${Math.ceil(seconds / 60)} minutes`}.`
      : "Try again in a minute."
    return `The model service is rate-limiting this deployment right now, so the turn did not run. Nothing was charged. ${when}`
  }
  if (status === 401 || status === 403) {
    return "The model service refused this deployment's credentials, so the turn did not run. Nothing was charged, and this is a deployment configuration problem rather than anything to fix from here."
  }
  if (status === 413) {
    return "This conversation has grown too long for the model service to accept. Start a new conversation to keep going — nothing was charged."
  }
  const prose = upstreamProse(body)
  if (status >= 500) {
    return `The model service is having trouble right now (HTTP ${status}), so the turn did not run. Nothing was charged.${
      prose === undefined ? "" : ` It said: ${prose}`
    }`
  }
  return prose === undefined
    ? `The model service refused this turn (HTTP ${status}).`
    : `The model service refused this turn: ${prose}`
}

/**
 * Which refusal an upstream's status IS, beside the sentence above.
 *
 * The interesting row is 401/403: the prose already says "this is a deployment
 * configuration problem rather than anything to fix from here", and that is
 * exactly `deployment_not_configured` — an INFRA fault for whoever deployed
 * this, not a `user` one for whoever is reading it, which is what the status
 * alone would have made it. 429 is the provider throttling this DEPLOYMENT,
 * never the account's own ceiling (`turn_rate_limited`).
 */
export const upstreamFailureCode = (status: number): WorkerFailureCode => {
  if (status === 429) return "model_rate_limited"
  if (status === 401 || status === 403) return "deployment_not_configured"
  if (status === 413) return "request_body_too_large"
  return "upstream_refused"
}

/**
 * Identity headers a client must never be trusted for: the proxy strips them off
 * every gateway-bound request and re-injects them only from a validated session
 * (trusted-proxy pattern, docs/guides/custom-workflow-ui.mdx).
 */
export const STRIPPED_IDENTITY_HEADERS = [
  "x-smithers-client-ip",
  "x-user-id",
  "x-user-scopes",
  "x-user-role",
  "x-user-login",
  "x-smithers-token-id",
  "x-smithers-service-token",
  "x-smithers-admin-token",
  "authorization"
] as const

/**
 * The siblings' own admin surfaces. The product spends the admin token only
 * from its /api/admin/* routes, after the caller's session validates as
 * admin:true (admin.ts). The transparent proxies never reach these paths: a
 * caller who holds an upstream admin credential can use it against the
 * upstream directly, and one who does not gets the canonical 404, so nothing
 * here is enumerable.
 */
export const SIBLING_ADMIN_ROUTE_PREFIXES = ["/api/identity/admin/", "/api/billing/admin/"] as const

/**
 * The path a lenient upstream router could resolve `pathname` to: percent
 * escapes decoded, repeated slashes collapsed, dot segments resolved, and
 * lowercased. The admin test runs on this form so `//admin/`, `%61dmin`,
 * `./admin` and `ADMIN` cannot slip a sibling's admin route past it.
 */
const canonicalRoutePath = (pathname: string): string => {
  let decoded = pathname
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    // A malformed escape stays literal; the remaining steps still apply.
  }
  return new URL(decoded.replace(/[\\/]+/g, "/").replace(/\?/g, "%3F").replace(/#/g, "%23"), "http://route.invalid").pathname.replace(/\/{2,}/g, "/").toLowerCase()
}

export const siblingAdminRoute = (pathname: string): boolean => {
  const canonical = canonicalRoutePath(pathname)
  return SIBLING_ADMIN_ROUTE_PREFIXES.some((prefix) => canonical.startsWith(prefix) || canonical === prefix.slice(0, -1))
}

/**
 * Both sibling workers gate on the browser `Origin` (`ALLOWED_ORIGINS`), and a
 * same-origin GET carries none at all, so the proxy states the one origin that
 * is actually true of every request it forwards: its own. Deployments must list
 * this Worker's origin in the identity and billing workers' `ALLOWED_ORIGINS`.
 */
export const withProxyOrigin = (headers: Headers, url: URL): void => {
  headers.set("origin", url.origin)
}

/** The request's headers with every client-supplied identity claim removed. */
export const strippedHeaders = (request: Request): Headers => {
  const headers = new Headers(request.headers)
  for (const name of STRIPPED_IDENTITY_HEADERS) headers.delete(name)
  return headers
}
