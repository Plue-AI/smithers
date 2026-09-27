import { handleGitHubAppInstall, INSTALLATIONS_PATH } from "./githubAppInstall"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import {
  ADMIN_ROUTE_PREFIX,
  AUTH_CALLBACK_PATH,
  AUTH_ROUTE_PREFIX,
  AUTH_SESSION_PATH,
  AUTH_SIGN_IN_PATH,
  BILLING_ROUTE_PREFIX,
  CANCEL_PATH,
  IDENTITY_ROUTE_PREFIX,
  JEV_PATH,
  MODEL_CATALOG_PATH,
  MODEL_STREAM_PATH,
  MODEL_TEST_PATH,
  RECOMMEND_OUTCOME_PATH,
  RECOMMEND_PATH,
  TOOLS_BROWSER_FETCH_PATH,
  TURN_PATH,
  TURN_REPLAY_PATH,
  TURN_RETIRE_PATH,
  TURN_ERASE_PATH,
  WORKFLOW_PROVISION_PATH,
  WORKFLOW_RPC_PATH
} from "@smthrs/rpc/AgentApiRoutes"
import { APP_API_VERSION, APP_BOOTSTRAP_PATH } from "@smthrs/rpc/AppBootstrap"
import { AUTHENTICATED_USER_PATH } from "@smthrs/rpc/ApplicationAuth"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import { CLOUD_AUTH_SESSION_PATH, CLOUD_ROUTE_PREFIX, CLOUD_WS_ROUTE_PREFIX } from "@smthrs/rpc/CloudTunnel"
import { handleTerminalRelay } from "./terminalRelay"
import { probeCloudSession } from "./cloudSession"
import { handleAdmin } from "./admin"
import { catalogDocumentPath, comingSoonDocumentPath, DEFAULT_APP_DOCUMENT_PATH, isFramePath, isRepositoryPath } from "./appDocument"
import { proxyToBilling } from "./billing"
import { serveRequest } from "./Boundary"
import { ClientErrorLog } from "./clientErrorLog"
import { ServerConfig } from "./Config"
import { Assets, BrowserEgress, DeploymentBindings, ExecutionContext, executionContextFrom, runtimeFor } from "./Environment"
import type { NativeExecutionContext, RequestServices, WorkerEnv } from "./Environment"
import { discardBody, readJsonOrUndefined } from "./Http"
import { GatewaySessionRegistry } from "./gateway"
import { AccountModelVault } from "./modelVault"
import { handleAuthNavigation, isVisitorRefusal, probeAuthSession, proxyToIdentity, requireTurnSession, validateSession } from "./identity"
import {
  CLIENT_ERRORS_PATH,
  handleBrowserFetch,
  handleClientError,
  handleAuthenticatedUser,
  handleCloudProxy,
  handlePlatformProxy,
  PLATFORM_PROXY_RULES,
  platformProxyMatch,
  platformProxyRuleCovers
} from "./proxies"
import { AVAILABLE_REPOS, PUBLIC_REPOS_PATH } from "./publicRepoCatalog"
import { handlePublicRepoActivity, parsePublicRepoActivityPath } from "./publicRepoActivity"
import { handlePublicRepos } from "./publicRepos"
import { handleJev } from "./jevRelay"
import { handleModelCatalog, handleModelTest } from "./modelProbe"
import { handleRecommend, handleRecommendOutcome, RecommendLog } from "./recommend"
import {
  handleTriggerApproval,
  handleTriggerPause,
  handleTriggerRegistrations,
  TRIGGER_APPROVAL_PATH,
  TRIGGER_PAUSE_PATH,
  TRIGGER_REGISTRATIONS_PATH
} from "./repositoryTriggers"
import { ISOLATION_HEADERS, json, methodNotAllowed, notFound, refuse, withIsolationHeaders } from "./Responses"
import {
  ANONYMOUS_ALL_CEILING,
  ANONYMOUS_ALL_KEY,
  ANONYMOUS_CEILING,
  anonymousTurnKey,
  ERASE_CEILING,
  eraseTurnKey,
  TurnLimits,
  turnLimitResponse,
  TurnRateLimiter
} from "./turnLimit"
import { handleCancel, handleModelStream, handleTurn, handleTurnJournalAccess, handleTurnJournalErasure, readStartTurn, TurnCancelRegistry } from "./turns"
import { handleWorkflowProvision, handleWorkflowRpc } from "./workflows"
import { handleRepositorySetup } from "./repositorySetup"

