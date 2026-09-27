import { WORKER_REFUSAL_COPY } from "@smthrs/rpc/RefusalCopy"
import type { WorkerFailureCode } from "@smthrs/rpc/WorkerFailureCodes"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import { ServerConfig } from "./Config"
import type { UpstreamFailure } from "./Failures"
import { fetchWithDeadline, readJsonOrUndefined, readRefusalDetail } from "./Http"
import type { Transport } from "./Http"

/*
 * The signed-in user's Smithers Cloud credential. The Worker mints it through
 * the identity worker's cloud-token door and spends it only server-side: the
 * platform proxy (src/proxies.ts) and every route that forwards to Smithers
 * Cloud as the user send it as their bearer, and it never reaches a browser.
 */

/**
 * The sentence an upstream failure is reported with: the cause's own message
 * where it has one, and the configured deadline in milliseconds (the number
 * the deployment set, never a rounded second) when the deadline won.
 */
const failureMessage = (failure: UpstreamFailure): string =>
  failure._tag === "UpstreamTimeout"
    ? `${failure.seam} did not answer within ${failure.timeoutMs}ms.`
    : failure.cause instanceof Error
    ? failure.cause.message
    : "unknown error"

export type CloudTokenOutcome =
  | { readonly status: "ok"; readonly token: string }
  | { readonly status: "not_configured"; readonly detail: string }
  | { readonly status: "unavailable"; readonly detail: string }
  /*
   * Smithers Cloud refused this ACCOUNT: it is not off the closed-alpha
   * waitlist. A fact about the person, not about the bridge, so it is not an
   * outage and no retry helps. Only the machine-readable codes Cloud itself
   * publishes land here; anything else stays `not_found`, which is what this
   * Worker did with every tokenless answer before.
   */
  | { readonly status: "not_eligible"; readonly detail: string }
  | { readonly status: "not_found"; readonly detail: string }

/**
 * Smithers Cloud's own machine-readable "not on the list yet" codes, carried
 * through the identity worker verbatim. Matched against both fields the door
 * can put one in, so this Worker and the identity worker can ship in either
 * order.
 */
const CLOUD_ELIGIBILITY_REFUSALS = ["NOT_ON_WAITLIST", "access_not_granted"] as const

/**
 * The per-user Cloud token door (wave-11b): POST /api/identity/cloud-token on
 * the identity worker, service-token only, by login. The token mints lazily
 * upstream; a typed failure is surfaced, never fabricated.
 */
export const fetchCloudToken = (login: string): Effect.Effect<CloudTokenOutcome, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    if (config.identityUpstreamUrl === undefined) {
      return { status: "not_configured", detail: "IDENTITY_UPSTREAM_URL is unset on this deployment." } as const
    }
    if (config.identityServiceToken === undefined) {
      return { status: "not_configured", detail: "IDENTITY_SERVICE_TOKEN is unset on this deployment." } as const
    }
    const answered = yield* Effect.result(fetchWithDeadline(
      "The Cloud token door",
      new URL("/api/identity/cloud-token", config.identityUpstreamUrl).toString(),
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-smithers-service-token": Redacted.value(config.identityServiceToken) },
        body: JSON.stringify({ login })
      },
      config.upstreamTimeoutMs
    ))
    if (Result.isFailure(answered)) {
      return {
        status: "unavailable",
        detail: `The identity service is unreachable: ${failureMessage(answered.failure)}`
      } as const
    }
    const response = answered.success
    if (!response.ok) {
      const detail = (yield* readRefusalDetail(response)).trim().slice(0, 200)
      return {
        status: "unavailable",
        detail: `The Cloud token door answered HTTP ${response.status}${detail === "" ? "." : `: ${detail}`}`
      } as const
    }
    const body = (yield* readJsonOrUndefined(response)) as
      | { found?: unknown; token?: unknown; cloud?: { status?: unknown; reason?: unknown } }
      | undefined
    if (body?.found === true && typeof body.token === "string" && body.token !== "") {
      return { status: "ok", token: body.token } as const
    }
    const cloudStatus = typeof body?.cloud?.status === "string" ? body.cloud.status : "unknown"
    const cloudReason = typeof body?.cloud?.reason === "string" ? body.cloud.reason : null
    const refusal = CLOUD_ELIGIBILITY_REFUSALS.find((code) => code === cloudStatus || code === cloudReason)
    if (refusal !== undefined) {
      return { status: "not_eligible", detail: `Smithers Cloud has not let this account in yet (${refusal}).` } as const
    }
    return {
      status: "not_found",
      detail: `No Smithers Cloud identity is available for this account (${cloudStatus}${
        cloudReason === null ? "" : `: ${cloudReason}`
      }).`
    } as const
  })

/**
 * The one reading of a Cloud token outcome that is not a token. Eligibility is
 * a fact about the ACCOUNT and takes the allowlist code with its written copy;
 * everything else is the bridge, and the caller words that as it always has.
 *
 * It lives beside `fetchCloudToken` because a consumer that reclassifies the
 * same fact for itself is how a closed-alpha refusal came to read as a setup
 * failure on two of these routes and as an outage on a third.
 */
export const cloudTokenRefusal = (
  outcome: Exclude<CloudTokenOutcome, { readonly status: "ok" }>,
  unavailable: string
): { readonly code: WorkerFailureCode; readonly message: string } =>
  outcome.status === "not_eligible"
    ? { code: "account_not_allowlisted", message: WORKER_REFUSAL_COPY.account_not_allowlisted.lead }
    : { code: "cloud_token_unavailable", message: unavailable }

/**
 * owner/repo, and nothing that could rewrite the upstream path. `.` and `..`
 * match the character class a repository name allows, but URL parsing resolves
 * them away: `../admin` would aim the user's server-held Cloud token at a route
 * outside this seam, which is exactly what holding the token server-side is for.
 * Dot-PREFIXED names (`.github`) are real repositories and stay legal.
 */
export const isRelayRepoName = (value: string): boolean =>
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(value)
