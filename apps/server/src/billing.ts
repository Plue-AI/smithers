import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { ServerConfig } from "./Config"
import type { Transport } from "./Http"
import { forwardUnderDeadline, validateSession } from "./identity"
import { BILLING_BALANCE_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { notConfigured, notFound, refuse, strippedHeaders, withProxyOrigin } from "./Responses"

/**
 * Billing reads dollars for one authenticated account. Wave 13: a SIGNED-IN
 * user reads their OWN account through the wave-5 trusted-caller path — the
 * proxy strips every client-supplied identity claim (a browser must never pick
 * the account), validates the session against identity, and authenticates to
 * billing with `x-smithers-service-token: <BILLING_PRODUCT_SERVICE_TOKEN>` +
 * `x-user-login: <validated login>` (workers/billing keys the account by that
 * login). The deployment-wide bearer is NEVER sent alongside: billing's
 * bearer-wins rule would silently re-key the read to the shared account, which
 * is exactly the D-1/D-2/A-5 defect this path closes.
 *
 * Fail closed (#2179): with no identity seam there is no session to vouch for,
 * so the seam answers an honest 501 and never forwards, and a signed-out
 * request is refused. A signed-in request with no service token configured is
 * an honest 501 — never a silent fall back onto the shared account.
 *
 * The seam forwards exactly one route: GET /api/billing/balance, the only
 * billing-worker read the product calls. Every other path and method under
 * /api/billing/ (charges, authorize, top-ups, admin) answers the canonical
 * 404 and never leaves with the service token, which the billing worker
 * trusts to act as the named user.
 */
export const proxyToBilling = (request: Request): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    if (config.billingUpstreamUrl === undefined) {
      return notConfigured("Your balance", "BILLING_UPSTREAM_URL is unset. Balance is unavailable")
    }
    const url = new URL(request.url)
    if (config.identityUpstreamUrl === undefined) {
      return notConfigured(
        "Your balance",
        "IDENTITY_UPSTREAM_URL is unset. Billing reads one signed-in user's account, and no identity service can validate a session"
      )
    }
    if (request.method !== "GET" || url.pathname !== BILLING_BALANCE_PATH) return notFound()
    const target = new URL(url.pathname + url.search, config.billingUpstreamUrl)
    const headers = strippedHeaders(request)

    const validation = yield* validateSession(request)
    if (validation.status === "unavailable") return validation.response
    if (validation.status === "invalid") {
      return refuse(
        "sign_in_required",
        "Sign in before reading your balance — the identity service did not validate a session."
      )
    }
    const session = validation.identity
    if (config.billingProductServiceToken === undefined) {
      return notConfigured(
        "Your balance",
        "BILLING_PRODUCT_SERVICE_TOKEN is unset. A signed-in user's balance reads through the trusted-caller path; without it the seam could only bill the shared deployment account, so it says so instead"
      )
    }
    headers.set("x-smithers-service-token", Redacted.value(config.billingProductServiceToken))
    headers.set("x-user-login", session.login)
    headers.set("x-user-id", session.login)
    headers.set("x-user-role", session.admin ? "admin" : "member")
    if (session.scopes.length > 0) headers.set("x-user-scopes", session.scopes.join(" "))
    withProxyOrigin(headers, url)
    return yield* forwardUnderDeadline(
      "The billing service",
      new Request(target.toString(), new Request(request, { headers })),
      config.upstreamTimeoutMs
    )
  })