/*
 * The deployable Smithers MVP server: a Cloudflare Worker that serves the built
 * site (assets binding, run_worker_first for the API routes) and implements the
 * same-origin `/api/agent` boundary the pure-web client talks to, plus the
 * trusted-proxy seams to the identity, billing, chat and Cloud services.
 * Upstream credentials and origins stay server-side; the browser only ever
 * sees its own origin.
 *
 * This module is the router and the native adapter, nothing else: every route
 * body lives in the module that owns its seam (src/turns.ts, src/identity.ts,
 * src/billing.ts, src/admin.ts, src/proxies.ts, src/workflows.ts, the public
 * catalog modules), and `handleRequest` decides which one answers. The
 * `default` export at the bottom is the deployed entry (wrangler.jsonc
 * `main`): the same router under workerd's plain `fetch(request, env, ctx)`
 * shape, which the tests and a local host run as well.
 */

/* The five Durable Object classes wrangler binds, under their frozen names. */
export { AccountModelVault, ClientErrorLog, GatewaySessionRegistry, RecommendLog, TurnCancelRegistry, TurnRateLimiter }
/* The route tables the host parity matrix and the identity test read. */
export { PLATFORM_PROXY_RULES, platformProxyRuleCovers }
export type { WorkerEnv }
export type { TurnCancelNamespace, TurnCancelStorage } from "./turns"

/*
 * Retired raw gateway mounts. The old static proxy used deployment credentials
 * without a per-request user/target authority. Product clients use the
 * session-validated, per-user /api/workflow/* relay instead. Leftover secrets
 * must never reactivate this path.
 */
const RETIRED_GATEWAY_ROUTE_PREFIXES = ["/rpc", "/projections", "/sync", "/health"] as const

const retiredGatewayProxy = (): Response =>
  refuse(
    "gateway_proxy_removed",
    "The static gateway proxy was removed. Use the session-validated /api/workflow/provision and /api/workflow/rpc routes, or connect directly to a separately authenticated gateway."
  )

const isRetiredGatewayRoute = (pathname: string): boolean =>
  RETIRED_GATEWAY_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))

/*
 * The former Mintlify site published its API reference under the same /rpc
 * prefix (/rpc/list-runs was a page), and the site build's _redirects sends
 * each of those addresses to the current reference. wrangler runs this Worker
 * first for every path, so the assets layer only sees a retired path when the
 * Worker asks. The boundary is the method: a GET or HEAD navigation asks, and
 * keeps the redirect the site declares for it; a POST, any upgrade, and a
 * path the site never redirected are the tombstone. The assets binding is the
 * build on disk, never an upstream, so nothing here forwards.
 */
const answerRetiredGatewayRoute = (request: Request): Effect.Effect<Response, never, Assets> =>
  Effect.gen(function* () {
    const navigation = (request.method === "GET" || request.method === "HEAD") && !request.headers.has("upgrade")
    if (!navigation) return retiredGatewayProxy()
    const asset = yield* serveAsset(request)
    if (asset.status >= 300 && asset.status < 400 && asset.headers.has("location")) return asset
    yield* discardBody(asset)
    return retiredGatewayProxy()
  })

const isApiRoute = (pathname: string): boolean => pathname.startsWith("/api/") || isRetiredGatewayRoute(pathname)

