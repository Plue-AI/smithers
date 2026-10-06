import * as Effect from "effect/Effect"
import { DOCS_REDIRECTS, README_URL } from "./docsRedirectMap"
import { fetchWithDeadline, readBoundedJson, Transport } from "./Http"

/*
 * The retired library docs sites (T-DOC-04, #3510): a separate Worker,
 * `smithers-docs-redirect` (wrangler.docs-redirect.jsonc, entry
 * src/docsRedirectWorker.ts), never the shared edge. docs/docs-redirect.md is the runbook: inventory, routes, DNS.
 *
 * `<slug>.smithers.sh/<any path>` answers 301 to the slug's package docs/
 * folder on GitHub. The Location comes from DOCS_REDIRECTS alone: the Host
 * picks a key and the path is dropped, so no part of the request reaches the
 * answer and the target is always the smithersai/smithers repository.
 *
 * Every other request passes through unchanged. The default config attaches
 * only the per-slug routes, so nothing else reaches this Worker. The opt-in
 * `unknown-slugs` env adds a `*.smithers.sh/*` route; under it, a single-label
 * host outside the map goes to the README only when DNS proves no record
 * claims the name: the wildcard TXT marker below is visible at a name only
 * when no explicit record of any type exists there.
 */

export const ZONE_SUFFIX = ".smithers.sh"

/** The TXT data `*.smithers.sh` carries in the unknown-slugs setup. */
export const UNCLAIMED_MARKER = "smithers-unclaimed=docs-redirect"

/** How `UNKNOWN_SLUGS` turns on the README redirect; anything else is off. */
export const UNKNOWN_SLUGS_TXT_MARKER = "txt-marker"

export interface DocsRedirectEnv {
  readonly UNKNOWN_SLUGS?: string
}

export type DocsRedirectDecision =
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "unknown-slug"; readonly hostname: string }
  | { readonly kind: "pass" }

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** What a request URL asks for, from its hostname alone. */
export const decide = (url: URL): DocsRedirectDecision => {
  const hostname = url.hostname
  if (!hostname.endsWith(ZONE_SUFFIX)) return { kind: "pass" }
  const label = hostname.slice(0, -ZONE_SUFFIX.length)
  if (!LABEL.test(label)) return { kind: "pass" }
  const location = DOCS_REDIRECTS.get(label)
  return location === undefined ? { kind: "unknown-slug", hostname } : { kind: "redirect", location }
}

const permanent = (location: string): Response =>
  new Response(null, { status: 301, headers: { location, "cache-control": "public, max-age=3600" } })

const DNS_TIMEOUT_MS = 2_000
const CACHE_TTL_MS = 300_000
const unclaimedCache = new Map<string, { readonly unclaimed: boolean; readonly expires: number }>()

/** Whether a DNS-over-HTTPS answer for `hostname` TXT carries the wildcard marker. */
export const answerIsUnclaimed = (hostname: string, body: unknown): boolean => {
  if (typeof body !== "object" || body === null || !("Status" in body) || body.Status !== 0) return false
  const answers = "Answer" in body && Array.isArray(body.Answer) ? body.Answer as ReadonlyArray<unknown> : []
  return answers.some(answer => typeof answer === "object" && answer !== null &&
    "type" in answer && answer.type === 16 &&
    "name" in answer && typeof answer.name === "string" && answer.name.replace(/\.$/, "") === hostname &&
    "data" in answer && answer.data === JSON.stringify(UNCLAIMED_MARKER))
}

/** Any DNS failure reads as claimed, so the request passes through. */
const isUnclaimed = (hostname: string): Effect.Effect<boolean, never, Transport> =>
  Effect.gen(function* () {
    const now = Date.now()
    const cached = unclaimedCache.get(hostname)
    if (cached !== undefined && cached.expires > now) return cached.unclaimed
    const query = new URL("https://cloudflare-dns.com/dns-query")
    query.searchParams.set("name", hostname)
    query.searchParams.set("type", "TXT")
    const response = yield* fetchWithDeadline("dns", query, { headers: { accept: "application/dns-json" } }, DNS_TIMEOUT_MS)
    const unclaimed = response.ok && answerIsUnclaimed(hostname, yield* readBoundedJson(response, 65_536))
    unclaimedCache.set(hostname, { unclaimed, expires: now + CACHE_TTL_MS })
    return unclaimed
  }).pipe(Effect.catch(() => Effect.succeed(false)))

const passThrough = (request: Request): Effect.Effect<Response, never, Transport> =>
  Transport.use(transport => transport.fetch("pass-through", request)).pipe(
    Effect.catch(() => Effect.succeed(new Response("Bad Gateway", { status: 502 })))
  )

export const handleDocsRedirect = (request: Request, env: DocsRedirectEnv): Effect.Effect<Response, never, Transport> =>
  Effect.gen(function* () {
    const decision = decide(new URL(request.url))
    if (decision.kind === "redirect") return permanent(decision.location)
    if (decision.kind === "unknown-slug" && env.UNKNOWN_SLUGS === UNKNOWN_SLUGS_TXT_MARKER &&
      (yield* isUnclaimed(decision.hostname))) return permanent(README_URL)
    return yield* passThrough(request)
  })
