/**
 * HTTP route names shared by the server, local host, and browser.
 *
 * @since 1.0.0
 */

/**
 * Route contract shared by the browser agent client and the server boundary, so the two
 * can never drift. Kept free of Node imports because the browser bundle imports it.
 * @since 1.0.0
 * @category constants
 */
export const TURN_PATH = "/api/agent/turn"
/**
 * The cancel route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const CANCEL_PATH = "/api/agent/turn/cancel"

/** Read committed turn output without starting inference or spending another turn.
 * @since 1.0.0
 * @category constants
 */
export const TURN_REPLAY_PATH = "/api/agent/turn/replay"

/** Retire one accepted leg and erase its retained output.
 * @since 1.0.0
 * @category constants
 */
export const TURN_RETIRE_PATH = "/api/agent/turn/retire"
/** Delete-only capability endpoint, available after account sign-out.
 * @since 1.0.0
 * @category constants
 */
export const TURN_ERASE_PATH = "/api/agent/turn/erase"

/*
 * The product Worker's backend seams: auth/identity proxy routes and the
 * billing proxy routes, both proxied wholesale.
 */
/**
 * The auth route prefix route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const AUTH_ROUTE_PREFIX = "/api/auth/"
/**
 * The identity route prefix route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const IDENTITY_ROUTE_PREFIX = "/api/identity/"
/**
 * The billing route prefix route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const BILLING_ROUTE_PREFIX = "/api/billing/"
/**
 * The auth scopes route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const AUTH_SCOPES_PATH = "/api/auth/scopes"
/**
 * The auth session route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const AUTH_SESSION_PATH = "/api/auth/session"
/**
 * The auth sign in route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const AUTH_SIGN_IN_PATH = "/api/auth/github/start"
/* The native sign-in handoff (device-flow style): OAuth in the system browser. */
/**
 * The auth native start route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const AUTH_NATIVE_START_PATH = "/api/auth/native/start"
/**
 * The auth native claim route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const AUTH_NATIVE_CLAIM_PATH = "/api/auth/native/claim"
/**
 * The auth callback route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const AUTH_CALLBACK_PATH = "/api/auth/github/callback"
/**
 * The optional query parameter on the sign-in start route naming the
 * same-origin page the callback returns the visitor to. The server accepts a
 * single absolute path only (`/owner/name`, at most 512 bytes) and ignores
 * anything else, so a crafted link can never turn the callback into an open
 * redirect.
 *
 * @since 1.0.0
 * @category constants
 */
export const AUTH_RETURN_TO_PARAM = "return_to"
/**
 * The query parameter the callback appends to the page it returns the
 * visitor to (`?signed-in=github`), so the app's auth-return handling fires
 * on any return page and strips the marker afterwards.
 *
 * @since 1.0.0
 * @category constants
 */
export const AUTH_SIGNED_IN_PARAM = "signed-in"
/**
 * The auth logout route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const AUTH_LOGOUT_PATH = "/api/auth/logout"
/**
 * The billing balance route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const BILLING_BALANCE_PATH = "/api/billing/balance"
/*
 * Approvals are no longer a route of their own. A decision is the gateway's
 * `Approval.Submit` procedure, relayed through {@link WORKFLOW_RPC_PATH}: one
 * call that records the decision AND resumes the run it unblocked, so a lost
 * second call can never leave a run approved and stopped.
 */

/*
 * The browser tool's server-side fetch (Wave 10, §2d): implemented ON the
 * product Worker (SSRF-guarded, no credentials), not proxied to a sibling.
 */
/**
 * The tools browser fetch route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const TOOLS_BROWSER_FETCH_PATH = "/api/tools/browser-fetch"
/*
 * The per-user workflow seam (implemented ON the product Worker):
 * provision-or-resume the caller's workspace gateway, then relay one
 * allowlisted gateway procedure per call. Gateway tokens never reach the
 * browser: the Worker holds the credential and writes the gateway's RPC frame.
 *
 * The body is `{ repo, procedure, payload }` and the answer is the gateway's
 * own outcome, unwrapped: `{ ok: true, payload }` or `{ ok: false, error }`.
 *
 * The 0.x per-run events route and SSE change stream are gone. A run is
 * followed through the `run-summary`, `transcript`, and `approvals`
 * projections, which carry their own cursor; a live stream belongs on the
 * gateway's own WebSocket mounts, which a path-prefixed relay proxies.
 */
/**
 * The workflow provision route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const WORKFLOW_PROVISION_PATH = "/api/workflow/provision"
/**
 * The workflow rpc route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const WORKFLOW_RPC_PATH = "/api/workflow/rpc"
/*
 * The chain backend's model relay (DESIGN.md §14, decision D1): the browser
 * runs the real @smthrs/model provider wire against this path; the Worker
 * session-gates the call, injects the provider key, and streams the provider's
 * SSE back verbatim. The full ModelEvent vocabulary therefore reaches the
 * browser without the Worker ever speaking effect — the relay carries the
 * provider protocol, and ModelEvent decoding stays where effect lives.
 */
/**
 * The model stream route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_STREAM_PATH = "/api/model/stream"
/*
 * The Models surface (ConfiguredModel.ts). Both hosts answer both routes
 * themselves: a credential is resolved by NAME on the host that holds it, so
 * neither route is ever forwarded and no value exists on either wire.
 */
