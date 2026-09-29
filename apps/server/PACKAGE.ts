/**
 * Targets for the Worker application: the typecheck and the unit suite.
 *
 * `pnpm run check` and `pnpm test` used to reach this package only through the
 * recursive root scripts, which the target graph cannot plan. These targets are
 * the same gates as declarations, so the pipeline runs them by label and a red
 * suite re-keys on the sources it reads.
 *
 * The suite runs under Bun, which is what the app's own scripts use, so the
 * runtime is the root Bun declaration and nothing here spells `bun` into an
 * argv.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "apps/server"

/** The Worker sources and the operator scripts the suite covers. */
const sources = [
  Smithers.glob("//apps/server/src/**/*.ts"),
  Smithers.glob("//apps/server/scripts/**/*.ts"),
  Smithers.file("//flows/rollout/runtime.ts")
]

/**
 * Checks the Worker against its own tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: sources,
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The unit suite: everything under `src/` and `scripts/`, including the canary
 * wiring checks.
 *
 * @since 0.1.0
 * @category test
 */
// Coverage policy: assertion-only for the Bun Worker suite. Bun's loaded-file
// coverage does not establish the whole production denominator; no percentage
// guarantee is claimed. See scripts/repo-contract/README.md for the exception.
const unitTests = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["src", "scripts"]),
  srcs: sources,
  deps: [],
  cwd
})

