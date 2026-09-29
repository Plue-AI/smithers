import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import { AUTH_RETURN_TO_PARAM, AUTH_SIGNED_IN_PARAM } from "@smthrs/rpc/AgentApiRoutes"
import { ServerConfig } from "./Config"
import type { UpstreamFailure } from "./Failures"
import { discardBody, fetchWithDeadline, readJsonOrUndefined, readRefusalDetail } from "./Http"
import type { Transport } from "./Http"
import {
  ISOLATION_HEADERS,
  json,
  notConfigured,
  notFound,
  refuse,
  siblingAdminRoute,
  strippedHeaders,
  upstreamUnreachable,
  withProxyOrigin
} from "./Responses"

/*
 * The identity seam: the identity worker (GitHub OAuth + allowlist) is the
 * identity authority. This module validates a session against it, proxies
 * the auth and identity routes to it, and turns its answers on the two
 * top-level OAuth navigations into pages a person can read.
 */

const IDENTITY_SEAM = "The identity service"

/** A deployment with no identity seam: an infra fault, never an open door. */
const identityNotConfigured = (): Response =>
  notConfigured("Sign-in", "IDENTITY_UPSTREAM_URL is unset. Sign-in is unavailable")

/** Forward one already-built request under the seam's deadline, never failing. */
export const forwardUnderDeadline = (
  seam: string,
  target: Request,
  timeoutMs: number
): Effect.Effect<Response, never, Transport> =>
  fetchWithDeadline(seam, target, undefined, timeoutMs).pipe(
    Effect.catch((failure: UpstreamFailure) => Effect.succeed(upstreamUnreachable(seam, failure)))
  )

/**
 * The identity worker sets and reads its own session cookie, so the proxy
 * forwards cookies untouched but still strips client-supplied identity
 * headers — a browser must never inject x-user-*.
 */
export const proxyToIdentity = (request: Request): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    if (config.identityUpstreamUrl === undefined) return identityNotConfigured()
    const url = new URL(request.url)
    if (siblingAdminRoute(url.pathname)) return notFound()
    const target = new URL(url.pathname + url.search, config.identityUpstreamUrl)
    const headers = strippedHeaders(request)
    withProxyOrigin(headers, url)
    // The identity worker rate-limits its OAuth routes per client address,
    // and at the upstream cf-connecting-ip is THIS Worker's subrequest
    // address — every user in one bucket. Attest the browser's address
    // beside the service token the upstream already trusts; the upstream
    // ignores the address without the token, and strippedHeaders above
    // dropped any client-supplied copy of either.
    const clientAddress = request.headers.get("cf-connecting-ip")?.trim() ?? ""
    if (clientAddress !== "" && config.identityServiceToken !== undefined) {
      headers.set("x-smithers-client-ip", clientAddress)
      headers.set("x-smithers-service-token", Redacted.value(config.identityServiceToken))
    }
    return yield* forwardUnderDeadline(
      IDENTITY_SEAM,
      new Request(target.toString(), new Request(request, { headers })),
      config.upstreamTimeoutMs
    )
  })

/* ------------------------------------------------------------------------ */
/* Session validation                                                        */
/* ------------------------------------------------------------------------ */

export interface ValidatedIdentity {
  readonly login: string
  readonly allowlisted: boolean
  /** Identity authority's public admission decision; never inferred from a missing allowlist row. */
  readonly admitted?: boolean
  readonly admin: boolean
  readonly scopes: ReadonlyArray<string>
}

export type SessionValidation =
  | { readonly status: "valid"; readonly identity: ValidatedIdentity }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable"; readonly response: Response }

/**
 * Validate the caller's session cookie against the identity worker's
 * service-token endpoint (the contract's trusted-proxy validation path).
 * Keeps an invalid session distinct from an unavailable identity service so
 * an outage can never be restated as "Sign in".
 */
