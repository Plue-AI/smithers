import type { CloudSession } from "@smthrs/rpc/CloudTunnel"
import { plueFailureCode } from "@smthrs/rpc/Refusal"
import { machineReadableRefusal, upstreamProse } from "@smthrs/rpc/UpstreamProse"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { ServerConfig } from "./Config"
import { cloudTokenRefusal, fetchCloudToken } from "./cloudToken"
import { discardBody, fetchWithDeadline, readRefusalDetail } from "./Http"
import { validateSession } from "./identity"
import { json, refuse } from "./Responses"

/**
 * The sentence plue's scope gate writes, verbatim.
 *
 * It is a constant of OUR service, not a phrase we hope a 403 contains:
 * `RequireScope` in plue internal/middleware/scope.go builds it at one line
 * (`errors.Forbidden("insufficient token scope")`) and plue's own suite pins
 * the string (internal/routes/regression_test.go, internal/middleware/
 * admin_test.go). Reading it is still reading a sentence, which is why it is
 * only ever consulted INSIDE a body that already carried plue's typed
 * `forbidden` verdict — see `isCloudScopeRefusal`.
 */
const CLOUD_SCOPE_REFUSAL = "insufficient token scope"

/**
 * Whether a 403 from Smithers Cloud is the scope refusal a degraded session
 * exists for.
 *
 * The verdict comes off the wire: plue serializes `code` first and clients
 * branch on it, never on `message` (plue pkg/errors/errors.go `APIError`). A
 * body with no plue code — Cloudflare's own block page, another proxy's
 * envelope, a string that merely reads like a scope complaint — cannot
 * publish a signed-in session, whatever English it contains.
 *
 * plue's taxonomy has no code for "this token's scopes are short": the scope
 * gate, the workspaces feature flag, and the repository-bound-token gate all
 * answer `forbidden`, so the code alone cannot separate them and the pinned
 * sentence above picks the scope one out. That is the producer's gap, and
 * fixing it is a change in plue: give `RequireScope` its own registry code
 * (pkg/errors/registry.go) and this function becomes the code test alone.
 */
const isCloudScopeRefusal = (body: string): boolean =>
  plueFailureCode(machineReadableRefusal(body).code) === "forbidden" && upstreamProse(body) === CLOUD_SCOPE_REFUSAL

/**
 * Web counterpart of the native CloudAuth session. The app's cookie names
 * the user; the existing identity exchange holds their Cloud credential.
 * GitHub OAuth scopes are not Cloud PAT scopes: probe the same read as the
 * native host before publishing the scope verdict. No token leaves here.
 */
export const probeCloudSession = (request: Request) => Effect.gen(function* () {
  const identity = yield* validateSession(request)
  const answer = (session: CloudSession): Response => {
    const response = json(200, session)
    response.headers.set("cache-control", "no-store")
    return response
  }
  if (identity.status === "invalid") return answer({ state: "signed-out", username: null, expiresAt: null })
  if (identity.status === "unavailable") return identity.response
  const token = yield* fetchCloudToken(identity.identity.login)
  if (token.status !== "ok") {
    const refusal = cloudTokenRefusal(token, "Smithers Cloud isn't reachable for your account right now.")
    return refuse(refusal.code, refusal.message)
  }
  const config = yield* ServerConfig
  const probe = yield* Effect.result(fetchWithDeadline(
    "The Cloud session scope check",
    new URL("/api/user/workspaces", config.cloudApiBaseUrl).toString(),
    { headers: { authorization: `Bearer ${token.token}` } },
    config.upstreamTimeoutMs
  ))
  if (Result.isFailure(probe)) return refuse("upstream_unreachable", "Smithers Cloud could not check your session right now.")
  const response = probe.success
  let degraded = false
  if (response.status === 403) {
    // An unreadable body carries no verdict, so it degrades nothing.
    const body = yield* readRefusalDetail(response)
    degraded = isCloudScopeRefusal(body)
  } else {
    yield* discardBody(response)
  }
  if (!response.ok && !degraded) return refuse("upstream_refused", "Smithers Cloud could not verify your session right now.")
  return answer({ state: "signed-in", username: identity.identity.login, expiresAt: null, ...(degraded ? { scopes: "degraded" } : {}) })
})
