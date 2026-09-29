import { BILLING_OVERVIEW_PATH, BILLING_PLANS_PATH } from "@smthrs/rpc/AgentApiRoutes"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { browserFetchResponseBody, browserFetchWorkerCode } from "@smthrs/rpc/BrowserFetch"
import { CLOUD_ROUTE_PREFIX } from "@smthrs/rpc/CloudTunnel"
/*
 * The machine-readable half of an upstream refusal, shared with the desktop
 * app's native host (@smthrs/rpc/UpstreamProse): both hosts restate the same
 * upstreams for the same reader, so the two keep one rule.
 */
import { machineReadableRefusal } from "@smthrs/rpc/UpstreamProse"
import { CLIENT_ERROR_UNKNOWN_SOURCE, ClientErrors } from "./clientErrorLog"
import { exportClientError } from "./clientErrorTelemetry"
import { ServerConfig } from "./Config"
import { BrowserEgress } from "./Environment"
import type { DeploymentBindings, ExecutionContext } from "./Environment"
import { cloudTokenResponse, fetchCloudToken } from "./cloudToken"
import type { CloudTokenOutcome } from "./cloudToken"
import { discardBody, fetchWithDeadline, readBoundedBytes, readRefusalDetail } from "./Http"
import type { Transport } from "./Http"
import { isVisitorRefusal, requireTurnSession, validateSession } from "./identity"
import { cloudReadPath, isPublicRepositoryRead, readPublicRepository } from "./publicRepositoryReads"
import { json, notFound, operatorRefusal, readBody, refuse, upstreamProse, upstreamUnreachable, withIsolationHeaders } from "./Responses"
import { anonymousBucketAddress } from "./turnLimit"

/*
 * The curated platform proxy (MULTI-ACTIONS-GAP.md Tier 1/2): the browser
 * calls these paths same-origin; the Worker validates the session, mints the
 * user's own Smithers Cloud token, and forwards with that bearer
 * (`forwardToCloud`). An ALLOWLIST, never a wildcard —
 * every proxied family is one the product ships commands for. Note
 * Billing overview, plans, checkout, and portal are exact platform routes.
 * Other /api/billing/* routes, including balance, stay with the product
 * billing worker.
 *
 * Exported for the host parity matrix (apps/app/docs/web-mode/PLAN.md §6):
 * every cloud-present flow whose seam calls `/api/*` or `/api/cloud/*` must
 * name a row here, and the test reads the table the router uses.
 */