export const validateSession = (request: Request): Effect.Effect<SessionValidation, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const upstream = config.identityUpstreamUrl
    if (upstream === undefined) return { status: "invalid" } as const
    // Identity decides a validate by the session cookie alone, so a request
    // with no cookie is signed out without a subrequest. Asking anyway made
    // every cookieless call to a gated route an identity invocation.
    const cookie = request.headers.get("cookie")?.trim() ?? ""
    if (cookie === "") return { status: "invalid" } as const
    const headers: Record<string, string> = { "content-type": "application/json", cookie }
    if (config.identityServiceToken !== undefined) {
      headers["x-smithers-service-token"] = Redacted.value(config.identityServiceToken)
    }
    const fetched = yield* Effect.result(
      fetchWithDeadline(
        IDENTITY_SEAM,
        new URL("/api/identity/validate", upstream).toString(),
        { method: "POST", headers, body: "{}" },
        config.upstreamTimeoutMs
      )
    )
    if (Result.isFailure(fetched)) {
      const failure = fetched.failure
      return {
        status: "unavailable",
        response: upstreamUnreachable(IDENTITY_SEAM, failure)
      } as const
    }
    const response = fetched.success
    if (!response.ok) {
      yield* discardBody(response)
      return response.status === 401
        ? { status: "invalid" } as const
        : {
          status: "unavailable",
          response: refuse("upstream_refused", `The identity service answered HTTP ${response.status}.`)
        } as const
    }
    const body = (yield* readJsonOrUndefined(response)) as {
      login?: unknown
      allowlisted?: unknown
      admission?: unknown
      admin?: unknown
      scopes?: unknown
    } | undefined
    if (body === undefined || typeof body !== "object" || body === null || typeof body.login !== "string" || body.login === "") {
      // Identity decides a validate by the session cookie alone and answers a
      // missing, stale, or foreign-secret one with a loginless 200. That is a
      // signed-out visitor, not a malformed answer, and the 401 is what opens
      // the anonymous catalog door (anonymousCatalogTurn). Other first-party
      // cookies (the live-tutorial cookie, an edge cookie) say nothing about
      // the session, so only an unparseable body is identity misbehaving.
      if (body !== undefined) return { status: "invalid" } as const
      return {
        status: "unavailable",
        response: refuse("upstream_malformed", "The identity service returned a malformed session response.")
      } as const
    }
    return {
      status: "valid",
      identity: {
        login: body.login,
        allowlisted: body.allowlisted === true,
        ...(body.admission === "public" ? { admitted: true } : {}),
        admin: body.admin === true,
        scopes: Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === "string") : []
      }
    } as const
  })

/**
 * The turn seam spends the deployment's own model credential and meters real
 * dollars onto the deployment's billing account, so it must never answer an
 * anonymous caller. The same-origin guard is not that gate: it only fires for
 * a request that *sends* an `Origin`, so a plain `curl -X POST` sails past it.
 * Wave 7 published this Worker at canary.smithers.sh, where that made
 * `/api/agent/turn` a world-reachable spend.
 *
 * When IDENTITY_UPSTREAM_URL is unset (a dropped or blank var) no seam can
 * authenticate anyone, so the gate fails closed with deployment_not_configured
 * and the deployment's keys stay unspent.
 *
 * The one exception is decided by the router, not here: a turn from a
 * visitor (isVisitorRefusal) about a public catalog repository runs under the
 * anonymous per-address ceiling. Every other route keeps this refusal.
 */
export const requireTurnSession = (
  request: Request
): Effect.Effect<Response | ValidatedIdentity, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    if (config.identityUpstreamUrl === undefined) return identityNotConfigured()
    const validation = yield* validateSession(request)
    if (validation.status === "unavailable") return validation.response
    if (validation.status === "invalid") {
      return refuse("sign_in_required", "Sign in to run a Smithers turn.")
    }
    const session = validation.identity
    if (!session.allowlisted && !session.admitted) {
      return refuse("account_not_allowlisted", "This account is not in the closed-alpha allowlist yet.")
    }
    return session
  })