/**
 * Same-origin guard for the API surface. These routes spend the deployment's
 * own credentials — `/api/workflow/rpc` relays a gateway procedure under the
 * credential the Worker holds and the browser never sees — and a `text/plain`
 * or form POST from another site is not preflighted, so nothing else would
 * stop a page anywhere from driving them. Requests without an `Origin`
 * (same-origin GETs, top-level OAuth navigation, curl, the e2e) are untouched.
 */
const isCrossOriginRequest = (request: Request, url: URL): boolean => {
  const origin = request.headers.get("origin")
  return origin !== null && origin !== url.origin
}

/** Whether `owner/name` is in the public catalog; GitHub names are case-insensitive. */
const isCatalogRepository = (name: unknown): boolean =>
  typeof name === "string" && AVAILABLE_REPOS.some((repo) => repo.name.toLowerCase() === name.toLowerCase())

/** Catalog pages have a canonical lowercase document; other repositories use the shared shell. */
const routedRepoPage = (pathname: string): { readonly kind: "app" | "coming-soon"; readonly document: string } | undefined => {
  const comingSoon = comingSoonDocumentPath(pathname)
  if (comingSoon !== undefined) return { kind: "coming-soon", document: comingSoon }
  const document = catalogDocumentPath(pathname)
  return document === undefined ? undefined : { kind: "app", document }
}

/**
 * The canary is a copy of the product, not a second product: an HTML page it
 * serves must never outrank the apex in a search index.
 */
const CANARY_HOSTNAME = "canary.smithers.sh"

const withDocumentHeaders = (url: URL, response: Response): Response => {
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) return response
  const headers = new Headers(response.headers)
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
  headers.set("X-Content-Type-Options", "nosniff")
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
  if (url.hostname === CANARY_HOSTNAME) headers.set("X-Robots-Tag", "noindex")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/*
 * The site build as the assets layer serves it. An assets binding that
 * rejects is not a route outcome any contract names: it is the platform
 * failing under us, and the boundary answers it with the generic logged 500
 * (docs/worker-errors.md), never a hang and never an HTML error page.
 */
const serveAsset = (request: Request): Effect.Effect<Response, never, Assets> =>
  Assets.use((assets) => assets.fetch(request)).pipe(Effect.catch((failure) => Effect.die(failure.cause)))

/*
 * The app document, fetched from the site build by its canonical path
 * (src/appDocument.ts) and served with the isolation headers the app's OPFS
 * persistence needs. Only the app document carries them: the docs pages in
 * the same build load Google Fonts and Pagefind, which COEP require-corp
 * would block.
 */
const serveAppDocument = (request: Request, url: URL, document: string): Effect.Effect<Response, never, Assets> =>
  Effect.map(serveAsset(new Request(new URL(document, url).toString(), request)), withIsolationHeaders)

/*
 * Anonymous exploring (PUBLIC-REPOSITORIES.md): a visitor at
 * smithers.sh/smithersai/smithers talks to Smithers about that repository
 * without an admitted account (signed out, or signed in but not yet
 * allowlisted: isVisitorRefusal). The turn names its repository in the
 * runtime context the client derives each turn (`context.activeRepository`); only a catalog
 * repository opens the door, and it opens onto the anonymous ceilings, never
 * onto a user's budget or billing account: the turn carries no login, so the
 * chat upstream meters it to the deployment. Two buckets are spent, and
 * either refuses: the caller's address (one IPv6 /64 is one address) and the
 * deployment-wide `anonymous:all`, which is what caps the day's cost when a
 * caller rotates addresses.
 *
 * What the turn can reach is what the client can reach signed out: the
 * model's tool calls run in the browser, against this Worker, where every
 * write route and the workflow seam still answer 401 without a session and
 * only the public repository reads are open. The turn route forwards the
 * client's messages, instructions, and tool spec to the chat upstream as it
 * does for a login; the ceiling is what bounds the spend.
 */