export const PLATFORM_PROXY_RULES: ReadonlyArray<{
  readonly prefix?: string
  readonly exact?: string
  readonly methods: ReadonlyArray<string>
}> = [
  { prefix: "/api/repos/", methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  { prefix: "/api/github/import", methods: ["GET", "POST"] },
  /* The signed-in user's mirrored repositories: the web funnel's first list (W0). */
  { prefix: "/api/user/repos", methods: ["GET"] },
  /* Source-only repo inventory and metadata (RepositoriesSeam ranking, import-readiness fallback): reads only. */
  { prefix: "/api/user/github-repos", methods: ["GET"] },
  /*
   * Per-user cloud reads the app renders as trees and rows (RepositoriesSeam,
   * WorkspaceSeam). Every row below names only the methods a seam under
   * apps/app/src/mainview/state/seams calls today: the bridge hands the page
   * whatever the platform answers, so a method here is a capability, and a
   * lane that needs a new one adds it in the same commit as its seam
   * (parity-hosts.test.ts (b) reads this table).
   */
  { prefix: "/api/user/workspaces", methods: ["GET"] },
  { prefix: "/api/user/orgs", methods: ["GET"] },
  /* Account-owned coding accounts: list, Claude enrollment, revocation, pool order, Codex device sign-in. */
  { exact: "/api/user/provider-connections", methods: ["GET", "POST"] },
  { prefix: "/api/user/provider-connections/", methods: ["DELETE", "PUT", "POST"] },
  /* ChangeSeam: the changeset DTO, and landing one (ADR 0003). */
  { prefix: "/api/orgs/", methods: ["GET", "POST"] },
  { prefix: "/api/notifications/", methods: ["GET", "PUT"] },
  { exact: BILLING_OVERVIEW_PATH, methods: ["GET"] },
  { exact: BILLING_PLANS_PATH, methods: ["GET"] },
  { exact: "/api/billing/checkout", methods: ["POST"] },
  { exact: "/api/billing/portal", methods: ["POST"] }
]

const PLATFORM_PROXY_MAX_BODY = 256 * 1024
const platformBodyLimit = (pathname: string, method: string): number => {
  // Wiki updates carry a 1 MiB binary Yjs update in a base64 JSON envelope.
  if (method === "POST" && /^\/api\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/wiki\/[a-z0-9-]+\/updates$/.test(pathname)) {
    return 2 * 1024 * 1024
  }
  // Cap the whole setup document at 8 MiB. JSON escapes can expand a valid
  // 1 MiB script to 6 MiB, leaving room for its envelope and small env values.
  if (method === "PUT" && /^\/api\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/agent-environment$/.test(pathname)) {
    return 8 * 1024 * 1024
  }
  return PLATFORM_PROXY_MAX_BODY
}

/**
 * What to tell a reader when Smithers Cloud refuses. The upstream's own body is
 * used only when it carries prose; a router's plain-text 404 or an HTML error
 * page is replaced by a sentence, never forwarded.
 */
const platformFailureMessage = (status: number, body: string): string => {
  const prose = upstreamProse(body)
  if (prose !== undefined) return prose
  if (status === 404) return "Smithers Cloud doesn't serve that request on this deployment."
  if (status === 401 || status === 403) return "Smithers Cloud refused that request for your account."
  if (status === 429) return "Smithers Cloud is rate-limiting this account right now. Try again in a minute."
  if (status >= 500) return `Smithers Cloud is having trouble right now (HTTP ${status}).`
  return `Smithers Cloud refused that request (HTTP ${status}).`
}

/**
 * Whether `pathname` falls under one rule's path. A prefix opens its family
 * only at a segment boundary: `/api/user/repos` answers itself and
 * `/api/user/repos/...`, never `/api/user/repos-admin`, which would otherwise
 * leave with the user's Cloud bearer.
 */
export const platformProxyRuleCovers = (
  rule: (typeof PLATFORM_PROXY_RULES)[number],
  pathname: string
): boolean => {
  if (rule.exact !== undefined) return pathname === rule.exact
  if (rule.prefix === undefined) return false
  if (rule.prefix.endsWith("/")) return pathname.startsWith(rule.prefix)
  return pathname === rule.prefix || pathname.startsWith(`${rule.prefix}/`)
}

/*
 * The provider-connection item routes the account pool uses, each one exact:
 * revoke one connection, set one provider's order, and start or poll one
 * Codex device sign-in. Nothing else under the family forwards.
 */
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
const providerConnectionItem = (pathname: string, method: string): boolean =>
  (method === "DELETE" && /^\/api\/user\/provider-connections\/[A-Za-z0-9-]{1,100}$/.test(pathname) && pathname !== "/api/user/provider-connections/order") ||
  (method === "PUT" && pathname === "/api/user/provider-connections/order") ||
  (method === "POST" && pathname === "/api/user/provider-connections/codex/device") ||
  (method === "POST" && new RegExp(`^/api/user/provider-connections/codex/device/${UUID}$`).test(pathname))

export const platformProxyMatch = (pathname: string, method: string): boolean =>
  !/\/issues\/[^/]+\/linear-link(?:\/|$)/.test(pathname) &&
  (!pathname.startsWith("/api/user/provider-connections/") || providerConnectionItem(pathname, method)) &&
  PLATFORM_PROXY_RULES.some((rule) => rule.methods.includes(method) && platformProxyRuleCovers(rule, pathname))

/** An anonymous catalog read, restated in the seam's envelope when the mirror refuses. */
const publicAnswer = (url: URL): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const response = yield* readPublicRepository(url, config.cloudApiBaseUrl)
    if (response.ok) return response
    const detail = yield* readRefusalDetail(response)
    const failure = json(response.status, {
      status: "error",
      message: platformFailureMessage(response.status, detail)
    })
    failure.headers.set("cache-control", "private, no-store")
    const vary = response.headers.get("vary")
    if (vary !== null) failure.headers.set("vary", vary)
    return failure
  })