/**
 * A turn-gate refusal that leaves the caller on the visitor's surface: signed
 * out (401) or signed in without admission (403). Neither vouches an account,
 * so both get exactly what a signed-out visitor gets and nothing more. An
 * identity outage (5xx) is never one of them.
 */
export const isVisitorRefusal = (gate: Response | ValidatedIdentity): gate is Response =>
  gate instanceof Response && (gate.status === 401 || gate.status === 403)

/* ------------------------------------------------------------------------ */
/* The OAuth navigations                                                     */
/* ------------------------------------------------------------------------ */

/*
 * Wave 8 — no dead ends on the live surface.
 *
 * The OAuth start/callback routes are TOP-LEVEL PAGE NAVIGATIONS: the user
 * clicks "Sign in with GitHub" and the browser loads the route as a document.
 * When the identity upstream answers anything but a redirect (OAuth
 * unconfigured → 503, an upstream 4xx/5xx, an unreachable service), passing
 * the response through would strand the user on a browser-rendered blob of
 * raw JSON — an error that says neither what they were doing nor the next
 * step. So at this seam a non-redirect upstream answer becomes a minimal,
 * self-contained branded page that states honestly what happened and offers
 * the one way back home. Callers that ask for JSON (`Accept:
 * application/json`) keep the machine-readable upstream answer verbatim, and
 * the HTTP status is preserved either way.
 *
 * The heading/detail strings below are constants composed with an integer
 * status code, plus — on the OAuth refusal path — GitHub's `error` and
 * `error_description` query params. Those two are attacker-controllable (any
 * site can link a user at the callback with a crafted query string), so they
 * are HTML-escaped at interpolation time in oauthCallbackRefusal below; no
 * user input reaches the page raw.
 */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] ?? char)

const prefersJson = (request: Request): boolean => {
  const accept = request.headers.get("accept") ?? ""
  return accept.includes("application/json") && !accept.includes("text/html")
}