const anonymousCatalogTurn = (request: Request, refusal: Response): Effect.Effect<Response, never, RequestServices> =>
  Effect.gen(function* () {
    const body = yield* readStartTurn(request)
    if (body instanceof Response) return body
    if (!isCatalogRepository(body.context?.activeRepository)) return refusal
    const admission = Effect.gen(function* () {
      const config = yield* ServerConfig
      const salt = config.anonymousTurnSalt === undefined ? undefined : Redacted.value(config.anonymousTurnSalt)
      const anonymousKey = yield* anonymousTurnKey(request, salt)
      const limits = yield* TurnLimits
      const budget = yield* limits.spend(anonymousKey, ANONYMOUS_CEILING)
      if (!budget.allowed) return turnLimitResponse(budget, ISOLATION_HEADERS, ANONYMOUS_CEILING)
      // Spend shared capacity only after the address bucket admits.
      const shared = yield* limits.spend(ANONYMOUS_ALL_KEY, ANONYMOUS_ALL_CEILING)
      return shared.allowed ? undefined : turnLimitResponse(shared, ISOLATION_HEADERS, ANONYMOUS_ALL_CEILING)
    })
    return yield* handleTurn(request, undefined, body, admission)
  })

/**
 * Erasure works after sign-out, so its address bucket is spent before the
 * journal object is reached: a refused caller writes no tombstone.
 */
const erasureBudget = (request: Request): Effect.Effect<Response | undefined, never, ServerConfig | TurnLimits> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const key = yield* eraseTurnKey(request, config.anonymousTurnSalt === undefined ? undefined : Redacted.value(config.anonymousTurnSalt))
    const budget = yield* TurnLimits.use((limits) => limits.spend(key, ERASE_CEILING))
    return budget.allowed ? undefined : turnLimitResponse(budget, ISOLATION_HEADERS, ERASE_CEILING)
  })

/** The login's turn ceiling, spent before a model credential is. */
const loginBudget = (login: string): Effect.Effect<Response | undefined, never, TurnLimits> =>
  TurnLimits.use((limits) =>
    Effect.map(limits.spend(login), (budget) => (budget.allowed ? undefined : turnLimitResponse(budget, ISOLATION_HEADERS)))
  )

/*
 * What the app reads first: which doors this deployment has. The terminal
 * relay authenticates the browser cookie and holds the cloud bearer here.
 */
const handleBootstrap = (request: Request): Effect.Effect<Response, never, ServerConfig | BrowserEgress | DeploymentBindings | Assets> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const bindings = yield* DeploymentBindings
    const egress = yield* BrowserEgress
    const identity = config.identityUpstreamUrl !== undefined
    // The deployed asset is authoritative; a binding may name an older build.
    const stamp = yield* Assets.use((assets) => assets.fetch(new Request(new URL("/__build.json", request.url)))).pipe(
      Effect.flatMap((response) => response.ok ? readJsonOrUndefined(response) : Effect.succeed(undefined)),
      Effect.catch(() => Effect.succeed(undefined))
    )
    const buildSha = typeof stamp === "object" && stamp !== null && "gitSha" in stamp && typeof stamp.gitSha === "string"
      ? stamp.gitSha : config.buildSha
    return json(200, {
      apiVersion: APP_API_VERSION,
      host: "cloud",
      version: "1.0.0",
      buildSha,
      capabilities: cloudCapabilities({
        identity,
        cloud: bindings.cloudApi,
        agent: config.chatAuthToken !== undefined || config.chatProductServiceToken !== undefined,
        balance: identity && config.billingUpstreamUrl !== undefined && config.billingProductServiceToken !== undefined,
        overview: identity && bindings.cloudApi,
        plans: identity && bindings.cloudApi,
        checkout: identity && bindings.cloudApi && config.billingCheckoutEnabled,
        portal: identity && bindings.cloudApi && config.billingPortalEnabled,
        terminal: true,
        recommend: config.aiGatewayApiKey !== undefined,
        browser: Option.isSome(egress)
      }),
      authFlow: identity ? "native-handoff" : "none",
      sandbox: null
    })
  })