export const handlePlatformProxy = (
  request: Request,
  url: URL
): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const publicRead = isPublicRepositoryRead(request.method, url.pathname)
    // A cookie no identity seam can read is no cookie: the read stays public.
    const unreadableCookie = !request.headers.has("cookie") || config.identityUpstreamUrl === undefined
    if (publicRead && unreadableCookie) return withIsolationHeaders(yield* publicAnswer(url))
    const gate = yield* requireTurnSession(request)
    if (publicRead && isVisitorRefusal(gate)) return withIsolationHeaders(yield* publicAnswer(url))
    if (gate instanceof Response) return gate
    // Closing sales must not lock existing customers out of their portal.
    if ((url.pathname === "/api/billing/checkout" && !config.billingCheckoutEnabled) ||
        (url.pathname === "/api/billing/portal" && !config.billingPortalEnabled)) {
      return refuse(
        "feature_unavailable_here",
        url.pathname === "/api/billing/portal" ? "The billing portal is unavailable on this host." : "Checkout is unavailable on this host."
      )
    }
    return yield* forwardToCloud(request, gate.login, {
      path: (publicRead ? cloudReadPath(url.pathname) : url.pathname) + url.search,
      bodyLimit: platformBodyLimit(url.pathname, request.method),
      deadlineMs: config.upstreamTimeoutMs,
      // A provider setup token crossed this proxy only in the request body.
      // Never reflect upstream prose or fields for its write endpoints.
      ...(url.pathname.startsWith("/api/user/provider-connections") && request.method !== "GET"
        ? { quietRefusal: "provider_connection_refused" }
        : {})
    })
  })

/** How one signed-in request is forwarded to Smithers Cloud as its user. */
export interface CloudForward {
  /** The Cloud path and query, joined onto the Cloud origin. */
  readonly path: string
  /** The most request body read before the forward is refused. */
  readonly bodyLimit: number
  /** How long Cloud may take to send its answer's headers. */
  readonly deadlineMs: number
  /** A success body is read whole under this bound; absent, it streams through. */
  readonly answerMaxBytes?: number
  /** The only fact a refusal may carry: its status and this code. */
  readonly quietRefusal?: string
}

/**
 * Forward one request to Smithers Cloud as `login`: the user's Cloud token
 * is the bearer (minted again, once, when Cloud rejects it), the body is read
 * under its bound, and Cloud's status and body come back. A refusal's prose is
 * restated; its machine-readable facts are kept. Every Worker route that
 * reaches Cloud as the signed-in user goes through here.
 */