const authErrorPage = (heading: string, detail: string): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${heading} — Smithers</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
	margin: 0;
	min-height: 100vh;
	display: grid;
	place-items: center;
	background: #f7f4ee;
	color: #211d18;
	font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	-webkit-font-smoothing: antialiased;
}
.card {
	max-width: 30rem;
	margin: 1.5rem;
	padding: 2.5rem 2.25rem;
	background: #fffefa;
	border: 1px solid #e4ddcf;
	border-radius: 16px;
	box-shadow: 0 1px 2px rgb(33 29 24 / 4%), 0 12px 32px rgb(33 29 24 / 10%);
}
.wordmark {
	margin: 0 0 1.75rem;
	font-size: 0.7813rem;
	font-weight: 600;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: #0f766e;
}
.wordmark::after {
	content: "";
	display: block;
	width: 2rem;
	height: 2px;
	margin-top: 0.5rem;
	background: #e8a33d;
	border-radius: 999px;
}
h1 {
	margin: 0 0 0.875rem;
	font-size: 1.375rem;
	line-height: 1.35;
	font-weight: 650;
}
.detail {
	margin: 0 0 2rem;
	font-size: 0.9375rem;
	line-height: 1.6;
	color: #4a443b;
}
.home {
	display: inline-block;
	padding: 0.625rem 1.25rem;
	border-radius: 10px;
	background: #0f766e;
	color: #fffefa;
	font-size: 0.9375rem;
	font-weight: 600;
	text-decoration: none;
}
.home:hover { background: #0b5b57; }
</style>
</head>
<body>
<main class="card">
<p class="wordmark">Smithers</p>
<h1>${heading}</h1>
<p class="detail">${detail}</p>
<a class="home" href="/">Back to Smithers</a>
</main>
</body>
</html>`

const authErrorResponse = (status: number, heading: string, detail: string): Response =>
  new Response(authErrorPage(heading, detail), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      ...ISOLATION_HEADERS
    }
  })

const OAUTH_OFF_HEADING = "GitHub sign-in isn't switched on yet for this preview."

/*
 * GitHub reports a refused authorization on the callback as `?error=…` with no
 * `code`. Forwarded to identity, that reads as a malformed callback and the
 * page told the user "the sign-in service answered HTTP 400" — blaming a
 * service for a button the user pressed (repro
 * apps/app/canary-repros/access/2.3). The cause is knowable from the query
 * string, so it is read here and named.
 *
 * `access_denied` is not a failure: the user declined, the app did exactly what
 * it was told, and nothing was signed in. It answers 200 with that sentence.
 * Every other documented OAuth error IS a failure of the exchange and keeps a
 * 400 with the error GitHub named.
 */
const OAUTH_DENIED_HEADING = "You cancelled the GitHub sign-in."

const oauthCallbackRefusal = (url: URL): { status: number; heading: string; detail: string } | undefined => {
  const error = url.searchParams.get("error")?.trim()
  if (error === undefined || error === "") return undefined
  if (error === "access_denied") {
    return {
      status: 200,
      heading: OAUTH_DENIED_HEADING,
      detail:
        "You chose not to give Smithers access on GitHub, so the sign-in stopped there. Nothing was signed in and nothing was shared — head back whenever you want to try again."
    }
  }
  const described = url.searchParams.get("error_description")?.trim()
  // Both query params are interpolated into the branded HTML error page, so
  // they are escaped HERE, at interpolation time — the page design is
  // untouched and markup in a crafted callback URL renders as inert text.
  return {
    status: 400,
    heading: "GitHub sign-in didn't finish.",
    detail: `GitHub stopped the sign-in and called it "${escapeHtml(error)}"${
      described === undefined || described === "" ? "" : ` — ${escapeHtml(described)}`
    }. Nothing was signed in — head back and try again.`
  }
}

/*
 * The return path. A sign-in started from a repository page
 * (`/smithersai/smithers`) finished on the landing page, because the identity
 * worker knows one landing (`/?signed-in=github`) and this Worker forwarded
 * the callback's answer untouched. The page that asked travels as
 * `?return_to=` on the start route; this Worker (never the identity worker,
 * which cannot know this origin's pages) keeps it in a short-lived cookie
 * scoped to the two OAuth legs and, once identity answers the callback with
 * its success redirect, sends the browser back to that page with the same
 * `signed-in=github` marker the landing page would have carried.
 *
 * SECURITY. `return_to` is attacker-controllable (any site can link a user at
 * the start route with a crafted query string) and the callback turns it into
 * a redirect, which is the open-redirect shape. It is accepted only as a
 * same-origin absolute path: one leading slash; no scheme, host, or second
 * slash (`//evil` and `/\evil` both resolve off-origin in browsers); no
 * backslash, control character, or newline anywhere (header injection); at
 * most 512 bytes; never an `/api/` route (a page, not a redirect loop). The
 * value is re-validated when the cookie is read, so a tampered cookie is
 * ignored the same way a crafted query is. Anything rejected is dropped and
 * the callback lands where it always did.
 */
const RETURN_TO_COOKIE = "smithers_return_to"
const RETURN_TO_COOKIE_PATH = "/api/auth"
const RETURN_TO_MAX_AGE_SECONDS = 10 * 60
const RETURN_TO_MAX_BYTES = 512
const RETURN_TO_CONTROL = /[\u0000-\u001f\u007f\\]/

/** The same-origin page path `value` names, or undefined when it is anything else. */
export const validReturnTo = (value: string | null | undefined): string | undefined => {
  if (typeof value !== "string" || value === "" || value === "/") return undefined
  if (new TextEncoder().encode(value).byteLength > RETURN_TO_MAX_BYTES) return undefined
  if (!value.startsWith("/") || value.startsWith("//") || RETURN_TO_CONTROL.test(value)) return undefined
  // Belt and braces: the URL parser must agree the path stays on this origin.
  const probe = "https://return-to.invalid"
  let resolved: URL
  try {
    resolved = new URL(value, probe)
  } catch {
    return undefined
  }
  if (resolved.origin !== probe || !resolved.pathname.startsWith("/")) return undefined
  if (resolved.pathname === "/api" || resolved.pathname.startsWith("/api/")) return undefined
  return value
}

const returnToCookie = (value: string | undefined): string =>
  value === undefined
    ? `${RETURN_TO_COOKIE}=; Path=${RETURN_TO_COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
    : `${RETURN_TO_COOKIE}=${encodeURIComponent(value)}; Path=${RETURN_TO_COOKIE_PATH}; Max-Age=${RETURN_TO_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`

/** The validated return path the request's cookie carries, or undefined. */
const readReturnToCookie = (request: Request): string | undefined => {
  const header = request.headers.get("cookie")
  if (header === null) return undefined
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== RETURN_TO_COOKIE) continue
    const raw = part.slice(eq + 1).trim()
    try {
      return validReturnTo(decodeURIComponent(raw))
    } catch {
      return undefined
    }
  }
  return undefined
}

const hasReturnToCookie = (request: Request): boolean =>
  (request.headers.get("cookie") ?? "").split(";").some((part) => part.trim().startsWith(`${RETURN_TO_COOKIE}=`))

const withSetCookie = (response: Response, cookie: string, location?: string): Response => {
  const headers = new Headers(response.headers)
  headers.append("set-cookie", cookie)
  if (location !== undefined) headers.set("location", location)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * The page the callback sends the browser to: the return path plus the marker
 * the identity redirect carried (`signed-in=github` today), or that marker
 * verbatim when identity's redirect carried none.
 */
const returnToLocation = (returnTo: string, upstreamLocation: string, requestUrl: URL): string => {
  const target = new URL(returnTo, requestUrl.origin)
  let upstream: URL | undefined
  try {
    upstream = new URL(upstreamLocation, requestUrl.origin)
  } catch {
    upstream = undefined
  }
  if (upstream !== undefined && upstream.origin === requestUrl.origin) {
    for (const [name, value] of upstream.searchParams) target.searchParams.set(name, value)
  }
  if (!target.searchParams.has(AUTH_SIGNED_IN_PARAM)) target.searchParams.set(AUTH_SIGNED_IN_PARAM, "github")
  return `${target.pathname}${target.search}${target.hash}`
}

export const handleAuthNavigation = (
  incoming: Request,
  route: "start" | "callback"
): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    let request = incoming
    // The start leg reads the page that asked and keeps it out of the forwarded
    // query: the identity worker has no use for it, and GitHub must never see it.
    let returnTo: string | undefined
    if (route === "start") {
      const url = new URL(request.url)
      if (url.searchParams.has(AUTH_RETURN_TO_PARAM)) {
        returnTo = validReturnTo(url.searchParams.get(AUTH_RETURN_TO_PARAM))
        url.searchParams.delete(AUTH_RETURN_TO_PARAM)
        request = new Request(url.toString(), request)
      }
    } else {
      returnTo = readReturnToCookie(request)
    }
    if (route === "callback") {
      const refusal = oauthCallbackRefusal(new URL(request.url))
      if (refusal !== undefined) {
        if (prefersJson(request)) {
          return json(refusal.status, {
            status: refusal.status === 200 ? "cancelled" : "error",
            message: refusal.detail
          })
        }
        return authErrorResponse(refusal.status, refusal.heading, refusal.detail)
      }
    }
    if (config.identityUpstreamUrl === undefined) {
      if (prefersJson(request)) return yield* proxyToIdentity(request)
      return authErrorResponse(
        501,
        OAUTH_OFF_HEADING,
        "You tried to sign in with GitHub, but this preview deployment has no sign-in service configured yet, so the sign-in can't start. Nothing was signed in and nothing was lost."
      )
    }
    const response = yield* proxyToIdentity(request)
    // The proxy never fails: an unreachable seam is its 502/504 JSON envelope,
    // which a machine caller gets verbatim below and a person gets as the
    // page for that status, like any other upstream refusal.
    // The happy path is a redirect: to GitHub from start, back here from callback.
    const location = response.headers.get("location")
    if (response.status >= 300 && response.status < 400 && location !== null) {
      if (route === "start") {
        return returnTo === undefined ? response : withSetCookie(response, returnToCookie(returnTo))
      }
      // Identity's success redirect names its one landing; with a return path
      // on file the browser goes back to the page that asked instead, and the
      // cookie is spent either way.
      if (returnTo !== undefined) {
        return withSetCookie(response, returnToCookie(undefined), returnToLocation(returnTo, location, new URL(request.url)))
      }
      return hasReturnToCookie(request) ? withSetCookie(response, returnToCookie(undefined)) : response
    }
    /*
     * The OTHER happy path (native sign-in handoff): a callback bound to a
     * handoff answers a 200 HTML page — "You're signed in — return to the
     * Smithers app" — because the session travels to the app through the
     * claim endpoint, not this tab. A success page is not an upstream error;
     * replacing it with the 502 surface told a signed-in user nothing was
     * signed in (the live bug).
     */
    if (
      route === "callback" &&
      response.status === 200 &&
      (response.headers.get("content-type") ?? "").includes("text/html")
    ) {
      return response
    }
    if (prefersJson(request)) return response
    // What remains is an upstream error (or a non-redirect oddity): read the
    // machine answer for its code, then replace it with the human page.
    const body = (yield* readRefusalDetail(response)).trim()
    let code: string | undefined
    try {
      const parsed: unknown = JSON.parse(body)
      if (typeof parsed === "object" && parsed !== null && "code" in parsed && typeof parsed.code === "string") {
        code = parsed.code
      }
    } catch {
      // A non-JSON error body has no code to read; the status still says enough.
    }
    const status = response.status >= 400 ? response.status : 502
    if (route === "start") {
      if (code === "oauth_not_configured") {
        return authErrorResponse(
          status,
          OAUTH_OFF_HEADING,
          `You tried to sign in with GitHub. The sign-in service answered that its GitHub credentials aren't installed yet (HTTP ${status}), so the sign-in can't start. Nothing was signed in and nothing was lost.`
        )
      }
      return authErrorResponse(
        status,
        "GitHub sign-in can't start right now.",
        `You tried to sign in with GitHub, but the sign-in service answered HTTP ${status} instead of sending you to GitHub, so the sign-in can't start. Nothing was signed in — head back and try again in a bit.`
      )
    }
    return authErrorResponse(
      status,
      "GitHub sign-in didn't finish.",
      `You were on your way back from GitHub, but the sign-in service answered HTTP ${status}, so the sign-in could not complete. Nothing was signed in — head back and try again.`
    )
  })

/**
 * Wave 8 — the session probe is a question, not an error. The landing boots by
 * asking "who is signed in?", and the upstream's 401 IS the expected signed-out
 * answer — but the browser logs any 4xx document/subresource response as a
 * console error no matter how calmly the client JS handles it. So the seam
 * restates the expected answer as what it honestly is — a resolved 200 naming
 * the signed-out state.
 *
 * ONLY the 401. The identity worker spends 401 on exactly one thing here (no
 * session cookie, or an unreadable one); its 403 means "Forbidden origin" — a
 * deployment whose ALLOWED_ORIGINS omits this Worker, where every identity call
 * is broken and nobody could sign in. Restating that as "signed out" would
 * paint a broken deployment as a calm signed-out landing with a clean console,
 * which is exactly the kind of suppression this wave exists to stop. It, 5xx,
 * and an unreachable upstream all pass through untouched and still surface.
 */
export const probeAuthSession = (request: Request): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const response = yield* proxyToIdentity(request)
    if (response.status !== 401) return response
    yield* discardBody(response)
    return json(200, { status: "signed-out" })
  })
