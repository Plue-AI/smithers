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
 * The security review of the shared edge: `security` reviews the diff
 * against origin/main and `securityAudit` audits every reviewed file. The
 * checks name what the edge holds: the caller's credentials on their way to
 * the pinned backend, the retained legacy Durable Object state, and the
 * operator-only sealed export of it.
 *
 * @since 0.1.0
 * @category security
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "scripts/**", "wrangler.jsonc"],
  boundaries: [{
    id: "repository-flow-invocation",
    actors: ["Browser user", "Deployed shared edge", "Backend authenticated user"],
    assets: ["Browser session and API token", "Repository workflow runs and secrets"],
    entryPoints: ["Browser repository flow invocation requests forwarded to the shared backend"],
    identityTransformations: ["Edge forwards caller credentials unchanged; backend validates the session or API token and resolves user and repository permissions"],
    enforcementPoints: ["Edge strips forged identity headers and pins the backend origin; backend authentication, CSRF and repository authorization precede admission"],
    deploymentAssumptions: ["Public route composition is reviewed here; private ingress, TLS and credential configuration require a separate pinned hosted review"],
    path: {
      caller: ["src/edge.ts", "src/Boundary.ts", "src/Http.ts"],
      authorization: ["//packages/backend/internal/compose/router.go", "//packages/backend/internal/middleware/auth.go", "//packages/backend/internal/middleware/auth_loader_failures.go", "//packages/backend/internal/middleware/csrf.go", "//packages/backend/internal/compose/runtime_helpers.go", "//packages/backend/internal/middleware/repo_context.go", "//packages/backend/internal/middleware/revocation_guard.go", "//packages/backend/internal/middleware/run_credential.go", "//packages/backend/internal/middleware/scope.go", "//packages/backend/internal/services/repo_permissions.go"],
      service: ["//packages/backend/internal/routes/workflow_invoke.go", "//packages/backend/internal/services/workflow_invoke.go", "//packages/backend/internal/services/workflow_invoke_flow.go"],
      storageOrEgress: ["//packages/backend/internal/db/workflows.sql.go", "//packages/backend/flowdispatch/service.go"]
    }
  }, {
    id: "browser-workflow-dispatch",
    actors: ["Browser user", "Deployed shared edge", "Backend user", "Flow host"],
    assets: ["Browser session and API token", "Repository workspace", "Flow control operations"],
    entryPoints: ["POST /api/workflow/provision and /api/workflow/rpc"],
    identityTransformations: ["Edge forwards caller credentials unchanged; backend validates the session or API token and derives the repository-scoped host target"],
    enforcementPoints: ["Backend route authentication, CSRF and write scope; repository access and workspace ownership before dispatch"],
    deploymentAssumptions: ["Public composition is reviewed here; hosted ingress, TLS and injected credentials are separate private review scope"],
    path: {
      caller: ["src/edge.ts", "src/Boundary.ts", "src/Http.ts"],
      authorization: ["//packages/backend/internal/compose/main.go", "//packages/backend/internal/compose/router.go", "//packages/backend/internal/compose/browser_flow.go", "//packages/backend/internal/middleware/auth.go", "//packages/backend/internal/middleware/auth_loader_failures.go", "//packages/backend/internal/middleware/csrf.go", "//packages/backend/internal/compose/runtime_helpers.go", "//packages/backend/internal/middleware/scope.go", "//packages/backend/internal/middleware/revocation_guard.go", "//packages/backend/internal/middleware/run_credential.go", "//packages/backend/internal/services/repo.go", "//packages/backend/internal/services/repo_permissions.go", "//packages/backend/internal/db/workspace.sql.go"],
      service: ["//packages/backend/internal/compose/browser_flow.go", "//packages/backend/internal/compose/browser_flow_target.go"],
      storageOrEgress: ["//packages/backend/flowdispatch/service.go", "//packages/backend/flowhost/resolver.go", "//packages/backend/flowhost/store.go"]
    }
  }],
  checks: [
    {
      id: "edge-forwarding",
      title: "The edge forwards /api unchanged to the pinned backend and forges no identity",
      threat: "A browser injects identity or forwarding headers, or steers the backend origin, so the backend attributes a request to another user or origin.",
      lookFor: [
        "A forwarded request that keeps a client-sent x-user-*, x-smithers-user-*, x-forwarded-*, forwarded, x-real-ip, x-smithers-service-token or x-smithers-token-id header.",
        "A backend origin taken from the request (Host, a header, a path or query) instead of the SMITHERS_BACKEND_ORIGIN binding, or one that equals the incoming origin or carries credentials, a path or a query.",
        "An upstream fetch that follows a redirect, mints or attaches a credential, or rebuilds an upgrade the backend answered."
      ],
      paths: ["src/edge.ts", "src/Http.ts", "src/Boundary.ts"]
    },
    {
      id: "retired-state",
      title: "Retained legacy Durable Objects serve nothing and keep every trace of pending work",
      threat: "A request reads or writes a retained legacy object's product state, or a fired alarm deletes the only record of work that was pending at retirement.",
      lookFor: [
        "A retained class whose fetch reads or writes storage, or answers anything but 410 authority_retired.",
        "An alarm that is acknowledged without its marker being recorded and flushed, or a marker written outside the reserved maintenance table."
      ],
      paths: ["src/retainedDurableObjects.ts", "src/RetiredDurableObject.ts"]
    },
    {
      id: "maintenance-export",
      title: "Durable Object state export opens only for the operator's export token",
      threat: "Anyone who reaches /__maintenance/state-export dumps every user's durable state.",
      lookFor: [
        "An export path reachable when SMITHERS_EXPORT_TOKEN is unset or short, or compared without a fixed-size digest.",
        "Export plaintext kept, logged or returned unencrypted, or a cursor not bound to its source as AAD."
      ],
      paths: ["src/MaintenanceExport.ts", "src/SealedSnapshot.ts"]
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
      paths: ["scripts/**", "wrangler.jsonc"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, unitTests, ...securityReview }
})