/**
 * The model catalog route: `GET` answers `ModelCatalogSchema`, the built-in
 * models this host serves, the credential names it resolves with their
 * presence and origins, and the seats it reads.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_CATALOG_PATH = "/api/model/catalog"
/**
 * The default model route.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_DEFAULT_PATH = "/api/model/default"
/**
 * The model test route: `POST { model }` makes one real call and answers
 * `ModelTestResultSchema` with HTTP 200 for a pass and for a typed failure
 * alike. Only a refusal to run the test uses the refusal envelopes.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_TEST_PATH = "/api/model/test"

/*
 * The public catalog and its read-only companions (apps/server
 * publicRepoCatalog.ts): anonymous, credential-free reads about the curated
 * repositories anyone can explore signed out.
 */
/**
 * The public repository catalog route shared by the site, the server, and the client.
 *
 * @since 1.0.0
 * @category constants
 */
export const PUBLIC_REPOS_PATH = "/api/public/repos"
/**
 * The recent-activity read of one catalog repository:
 * `GET /api/public/repos/<owner>/<name>/activity`, answering
 * `{ sentence, counts: { commits, pullRequests, issues }, since }`. A count the
 * mirror could not answer is null and the sentence says so. A 404 means the
 * repository is not in the public catalog; the client says so rather than
 * inventing a sentence.
 *
 * @since 1.0.0
 * @category constants
 */
export const publicRepoActivityPath = (repo: string): string => `${PUBLIC_REPOS_PATH}/${repo}/activity`

/**
 * The admin route prefix route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const ADMIN_ROUTE_PREFIX = "/api/admin/"
/**
 * The admin grant route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const ADMIN_GRANT_PATH = "/api/admin/grant"
/**
 * The admin health route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const ADMIN_HEALTH_PATH = "/api/admin/system/health"
/** The bounded client-error log: what actually broke in an alpha user's browser.
 * @since 1.0.0
 * @category constants
 */
export const ADMIN_ERRORS_PATH = "/api/admin/errors"

/*
 * The command recommender: the browser posts the tail of the current chat and
 * every command the user can invoke, and the Worker answers an ordered list of
 * up to five command names from a small model. The outcome route records the
 * command the user ran next, keyed by the recommendation id, so the
 * recommendations can be scored (apps/server/src/recommend.ts).
 */
/**
 * The recommend route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const RECOMMEND_PATH = "/api/recommend"
/**
 * The recommend outcome route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const RECOMMEND_OUTCOME_PATH = "/api/recommend/outcome"
/**
 * The decision model's command selection for one chat message: the commands
 * whose full descriptors the turn's prompt discloses. Same admission as a
 * chat turn.
 *
 * @since 1.0.0
 * @category constants
 */
export const COMMANDS_SELECT_PATH = "/api/commands/select"
/**
 * The admin read of the recommendation log, newest first, for the scorer.
 *
 * @since 1.0.0
 * @category constants
 */
export const ADMIN_RECOMMEND_LOG_PATH = "/api/admin/recommend/log"

/*
 * The Jev relay: the browser holds no gateway key, so it posts one decision
 * (a state and the questions to answer about it) and reads Jev's typed
 * answers back (apps/server/src/jevRelay.ts).
 */
/**
 * The Jev evaluation relay shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const JEV_PATH = "/api/jev"

/*
 * The local app's own chat boundary (apps/app/docs/LOCAL-APP.md): the Bun
 * main process serves these on http://127.0.0.1:<port> and the SPA streams
 * the same NDJSON AgentTurnFrames the native bridge used to carry.
 */
/**
 * The chat turn route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const CHAT_TURN_PATH = "/api/chat/turn"
/**
 * The chat cancel route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const CHAT_CANCEL_PATH = "/api/chat/cancel"
/**
 * The health route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const HEALTH_PATH = "/api/health"

/**
 * The account's current billing standing: its plan key, its caps, and today's spend.
 *
 * @since 1.0.0
 * @category constants
 */
export const BILLING_OVERVIEW_PATH = "/api/billing"
/**
 * The catalog of plans this account may move to, including the one it is on.
 *
 * @since 1.0.0
 * @category constants
 */
export const BILLING_PLANS_PATH = "/api/billing/plans"

/** Host-side provider credential enrollment, rotation and removal.
 * @since 1.0.0
 * @category constants
 */
export const MODEL_CREDENTIAL_PATH = "/api/model/credential"
/** Secret-free mutation receipt recovery.
 * @since 1.0.0
 * @category constants
 */
export const MODEL_CREDENTIAL_RECEIPT_PATH = "/api/model/credential/receipt"

/**
 * Routes called by the browser that must be present in the shared Go backend.
 * `capability` names the bootstrap capability that gates the client call;
 * `undefined` means the route is a public or locally rule-driven contract.
 *
 * @since 1.0.0-rc.1
 * @category constants
 */
export const SHARED_BACKEND_CLIENT_ROUTES = [
  { method: "GET", path: BILLING_BALANCE_PATH, capability: "billing.balance" },
  { method: "GET", path: BILLING_OVERVIEW_PATH, capability: "billing.overview" },
  { method: "GET", path: BILLING_PLANS_PATH, capability: "billing.plans" },
  { method: "POST", path: "/api/billing/checkout", capability: "billing.checkout" },
  { method: "POST", path: "/api/billing/portal", capability: "billing.portal" },
  { method: "GET", path: PUBLIC_REPOS_PATH },
  { method: "POST", path: RECOMMEND_PATH, capability: "recommend" },
  { method: "POST", path: RECOMMEND_OUTCOME_PATH, capability: "recommend" },
  { method: "POST", path: COMMANDS_SELECT_PATH, capability: "commands.select" },
  { method: "POST", path: MODEL_STREAM_PATH, capability: "model.turn" }
] as const