/**
 * The router: one request in, one response out, never a failure. Every
 * refusal a contract names is a Response; an interruption (the client went
 * away) stays an interruption for the boundary to answer 499; anything else
 * is a defect the boundary logs and answers with the generic 500.
 */
export const handleRequest = (request: Request): Effect.Effect<Response, never, RequestServices> =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    // Cloudflare supplies the original scheme in cf-visitor. Wrangler dev omits
    // it and rewrites the request URL to the first configured route, so using
    // that URL's protocol would cause a redirect loop. Invalid or absent headers
    // skip the scheme redirect; www canonicalization remains independent.
    const visitor = yield* Effect.try(() => JSON.parse(request.headers.get("cf-visitor") ?? "null") as unknown).pipe(
      Effect.catch(() => Effect.succeed(undefined))
    )
    const httpVisitor = typeof visitor === "object" && visitor !== null && "scheme" in visitor && visitor.scheme === "http"
    if (httpVisitor || url.hostname === "www.smithers.sh") {
      url.protocol = "https:"
      if (url.hostname === "www.smithers.sh") url.hostname = "smithers.sh"
      return Response.redirect(url.toString(), 301)
    }
    // This one curated, read-only catalog is public to the marketing site.
    // Every authenticated API continues through the same-origin guard below.
    if (url.pathname === PUBLIC_REPOS_PATH) return yield* handlePublicRepos(request)
    // The catalog's recent-activity sentence (src/publicRepoActivity.ts): a
    // public read computed from the Cloud mirror, never from GitHub.
    if (parsePublicRepoActivityPath(url.pathname) !== undefined) return yield* handlePublicRepoActivity(request)
    // Retired mounts never forward, even on WebSocket upgrade or when legacy
    // deployment credentials are still configured.
    const retiredGatewayRoute = isRetiredGatewayRoute(url.pathname)
    if (isApiRoute(url.pathname) && isCrossOriginRequest(request, url)) {
      return refuse("cross_origin_blocked", "This API only answers requests from its own origin.")
    }
    // The command recommender (src/recommend.ts): open to a visitor as well
    // as a login, under its own ceilings. A login is the bucket when the
    // session validates; anything else, including identity being down, is
    // the visitor's address bucket, because the pills must never wait on
    // sign-in and never spend a real model turn.
    if (url.pathname === RECOMMEND_PATH || url.pathname === RECOMMEND_OUTCOME_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      if (url.pathname === RECOMMEND_OUTCOME_PATH) return yield* handleRecommendOutcome(request, ISOLATION_HEADERS)
      const validation = yield* validateSession(request)
      const login = validation.status === "valid" ? validation.identity.login : undefined
      return yield* handleRecommend(request, login, ISOLATION_HEADERS)
    }
    // The Jev relay (src/jevRelay.ts): the browser's one door to the decision
    // model, on the recommender's posture and out of the recommender's
    // ceiling — open to a visitor, a login when the session validates.
    if (url.pathname === JEV_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      const validation = yield* validateSession(request)
      return yield* handleJev(request, validation.status === "valid" ? validation.identity.login : undefined, ISOLATION_HEADERS)
    }
    if (url.pathname === INSTALLATIONS_PATH || url.pathname.startsWith(`${INSTALLATIONS_PATH}/`)) {
      if (request.method !== "GET") return methodNotAllowed()
      const id = url.pathname === INSTALLATIONS_PATH ? undefined : url.pathname.slice(INSTALLATIONS_PATH.length + 1)
      if (id !== undefined && !/^[1-9]\d*$/.test(id)) return refuse("request_invalid", "Invalid installation id.")
      return yield* handleGitHubAppInstall(request, id)
    }
    if (url.pathname === APP_BOOTSTRAP_PATH) {
      if (request.method !== "GET") return methodNotAllowed()
      return yield* handleBootstrap(request)
    }
    if (url.pathname === TURN_ERASE_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      const refused = yield* erasureBudget(request)
      if (refused !== undefined) return refused
      return yield* handleTurnJournalErasure(request)
    }
    if (url.pathname === TURN_REPLAY_PATH || url.pathname === TURN_RETIRE_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      const gate = yield* requireTurnSession(request)
      // A capability protects an anonymous leg. An owned leg additionally
      // requires its currently validated account on every bounded read.
      if (gate instanceof Response && !isVisitorRefusal(gate)) return gate
      return yield* handleTurnJournalAccess(request, gate instanceof Response ? undefined : gate, url.pathname === TURN_RETIRE_PATH)
    }
    if (url.pathname === CANCEL_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      const refusal = yield* requireTurnSession(request)
      // A visitor may kill its own anonymous turn: the registry refuses an
      // owned registration to anyone but its owner, and cancelling spends
      // nothing.
      if (refusal instanceof Response && !isVisitorRefusal(refusal)) return refusal
      return yield* handleCancel(request, refusal instanceof Response ? undefined : refusal)
    }
    // The routes that spend a model credential: the turn, the model stream
    // and, below them, the Models Test. Each gates on the session first and
    // then on the login's turn ceiling, so a refusal costs one Durable
    // Object read and never reaches an upstream. The cancel route above is
    // deliberately unlimited: killing a turn must always work, and it
    // spends nothing.
    if (url.pathname === TURN_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      const gate = yield* requireTurnSession(request)
      if (gate instanceof Response) return isVisitorRefusal(gate) ? yield* anonymousCatalogTurn(request, gate) : gate
      // A fresh durable leg spends capacity before its acceptance is written;
      // a repeated POST only observes existing acceptance and spends nothing.
      return yield* handleTurn(request, gate, undefined, loginBudget(gate.login))
    }
    if (url.pathname === MODEL_STREAM_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      const gate = yield* requireTurnSession(request)
      if (gate instanceof Response) return gate
      const refused = yield* loginBudget(gate.login)
      if (refused !== undefined) return refused
      return yield* handleModelStream(request, gate)
    }
    // The Models surface (src/modelProbe.ts). Naming what this deployment
    // holds spends nothing, so the catalog is public. A Test spends model
    // credit, so it sits behind the session and spends one turn of the
    // login's budget first. There is no account credential enrollment.
    if (url.pathname === MODEL_CATALOG_PATH) {
      if (request.method !== "GET") return methodNotAllowed()
      return yield* handleModelCatalog()
    }
    if (url.pathname === MODEL_TEST_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      const gate = yield* requireTurnSession(request)
      if (gate instanceof Response) return gate
      const refused = yield* loginBudget(gate.login)
      if (refused !== undefined) return refused
      return yield* handleModelTest(request, gate.login)
    }
    if (url.pathname.startsWith("/api/repository-setup/")) return yield* handleRepositorySetup(request)
    if (url.pathname === WORKFLOW_PROVISION_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      return yield* handleWorkflowProvision(request)
    }
    if (url.pathname === WORKFLOW_RPC_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      return yield* handleWorkflowRpc(request)
    }
    if (url.pathname === TRIGGER_REGISTRATIONS_PATH) {
      if (request.method !== "GET") return methodNotAllowed()
      return yield* handleTriggerRegistrations(request, url)
    }
    if (url.pathname === TRIGGER_PAUSE_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      return yield* handleTriggerPause(request)
    }
    if (url.pathname === TRIGGER_APPROVAL_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      return yield* handleTriggerApproval(request)
    }
    if (url.pathname === TOOLS_BROWSER_FETCH_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      // Session-gated exactly like a turn: the deployment's network egress
      // is a resource.
      const refusal = yield* requireTurnSession(request)
      if (refusal instanceof Response) return refusal
      return yield* handleBrowserFetch(request)
    }
    if ((url.pathname === AUTH_SIGN_IN_PATH || url.pathname === AUTH_CALLBACK_PATH) && request.method === "GET") {
      return yield* handleAuthNavigation(request, url.pathname === AUTH_SIGN_IN_PATH ? "start" : "callback")
    }
    if (url.pathname === AUTH_SESSION_PATH && request.method === "GET") return yield* probeAuthSession(request)
    if (url.pathname === CLOUD_AUTH_SESSION_PATH) {
      if (request.method !== "GET") return methodNotAllowed()
      return yield* probeCloudSession(request)
    }
    if (/^\/api\/auth\/linear(?:\/|$)/.test(url.pathname)) return notFound()
    if (url.pathname.startsWith(AUTH_ROUTE_PREFIX) || url.pathname.startsWith(IDENTITY_ROUTE_PREFIX)) {
      return yield* proxyToIdentity(request)
    }
    if (url.pathname === CLIENT_ERRORS_PATH && request.method === "POST") return yield* handleClientError(request)
    if (url.pathname.startsWith(CLOUD_WS_ROUTE_PREFIX)) return yield* handleTerminalRelay(request, url)
    if (url.pathname.startsWith(CLOUD_ROUTE_PREFIX)) return yield* handleCloudProxy(request, url)
    if (url.pathname === AUTHENTICATED_USER_PATH && request.method === "GET") return yield* handleAuthenticatedUser(request, url)
    if (platformProxyMatch(url.pathname, request.method)) return yield* handlePlatformProxy(request, url)
    if (url.pathname.startsWith(BILLING_ROUTE_PREFIX)) return yield* proxyToBilling(request)
    if (url.pathname.startsWith(ADMIN_ROUTE_PREFIX)) return yield* handleAdmin(request, url)
    if (retiredGatewayRoute) return yield* answerRetiredGatewayRoute(request)
    // Any other /api/* path is an unknown route: the same canonical 404 the
    // admin surface answers non-admins with, so nothing is enumerable.
    if (url.pathname.startsWith("/api/")) return notFound()
    const repoPage = routedRepoPage(url.pathname)
    if (repoPage !== undefined) {
      if (url.pathname !== url.pathname.toLowerCase()) {
        url.pathname = repoPage.document
        return Response.redirect(url.toString(), 301)
      }
      if (repoPage.kind === "coming-soon") {
        return yield* serveAsset(new Request(new URL(repoPage.document, url), request))
      }
      return yield* serveAppDocument(request, url, repoPage.document)
    }
    if (isFramePath(url.pathname)) return yield* serveAppDocument(request, url, DEFAULT_APP_DOCUMENT_PATH)
    const icon = url.pathname === "/favicon.ico" ? "/favicon.png" : url.pathname === "/apple-touch-icon.png" ? "/icon.png" : undefined
    if (icon !== undefined) return yield* serveAsset(new Request(new URL(icon, url), request))
    // Existing site documents and legacy redirects retain their addresses.
    // A valid repository with no static page uses the same app island, whose
    // boot derives the requested repository from the browser's unchanged URL.
    const asset = yield* serveAsset(request)
    if (asset.status === 404 && isRepositoryPath(url.pathname) && (request.method === "GET" || request.method === "HEAD")) {
      return yield* serveAppDocument(request, url, DEFAULT_APP_DOCUMENT_PATH)
    }
    return asset
  }).pipe(Effect.map((response) => withDocumentHeaders(new URL(request.url), response)))

/**
 * The deployed entry: workerd's `fetch(request, env, ctx)` shape over the
 * router, the same one the tests and a local host run. This is the one
 * place a request's Effect meets a Promise:
 * `runRequest` (src/Boundary.ts) wires the client's disconnect to fiber
 * interruption, and `runtimeFor` keeps the isolate's services alive across
 * requests, so a cache or a single-flight gate built once is reused. The
 * execution context is per request: with one, work a route hands to
 * `waitUntil` (a turn's settlement) outlives the response.
 */
export default {
  fetch: (request: Request, env: WorkerEnv, ctx?: NativeExecutionContext): Promise<Response> =>
    serveRequest(
      request,
      handleRequest(request).pipe(Effect.provideService(ExecutionContext, executionContextFrom(ctx))),
      runtimeFor(env)
    )
}