export const forwardToCloud = (
  request: Request,
  login: string,
  forward: CloudForward
): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const token = yield* fetchCloudToken(login)
    if (token.status !== "ok") return tokenRefusal(token)
    let body: Uint8Array<ArrayBuffer> | undefined
    if (request.method !== "GET" && request.method !== "HEAD") {
      const read = yield* Effect.result(readBoundedBytes(request, forward.bodyLimit))
      if (Result.isFailure(read)) {
        return read.failure._tag === "BodyTooLarge"
          ? refuse("request_body_too_large", "Request body too large.")
          : refuse("request_invalid", "Invalid request.")
      }
      body = read.success
    }
    // The path is joined onto the platform's origin and must still be there
    // once parsed: a bearer never leaves for any other host.
    const target = new URL(forward.path, config.cloudApiBaseUrl)
    if (target.origin !== new URL(config.cloudApiBaseUrl).origin) return notFound()
    const send = (token: string) => {
      const headers = new Headers({ authorization: `Bearer ${token}` })
      const contentType = request.headers.get("content-type")
      if (contentType !== null) headers.set("content-type", contentType)
      const accept = request.headers.get("accept")
      if (accept !== null) headers.set("accept", accept)
      // SSE reconnect positions belong to the committed upstream stream. The
      // proxy must not turn a resumed read into an implicit read from zero.
      const lastEventId = request.headers.get("last-event-id")
      if (request.method === "GET" && lastEventId !== null) headers.set("last-event-id", lastEventId)
      return Effect.result(fetchWithDeadline(
        "Smithers Cloud",
        target.toString(),
        { method: request.method, headers, ...(body === undefined ? {} : { body }) },
        forward.deadlineMs
      ))
    }
    let fetched = yield* send(token.token)
    // Cloud rejected the vaulted token (expired or revoked): the door mints
    // from the vaulted GitHub token again, so one fresh token may succeed.
    // More than one retry would be a loop.
    if (Result.isSuccess(fetched) && fetched.success.status === 401) {
      yield* discardBody(fetched.success)
      const reminted = yield* fetchCloudToken(login)
      if (reminted.status !== "ok") return tokenRefusal(reminted)
      fetched = yield* send(reminted.token)
    }
    if (Result.isFailure(fetched)) return upstreamUnreachable("Smithers Cloud", fetched.failure)
    const upstream = fetched.success
    // The Transport never follows a redirect (the Location would get the
    // bearer), so a 3xx is Cloud's answer, and it is no page's success.
    if (upstream.status >= 300 && upstream.status < 400) {
      yield* discardBody(upstream)
      return refuse("upstream_refused", `Smithers Cloud answered an unexpected redirect (HTTP ${upstream.status}).`)
    }
    /*
     * A failure's PROSE never passes through: the upstream's body is written
     * for its own callers, and the product renders whatever comes back
     * straight to the user. Restate it in the seam's own envelope so a reader
     * always gets a sentence, and the shape matches every other refusal this
     * Worker makes. The machine-readable facts beside the prose — `code`,
     * `retry_after`, and the `Retry-After` header — are kept: they are what a
     * client acts on, and dropping the code left a caller unable to tell a
     * full fleet from its own quota.
     */
    if (upstream.status >= 400) {
      const detail = yield* readRefusalDetail(upstream)
      if (forward.quietRefusal !== undefined) return json(upstream.status, { status: "error", code: forward.quietRefusal })
      const failure = json(upstream.status, {
        status: "error",
        message: platformFailureMessage(upstream.status, detail),
        ...machineReadableRefusal(detail)
      })
      const retryAfter = upstream.headers.get("retry-after")
      if (retryAfter !== null) failure.headers.set("retry-after", retryAfter)
      return failure
    }
    // Status and body pass through; upstream headers do not (no set-cookie, no
    // upstream CORS) — only the content type survives.
    const out = new Headers()
    out.set("cache-control", "private, no-store")
    const upstreamType = upstream.headers.get("content-type")
    if (upstreamType !== null) out.set("content-type", upstreamType)
    if (forward.answerMaxBytes === undefined) return new Response(upstream.body, { status: upstream.status, headers: out })
    // A bounded answer is read whole: past the bound the read stops and the
    // rest is cancelled, never buffered.
    const answer = yield* Effect.result(readBoundedBytes(upstream, forward.answerMaxBytes))
    if (Result.isFailure(answer)) {
      return answer.failure._tag === "BodyTooLarge"
        ? refuse("upstream_malformed", `Smithers Cloud's answer is larger than ${forward.answerMaxBytes / (1024 * 1024)} MiB.`)
        : refuse("upstream_unreachable", "Smithers Cloud's answer broke off before it ended.")
    }
    return new Response(answer.success, { status: upstream.status, headers: out })
  })

const tokenRefusal = (token: Exclude<CloudTokenOutcome, { readonly status: "ok" }>): Response => {
  return cloudTokenResponse(token)
}

