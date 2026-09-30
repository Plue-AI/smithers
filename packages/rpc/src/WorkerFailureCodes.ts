/**
 * The Cloudflare Worker's OWN failure taxonomy — the refusals apps/server
 * writes itself rather than passing through from plue.
 *
 * HAND-WRITTEN, and deliberately a separate file from PlueFailureCodes.ts:
 * that one is generated from plue's `docs/failure-codes.json` and must stay
 * byte-identical to its source, so a code of ours must never be added to it.
 * This is the other half of the same vocabulary — same three facts per row
 * (`fault`, `status`, `retryAfter`), same meaning of each — written by us for
 * the party plue knows nothing about.
 *
 * About a third of what a person sees refused never reaches plue at all. The
 * Worker answers it: the session is not signed in, the route does not exist,
 * the body is past the ceiling, the deployment is missing a secret a seam
 * needs, an upstream never answered. Until this table those were PROSE, so the
 * app could not tell "you are signed out" from "this deployment is
 * misconfigured" without matching English — and the second one is an INFRA
 * failure whose audience is whoever deployed it, not the person reading it.
 *
 * The codes are NOT prefixed. Two of them (`turn_rate_limited`,
 * `gateway_proxy_removed`) are already on the wire and matched by the app and
 * by the launch probes, so they keep their spelling; and plue's own registry
 * already spends the word `worker_` on ITS sandbox workers
 * (`worker_draining`, `worker_fenced`), so a `worker_` prefix here would name
 * the wrong machine. What keeps the two vocabularies apart is a gate instead
 * of a prefix: WorkerFailureCodes.test.ts fails if any code appears in both
 * tables, which is also the alarm for a code plue adds later that collides
 * with one of ours.
 *
 * @since 1.0.0
 */

import type { PlueFault } from "./PlueFailureCodes.ts"

/**
 * Every code this Worker may put on the wire for a refusal it wrote itself.
 *
 * @since 1.0.0
 * @category constants
 */
export const WORKER_FAILURE_CODES = [
  "client_disconnected",
  "cloud_token_unavailable",
  "cross_origin_blocked",
  "deployment_not_configured",
  "error_reports_throttled",
  "feature_unavailable_here",
  "gateway_proxy_removed",
  "method_not_allowed",
  "model_no_answer",
  "model_rate_limited",
  "procedure_not_relayed",
  "request_body_not_json",
  "request_body_too_large",
  "request_body_unreadable",
  "request_conflict",
  "request_invalid",
  "route_not_found",
  "seam_not_configured",
  "service_auth_required",
  "service_temporarily_unavailable",
  "session_expired",
  "setup_request_conflict",
  "sign_in_required",
  "storage_failed",
  "tools_not_supported",
  "trigger_approval_missing",
  "turn_already_running",
  "turn_not_yours",
  "turn_rate_limited",
  "unexpected_failure",
  "upstream_malformed",
  "upstream_refused",
  "upstream_timeout",
  "upstream_unreachable",
  "workspace_gone",
  "workspace_starting"
] as const

/**
 * A code the Cloudflare Worker refuses with.
 *
 * @since 1.0.0
 * @category models
 */
export type WorkerFailureCode = (typeof WORKER_FAILURE_CODES)[number]

/**
 * One row of the Worker's taxonomy, in plue's own vocabulary so both tables
 * answer the same three questions about a refusal.
 *
 * @since 1.0.0
 * @category models
 */
export interface WorkerFailureEntry {
  /** Whose problem this is. The one fact a person acts on, and the app never guesses it from prose. */
  readonly fault: PlueFault
  /** The HTTP status the Worker answers. `refuse` reads it from here so a route cannot drift from the table. */
  readonly status: number
  /** Seconds to wait before this is worth asking again; 0 when waiting changes nothing, exactly as plue's rows spell it. */
  readonly retryAfter: number
}

