/**
 * What of an upstream's error body may reach a person, and what a proxy says
 * instead when none of it may.
 *
 * Both hosts proxy the same upstreams — the Cloudflare Worker to Smithers
 * Cloud (apps/server/src/proxies.ts), the desktop app's native host to the
 * Worker and to Smithers Cloud (apps/app/src/bun/server.ts) — and both render
 * whatever comes back straight to the reader. An upstream's body is written
 * for its own callers: a Cloudflare HTML page, a Go router's
 * `404 page not found`, a provider's error envelope. Passing those through put
 * a debug string in front of a user (repro apps/app/canary-repros/honesty/24.3).
 *
 * The rule lives HERE rather than in either host so the two cannot drift into
 * two rules, which is the same mistake three refusal vocabularies were.
 *
 * @since 1.0.0
 */

import { plueFailureCode } from "./Refusal.ts"

/**
 * The prose inside an upstream error body, or undefined when the body was
 * written for a machine. Only a `message`/`error` string — a field an upstream
 * fills with a sentence — survives.
 *
 * @since 1.0.0
 * @category constants
 */
export const upstreamProse = (body: string): string | undefined => {
  const text = body.trim()
  if (text === "" || text.startsWith("<")) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const record = parsed as { message?: unknown; error?: unknown }
  const nested = typeof record.error === "object" && record.error !== null
    ? (record.error as { message?: unknown }).message
    : record.error
  const prose = [record.message, nested].find(
    (value): value is string => typeof value === "string" && value.trim() !== ""
  )
  return prose === undefined ? undefined : prose.trim().slice(0, 200)
}

/**
 * The parts of an upstream refusal that are NOT prose, kept when the body is
 * restated.
 *
 * `code` names WHICH refusal this is — `no_capacity` (the fleet is full,
 * nobody's fault) reads nothing like `quota_exceeded` (this account is at its
 * own cap), and a client that only gets a sentence cannot tell them apart
 * without matching on English. `retry_after` says when to come back. Plan-limit
 * metadata names the current plan, exhausted limit, and upgrade target. These
 * facts cannot be re-derived from prose, so they pass through at their
 * documented types.
 *
 * @since 1.0.0
 * @category constants
 */
export const machineReadableRefusal = (
  body: string
): {
  readonly code?: string
  readonly retry_after?: number
  readonly plan_key?: string
  readonly limit_kind?: string
  readonly upgrade_plan_key?: string
} => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {}
  }
  if (typeof parsed !== "object" || parsed === null) return {}
  const record = parsed as {
    code?: unknown
    retry_after?: unknown
    plan_key?: unknown
    limit_kind?: unknown
    upgrade_plan_key?: unknown
  }
  return {
    ...(typeof record.code === "string" && record.code.trim() !== "" ? { code: record.code.trim().slice(0, 64) } : {}),
    ...(typeof record.plan_key === "string" ? { plan_key: record.plan_key } : {}),
    ...(typeof record.limit_kind === "string" ? { limit_kind: record.limit_kind } : {}),
    ...(typeof record.upgrade_plan_key === "string" ? { upgrade_plan_key: record.upgrade_plan_key } : {}),
    ...(typeof record.retry_after === "number" && Number.isFinite(record.retry_after)
      ? { retry_after: record.retry_after }
      : {})
  }
}

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
 * Whether a 403 body from Smithers Cloud is the scope refusal a degraded
 * session exists for.
 *
 * Both hosts ask Cloud the same question at sign-in — the Cloudflare Worker in
 * apps/server/src/cloudSession.ts, the desktop app's native host in
 * apps/app/src/bun/CloudAuth.ts — by probing GET /api/user/workspaces with the
 * caller's Cloud PAT. A 403 that means "this token's scopes are short" leaves
 * the person signed in with `scopes: "degraded"`; any other 403 must not.
 * Reading that answer is one rule, so it lives here rather than once per host.
 *
 * The verdict comes off the wire: plue serializes `code` first and clients
 * branch on it, never on `message` (plue pkg/errors/errors.go `APIError`). A
 * body with no plue code — Cloudflare's own block page, another proxy's
 * envelope, a string that merely reads like a scope complaint — cannot publish
 * a signed-in session, whatever English it contains.
 *
 * plue's taxonomy has no code for "this token's scopes are short": the scope
 * gate, the workspaces feature flag, and the repository-bound-token gate all
 * answer `forbidden`, so the code alone cannot separate them and the pinned
 * sentence above picks the scope one out. That is the producer's gap, and
 * fixing it is a change in plue: give `RequireScope` its own registry code
 * (pkg/errors/registry.go) and this function becomes the code test alone.
 *
 * @since 1.0.0
 * @category constants
 */
export const isCloudScopeRefusal = (body: string): boolean =>
  plueFailureCode(machineReadableRefusal(body).code) === "forbidden" && upstreamProse(body) === CLOUD_SCOPE_REFUSAL

/**
 * One sentence a reader can act on for a named upstream that refused, when its
 * own body carries none. The seam's name is the subject, so the reader is told
 * WHICH upstream said no rather than being handed its status alone.
 *
 * @since 1.0.0
 * @category constants
 */
export const upstreamRefusalMessage = (seam: string, status: number, body: string): string => {
  const prose = upstreamProse(body)
  if (prose !== undefined) return prose
  if (status === 404) return `${seam} doesn't serve that request.`
  if (status === 401 || status === 403) return `${seam} refused that request for your account.`
  if (status === 429) return `${seam} is rate-limiting this account right now. Try again in a minute.`
  if (status >= 500) return `${seam} is having trouble right now (HTTP ${status}).`
  return `${seam} refused that request (HTTP ${status}).`
}