/*
 * `GET /api/user`, the ApplicationClient identity read (@smthrs/rpc
 * ApplicationAuth). The local Bun host proxied it and this Worker answered the
 * canonical 404, so a client pointed at smithers.sh could never learn who it
 * was (release run 36077431281). A caller holding its own Smithers Cloud
 * credential (the native app's PAT) is forwarded to that credential's issuer
 * with the header it sent; a browser session goes through the same
 * cookie-to-cloud-token bridge as every other platform read, so a signed-out
 * visitor gets the 401 the client reads as "unauthenticated".
 */
export const handleAuthenticatedUser = (
  request: Request,
  url: URL
): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const authorization = request.headers.get("authorization")
    if (authorization === null) return yield* handlePlatformProxy(request, url)
    const config = yield* ServerConfig
    const target = new URL("/api/user", config.cloudApiBaseUrl)
    const fetched = yield* Effect.result(
      fetchWithDeadline("Smithers Cloud", target.toString(), { method: "GET", headers: { authorization, accept: "application/json" } }, config.upstreamTimeoutMs)
    )
    if (Result.isFailure(fetched)) return upstreamUnreachable("Smithers Cloud", fetched.failure)
    const upstream = fetched.success
    if (upstream.status >= 300) {
      const detail = yield* readRefusalDetail(upstream)
      const status = upstream.status === 401 || upstream.status === 403 ? upstream.status : 502
      return json(status, { status: "error", message: platformFailureMessage(upstream.status, detail), ...machineReadableRefusal(detail) })
    }
    const out = new Headers({ "cache-control": "private, no-store" })
    const upstreamType = upstream.headers.get("content-type")
    if (upstreamType !== null) out.set("content-type", upstreamType)
    return new Response(upstream.body, { status: upstream.status, headers: out })
  })

/*
 * The `/api/cloud/<inner>` bridge (apps/app/docs/web-mode/PLAN.md §0
 * correction 4). The product's cloud seams call CLOUD_ROUTE_PREFIX + path;
 * the Bun origin forwards that with its Smithers Cloud PAT, and this Worker answered
 * the canonical 404, so on the web the repository list never loaded. The
 * inner path goes through the SAME allowlist and the SAME cookie-to-cloud-
 * token bridge as the direct platform proxy above — one function, so the
 * token, header and failure-message rules cannot fork.
 *
 * The inner path is joined as a plain path, never as a URL (the guard the
 * Bun proxyCloud keeps): `/api/cloud//evil.example/x` sliced naively is
 * scheme-relative and the WHATWG parser would send the bearer to
 * evil.example. `new URL(request.url)` has already folded `..` and `%2e%2e`
 * segments, so a rest the parser would rewrite, or that still carries a dot
 * segment, is refused rather than forwarded. Every refusal is the canonical
 * 404: the bridge enumerates nothing the direct route does not.
 */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i

const cloudInnerUrl = (url: URL): URL | undefined => {
  const rest = url.pathname.slice(CLOUD_ROUTE_PREFIX.length)
  if (rest === "" || rest.startsWith("/") || rest.includes("\\")) return undefined
  const pathname = `/${rest}`
  if (pathname.split("/").some((segment) => DOT_SEGMENT.test(segment))) return undefined
  const inner = new URL(pathname + url.search, url.origin)
  if (inner.origin !== url.origin || inner.pathname !== pathname) return undefined
  return inner
}

export const handleCloudProxy = (request: Request, url: URL): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.suspend(() => {
    const inner = cloudInnerUrl(url)
    if (inner === undefined || !platformProxyMatch(inner.pathname, request.method)) return Effect.succeed(notFound())
    return handlePlatformProxy(request, inner)
  })

/*
 * The browser tool's fetch route (Wave 10, §2d): session-gated exactly like
 * a turn — the deployment's network egress is a resource — and read-tier: it
 * changes nothing upstream. The guards live in the egress service.
 */