/**
 * The Worker's registry. `satisfies Record<WorkerFailureCode,
 * WorkerFailureEntry>` is the exhaustiveness gate: a code in the union with no
 * row, or a row for a code not in the union, does not compile.
 *
 * @since 1.0.0
 * @category constants
 */
export const WORKER_FAILURES = {
  /** The caller went away before the response settled. Answered at the Effect boundary, never restated as a 500. */
  "client_disconnected": { fault: "user", status: 499, retryAfter: 0 },
  /** The Worker could not mint this account's Smithers Cloud token, so it never got to ask plue anything. */
  "cloud_token_unavailable": { fault: "dependency", status: 503, retryAfter: 0 },
  /** A browser request from another site to an API route that spends this deployment's own credentials. */
  "cross_origin_blocked": { fault: "user", status: 403, retryAfter: 0 },
  /**
   * A seam this deployment publishes has no configuration behind it — an unset
   * secret, a missing binding, an upstream URL nobody filled in. Infra, like a
   * full fleet, but a DIFFERENT infra: nothing is exhausted, something was
   * never wired, and the audience is whoever deployed this rather than
   * whoever is reading it.
   */
  "deployment_not_configured": { fault: "infra", status: 501, retryAfter: 0 },
  /** The client error ingest is shedding reports from this source. Nothing the reader did. */
  "error_reports_throttled": { fault: "wait", status: 429, retryAfter: 60 },
  /** The route exists but this host cannot serve it — web page reading in the browser build, checkout during the closed alpha. */
  "feature_unavailable_here": { fault: "user", status: 501, retryAfter: 0 },
  /** The retired static gateway mounts. Already on the wire under this spelling; the launch probes assert it. */
  "gateway_proxy_removed": { fault: "user", status: 410, retryAfter: 0 },
  /** The route exists, this verb does not. */
  "method_not_allowed": { fault: "user", status: 405, retryAfter: 0 },
  /** An upstream accepted the turn with a 2xx and then sent no body at all. Nothing was charged. */
  "model_no_answer": { fault: "dependency", status: 502, retryAfter: 0 },
  /** The model service is rate-limiting THIS DEPLOYMENT — not the account, which has its own ceiling under `turn_rate_limited`. */
  "model_rate_limited": { fault: "dependency", status: 429, retryAfter: 60 },
  /** The workflow relay does not carry the named procedure. */
  "procedure_not_relayed": { fault: "user", status: 400, retryAfter: 0 },
  /** A body read whole that is not JSON. */
  "request_body_not_json": { fault: "user", status: 400, retryAfter: 0 },
  /** A body past the route's byte ceiling, measured in bytes and not characters. */
  "request_body_too_large": { fault: "user", status: 413, retryAfter: 0 },
  /** A body whose stream failed before it ended. */
  "request_body_unreadable": { fault: "user", status: 400, retryAfter: 0 },
  /** The request is well formed but the state it names does not allow it. */
  "request_conflict": { fault: "user", status: 409, retryAfter: 0 },
  /** The request is missing a field, or carries one this route cannot accept. */
  "request_invalid": { fault: "user", status: 400, retryAfter: 0 },
  /** No route of this Worker answers that path. Also the answer /api/admin/* gives a non-admin, byte for byte. */
  "route_not_found": { fault: "user", status: 404, retryAfter: 0 },
  /**
   * A seam whose upstream this deployment does not have at all — the local dev
   * and stub stacks, a preview without the identity worker. The same INFRA
   * shape as `deployment_not_configured`, at the status a seam that is simply
   * absent answers.
   */
  "seam_not_configured": { fault: "infra", status: 503, retryAfter: 0 },
  /** A service-to-service route whose shared token was absent or wrong. Never a person's session. */
  "service_auth_required": { fault: "user", status: 401, retryAfter: 0 },
  /** Smithers' own seam is up but could not answer this one right now. */
  "service_temporarily_unavailable": { fault: "infra", status: 503, retryAfter: 0 },
  /** A tutorial or example session that has aged out. Saved results survive it. */
  "session_expired": { fault: "user", status: 401, retryAfter: 0 },
  /**
   * A setup request id that already names other work: the same id arrived with
   * a different candidate, operation or workspace. INFRA, not the reader's:
   * they asked for one operation once, and the id is the client's bookkeeping.
   * Nothing is exhausted either, so the sentence says what the next attempt
   * does — the app spends the id and asks under a new one.
   */
  "setup_request_conflict": { fault: "infra", status: 409, retryAfter: 0 },
  /** No signed-in session on a route that spends the deployment's own model credential. */
  "sign_in_required": { fault: "user", status: 401, retryAfter: 0 },
  /** A Durable Object's storage or stub call threw. Smithers' own fleet, not the caller and not an upstream. */
  "storage_failed": { fault: "infra", status: 500, retryAfter: 0 },
  /** A sealed relay was handed a turn carrying tools, or a tool result it has no tools to continue. */
  "tools_not_supported": { fault: "user", status: 400, retryAfter: 0 },
  /** Smithers Cloud holds no approval for the plan a schedule names. Approving the preview clears it; waiting does not. */
  "trigger_approval_missing": { fault: "user", status: 409, retryAfter: 0 },
  /** That runId is already streaming; a second start would fork the same turn. */
  "turn_already_running": { fault: "user", status: 409, retryAfter: 0 },
  /** The runId exists and belongs to a different account. */
  "turn_not_yours": { fault: "user", status: 403, retryAfter: 0 },
  /** The caller has spent a turn budget — their own, or the deployment-wide anonymous one. Already on the wire under this spelling. */
  "turn_rate_limited": { fault: "wait", status: 429, retryAfter: 0 },
  /** A route failed in a way no contract names. Logged once, answered generically, never a leaked stack. */
  "unexpected_failure": { fault: "bug", status: 500, retryAfter: 0 },
  /** An upstream answered, and its answer was not the shape the contract says it is. */
  "upstream_malformed": { fault: "dependency", status: 502, retryAfter: 0 },
  /** An upstream answered with a refusal of its own, restated in this Worker's envelope. */
  "upstream_refused": { fault: "dependency", status: 502, retryAfter: 0 },
  /** An upstream sent no headers before the seam's deadline. */
  "upstream_timeout": { fault: "dependency", status: 504, retryAfter: 0 },
  /** The connection to an upstream failed outright: DNS, TLS, a reset, an abort. */
  "upstream_unreachable": { fault: "dependency", status: 502, retryAfter: 0 },
  /**
   * A record pins a Smithers Cloud workspace Cloud no longer has: deleted, or
   * lost with its VM. INFRA, and stale state rather than a dead end — an
   * unbound request selects a replacement, so asking again gets a new box.
   * Distinct from `no_cloud_repo`, where the repository itself is absent.
   */
  "workspace_gone": { fault: "infra", status: 409, retryAfter: 0 },
  /**
   * The workspace exists and is coming up: resumed from a suspend, or freshly
   * created and not serving yet. WAIT, and deliberately none of the three
   * codes it used to be told under. It is not `upstream_refused`: nothing
   * refused anything, and a reader told a dependency refused them goes looking
   * for a broken dependency. It is not `upstream_timeout` or
   * `upstream_unreachable` either: those say Smithers could not get an answer,
   * where here Smithers has the answer and the answer is "not yet". The wait
   * is seconds to a couple of minutes, so the row states one.
   */
  "workspace_starting": { fault: "wait", status: 503, retryAfter: 10 }
} satisfies Record<WorkerFailureCode, WorkerFailureEntry>

/**
 * The one reviewed ingress for a Worker code that arrived as a string,
 * mirroring `plueFailureCode`.
 *
 * @since 1.0.0
 * @category constants
 */
export const workerFailureCode = (value: unknown): WorkerFailureCode | null =>
  typeof value === "string" && Object.hasOwn(WORKER_FAILURES, value) ? value as WorkerFailureCode : null