/**
 * The security review of the Worker gateway: `security` reviews the diff
 * against origin/main and `securityAudit` audits every reviewed file. The
 * checks name what this gateway holds: users' Smithers Cloud bearers, the
 * deployment's model, service and admin tokens, and the session gate in
 * front of every route that spends them.
 *
 * @since 0.1.0
 * @category security
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "scripts/**", "wrangler.jsonc", "wrangler.edge.jsonc"],
  boundaries: [{
    id: "repository-flow-invocation",
    actors: ["Browser user", "Worker gateway", "Backend authenticated user"],
    assets: ["Cloud bearer", "Repository workflow runs and secrets"],
    entryPoints: ["Browser repository flow invocation requests forwarded to Cloud"],
    identityTransformations: ["Validated browser session becomes a Cloud bearer; backend resolves its user and repository permissions"],
    enforcementPoints: ["Session and proxy allowlist before credential attachment; backend authentication and repository authorization before admission"],
    deploymentAssumptions: ["Public route composition is reviewed here; private ingress, TLS and credential configuration require a separate pinned hosted review"],
    path: {
      caller: ["src/index.ts", "src/proxies.ts", "src/cloudToken.ts"],
      authorization: ["src/identity.ts", "//packages/backend/internal/compose/router.go", "//packages/backend/internal/middleware/auth.go", "//packages/backend/internal/middleware/repo_context.go"],
      service: ["//packages/backend/internal/routes/workflow_invoke.go", "//packages/backend/internal/services/workflow_invoke.go", "//packages/backend/internal/services/workflow_invoke_flow.go"],
      storageOrEgress: ["//packages/backend/internal/db/workflows.sql.go", "//packages/backend/flowdispatch/service.go"]
    }
  }, {
    id: "browser-workflow-dispatch",
    actors: ["Browser user", "Worker gateway", "Backend user", "Flow host"],
    assets: ["Cloud bearer", "Repository workspace", "Flow control operations"],
    entryPoints: ["POST /api/workflow/provision and /api/workflow/rpc"],
    identityTransformations: ["Validated browser session becomes a Cloud bearer, then backend user and repository-scoped host target"],
    enforcementPoints: ["Worker workflow session and allowlist gate; backend route authentication and write scope; repository access and workspace ownership"],
    deploymentAssumptions: ["Public composition is reviewed here; hosted ingress, TLS and injected credentials are separate private review scope"],
    path: {
      caller: ["src/index.ts", "src/workflows.ts", "src/proxies.ts", "src/cloudToken.ts"],
      authorization: ["src/identity.ts", "//packages/backend/internal/compose/main.go", "//packages/backend/internal/middleware/auth.go"],
      service: ["//packages/backend/internal/compose/browser_flow.go", "//packages/backend/internal/compose/browser_flow_target.go"],
      storageOrEgress: ["//packages/backend/flowdispatch/service.go", "//packages/backend/flowhost/resolver.go", "//packages/backend/flowhost/store.go"]
    }
  }],
  checks: [
    {
      id: "cloud-bearer-confinement",
      title: "A user's Cloud bearer only reaches allowlisted paths on the Cloud origin",
      threat: "A signed-in user or a crafted link aims another user's server-held Smithers Cloud token at a foreign host or an unlisted Cloud route.",
      lookFor: [
        "A path joined onto cloudApiBaseUrl from request text without the origin re-check, allowing '//host', '\\', '..' or '%2e%2e' segments.",
        "A route that mints fetchCloudToken and forwards without passing platformProxyMatch or its own exact regex first.",
        "A prefix rule in PLATFORM_PROXY_RULES that matches beyond a segment boundary, or a method the owning seam never calls.",
        "An upstream fetch that follows a redirect, or copies the browser's cookie, Origin, or query into a bearer-carrying request."
      ],
      paths: [
        "src/proxies.ts",
        "src/cloudToken.ts",
        "src/workflows.ts",
        "src/repositorySetup.ts",
        "src/repositoryTriggers.ts",
        "src/githubAppInstall.ts",
        "src/terminalRelay.ts",
        "src/Http.ts"
      ]
    },
    {
      id: "spend-gate",
      title: "Every route that spends a deployment credential gates on session, allowlist and ceiling first",
      threat: "An anonymous or non-allowlisted caller runs turns, model tests, browser fetches or flows on the deployment's keys and billing account.",
      lookFor: [
        "A route in index.ts that reaches handleTurn, handleModelStream, handleModelTest, handleBrowserFetch or forwardToCloud before requireTurnSession or requireWorkflowSession.",
        "An anonymous turn path that opens for a repository outside AVAILABLE_REPOS, or spends a model before both anonymous ceilings admit.",
        "A cloud role, configured-model or front-door turn that spends Cerebras or AI Gateway keys for a signed-out caller outside the anonymous ceilings.",
        "A turn-limit key built from a client-supplied header other than cf-connecting-ip, letting a caller rotate buckets."
      ],
      paths: [
        "src/index.ts",
        "src/identity.ts",
        "src/turns.ts",
        "src/turnLimit.ts",
        "src/cloudRoleTurn.ts",
        "src/configuredModel.ts",
        "src/frontDoor.ts",
        "src/recommend.ts",
        "src/jevRelay.ts",
        "src/modelProbe.ts",
        "src/modelPayer.ts"
      ]
    },
    {
      id: "trusted-caller-headers",
      title: "Identity headers and service tokens sent upstream come only from the validated session",
      threat: "A browser injects x-user-login or a service token so the billing, chat or identity worker acts on another user's account.",
      lookFor: [
        "A proxy that forwards request headers without strippedHeaders, or a STRIPPED_IDENTITY_HEADERS list missing an x-user-* or x-smithers-* header an upstream trusts.",
        "x-user-login, x-user-role or x-smithers-service-token set from anything but the validated session or config.",
        "proxyToBilling forwarding a billing write or metering path with the trusted-caller token, not only the user's own reads.",
        "siblingAdminRoute bypassed by '//', a missing trailing slash, or case, so /api/identity/admin or /api/billing/admin is reachable."
      ],
      paths: ["src/Responses.ts", "src/identity.ts", "src/billing.ts", "src/turns.ts", "src/edge.ts"]
    },
    {
      id: "admin-surface",
      title: "Admin routes answer only a validated admin and attribute every write",
      threat: "A non-admin user edits the allowlist, grants credit, or reads other users' client errors and recommendation logs.",
      lookFor: [
        "An /api/admin/* branch reached before the session.admin && session.allowlisted check.",
        "A grant whose amount is not bounded by ADMIN_GRANT_MAX_USD or whose requester is taken from the body.",
        "An admin refusal that differs from the canonical 404, enumerating the admin surface to non-admins."
      ],
      paths: ["src/admin.ts", "src/clientErrorLog.ts", "src/recommend.ts"]
    },
    {
      id: "turn-ownership",
      title: "Only a turn's owner or capability holder can cancel, replay, retire or erase it",
      threat: "One user or visitor cancels, reads the transcript of, or erases another user's agent turn.",
      lookFor: [
        "A cancel or journal access that skips the owner comparison, or treats a missing owner as matching any login.",
        "A journal capability compared by string equality on the raw token rather than its hash, or returned to a retry.",
        "A client-chosen runId or legId that collides with another user's registration and grants its state."
      ],
      paths: ["src/turns.ts", "src/DurableTurn.ts", "src/TurnJournal.ts", "src/TurnJournalClient.ts"]
    },
    {
      id: "cross-origin-guard",
      title: "State-changing and credential-spending routes refuse another site's requests",
      threat: "A malicious page drives a signed-in user's browser to run flows, land changes or open a terminal with their cookie.",
      lookFor: [
        "An /api route or WebSocket upgrade dispatched before isCrossOriginRequest, or a route outside /api that spends a credential.",
        "The terminal relay accepting an upgrade whose Origin differs from the app origin or that lacks a validated session."
      ],
      paths: ["src/index.ts", "src/terminalRelay.ts"]
    },
    {
      id: "model-binding-pinning",
      title: "A client model binding can never send a deployment key to a caller-chosen address",
      threat: "A signed-in user exfiltrates CEREBRAS_API_KEY or AI_GATEWAY_API_KEY by naming their own baseUrl in a turn or model test.",
      lookFor: [
        "A planned binding whose URL is not compared to CEREBRAS_CHAT_COMPLETIONS_URL or JEV_EVALUATE_URL before a key is attached.",
        "Model output or an error returned to the caller without cutModelCredential or with the key in the message."
      ],
      paths: ["src/configuredModel.ts", "src/modelProbe.ts", "src/modelVault.ts", "src/jev.ts", "src/recommend.ts", "src/cloudRoleTurn.ts"]
    },
    {
      id: "browser-egress-ssrf",
      title: "The browser-fetch tool cannot reach internal or metadata addresses",
      threat: "A signed-in user or a prompt-injected agent reads internal services through the deployment's egress binding.",
      lookFor: [
        "handleBrowserFetch passing a URL to BrowserEgress without scheme, host and private-range checks in the egress service.",
        "Egress failure messages that echo upstream bodies or internal addresses back to the caller."
      ],
      paths: ["src/proxies.ts", "src/Environment.ts"]
    },
    {
      id: "upstream-leak",
      title: "Upstream bodies, headers and secrets never reach the browser or a log",
      threat: "A visitor reads service tokens, set-cookie headers, or another user's data from a reflected upstream answer or stored report.",
      lookFor: [
        "A forwarded response that keeps upstream set-cookie, CORS, or authorization headers, or caches a per-user answer.",
        "A console line or client-error record that includes a token, cookie, Authorization header, or provider-connection body.",
        "An auth error page that interpolates a query parameter without escapeHtml."
      ],
      paths: [
        "src/proxies.ts",
        "src/identity.ts",
        "src/clientErrorLog.ts",
        "src/clientErrorTelemetry.ts",
        "src/publicRepositoryReads.ts",
        "src/publicRepos.ts",
        "src/githubApp.ts",
        "src/Responses.ts"
      ]
    },
    {
      id: "auth-return-redirect",
      title: "The OAuth legs redirect only to a same-origin page and forward no attacker state",
      threat: "A crafted sign-in link sends a user who just authenticated to an attacker's site, or splits a response header on the callback.",
      lookFor: [
        "validReturnTo accepting a value that new URL resolves off-origin ('//', '/\\', encoded slashes, tab or newline).",
        "The return_to cookie read without re-running validReturnTo, or set without HttpOnly, Secure and the /api/auth path.",
        "returnToLocation copying query parameters from an upstream Location whose origin differs from the request origin."
      ],
      paths: ["src/identity.ts", "src/cloudSession.ts", "src/admittedSession.ts"]
    },
    {
      id: "anonymous-public-reads",
      title: "Anonymous public routes read only catalog repositories and never private metadata",
      threat: "An anonymous caller uses the Worker's GitHub App token to learn about private repositories or poisons the shared edge cache.",
      lookFor: [
        "A /api/public route that fetches a repository not in AVAILABLE_REPOS, or builds the GitHub URL from unvalidated path text.",
        "parseStats or the activity reader accepting a record whose private flag is not exactly false.",
        "An edge-cache key derived from a request header or query instead of the catalog name, or a GitHub App token scope wider than metadata read."
      ],
      paths: ["src/publicRepos.ts", "src/publicRepoActivity.ts", "src/publicRepoCatalog.ts", "src/githubApp.ts"]
    },
    {
      id: "maintenance-export",
      title: "Durable Object state export opens only for the operator's export token",
      threat: "Anyone who reaches /__maintenance/state-export dumps every user's durable state.",
      lookFor: [
        "An export path reachable when SMITHERS_EXPORT_TOKEN is unset or short, or compared without a fixed-size digest.",
        "Export plaintext kept, logged or returned unencrypted, or a cursor not bound to its source as AAD."
      ],
      paths: ["src/MaintenanceExport.ts", "src/SealedSnapshot.ts", "src/MaintenanceFence.ts", "src/MaintenanceAdmission.ts"]
    },
    {
      id: "deploy-scripts",
      title: "Deploy and canary scripts refuse unreviewed code and never print a secret",
      threat: "An agent or contributor deploys an unlanded commit to production or leaks the Cloudflare, identity or Stripe tokens in CI output.",
      lookFor: [
        "A real deploy path that skips the dirty-tree or origin/main check in deployGuard.ts or deploy.ts.",
        "A token from process.env printed, written to a receipt, or passed in argv to a spawned process.",
        "A spawned hook or command whose path or arguments come from environment or file content without validation."
      ],
      paths: ["scripts/**", "wrangler.jsonc", "wrangler.edge.jsonc"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, unitTests, ...securityReview }
})