export const handleBrowserFetch = (request: Request): Effect.Effect<Response, never, BrowserEgress> =>
  Effect.gen(function* () {
    const body = yield* readBody(request)
    if (body instanceof Response) return body
    const url = typeof body === "object" && body !== null && "url" in body && typeof body.url === "string"
      ? body.url
      : undefined
    if (url === undefined || url.trim() === "") {
      return refuse("request_invalid", "Body must be { url }.")
    }
    const egress = yield* BrowserEgress
    if (Option.isNone(egress)) {
      return refuse("feature_unavailable_here", "Web page reading is unavailable on this host. Open it in the native app.")
    }
    const outcome = yield* egress.value.read(url.trim()).pipe(Effect.result)
    // The egress binding itself failed: the page was never reached, so a dependency is at fault.
    if (Result.isFailure(outcome)) {
      return operatorRefusal("upstream_unreachable", "That page can't be read right now. Try again in a moment.", "browser egress", outcome.failure)
    }
    if (!outcome.success.ok) return refuse(browserFetchWorkerCode(outcome.success.code), outcome.success.message)
    return json(200, browserFetchResponseBody(outcome.success))
  })

/*
 * Frontend error ingest on the Go backend's own route, so the renderer posts
 * one path whichever target serves it: bounded body, logged to the worker
 * tail, kept in the client-error log. The throttle is the log's own
 * (clientErrorLog.ts): a counter here would be per isolate, and workerd runs
 * as many isolates as a flood asks for.
 */
export const CLIENT_ERRORS_PATH = "/api/telemetry/errors"
const CLIENT_ERROR_MAX_BODY = 16 * 1024

/**
 * The source a report is counted against: the client address Cloudflare
 * reports, one IPv6 /64 per bucket as for anonymous turns. Never stored.
 */
const clientErrorSource = (request: Request): string => {
  const ip = request.headers.get("cf-connecting-ip")?.trim() ?? ""
  return ip === "" ? CLIENT_ERROR_UNKNOWN_SOURCE : anonymousBucketAddress(ip)
}

/** The session cookie the identity worker sets. Its value is never read here, only its presence. */
const SESSION_COOKIE = "smithers_session"

/** Avoid an identity request when no session cookie was supplied. */
const carriesSessionCookie = (request: Request): boolean =>
  (request.headers.get("cookie") ?? "").split(";").some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`))

export const handleClientError = (request: Request): Effect.Effect<Response, never, ClientErrors | ServerConfig | Transport | DeploymentBindings | ExecutionContext> =>
  Effect.gen(function* () {
    const read = yield* Effect.result(readBoundedBytes(request, CLIENT_ERROR_MAX_BODY))
    if (Result.isFailure(read)) {
      return read.failure._tag === "BodyTooLarge"
        ? refuse("request_body_too_large", "Error report too large.")
        : refuse("request_invalid", "Invalid request.")
    }
    const text = new TextDecoder().decode(read.success)
    // The log is what makes an alpha user's crash readable afterwards, through
    // GET /api/admin/errors; it is bounded, it decides the throttle, and it
    // never fails the report. console.error alone lives exactly as long as
    // someone is tailing, so a throttled report is not worth a tail line.
    const referer = request.headers.get("referer")
    const userAgent = request.headers.get("user-agent")
    const errors = yield* ClientErrors
    const session = carriesSessionCookie(request) ? yield* validateSession(request) : undefined
    const outcome = yield* errors.append(
      {
        at: new Date().toISOString(),
        ...(referer === null ? {} : { page: referer }),
        ...(userAgent === null ? {} : { userAgent }),
        ...(session?.status === "valid" ? { signedIn: true } : {}),
        report: ((): unknown => {
          try {
            return JSON.parse(text)
          } catch {
            return text
          }
        })()
      },
      session?.status === "valid" ? `login:${session.identity.login.toLowerCase()}` : clientErrorSource(request)
    )
    if (outcome === "throttled") {
      return refuse("error_reports_throttled", "Too many error reports.")
    }
    yield* Effect.sync(() => console.error("client-error:", text))
    yield* exportClientError(outcome)
    return json(202, { status: "accepted" })
  })
