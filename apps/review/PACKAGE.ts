/**
 * Targets for the review application: two typechecks and the unit suite.
 *
 * Two typechecks because the app has two type environments and they are not
 * compatible. `src/` runs under Node — the bin is `bin/smithers-review.mjs`
 * and the durable runtime it composes needs Node's HTTP client — so it is
 * checked with `@types/node` alone. The suite runs under Bun, whose own types
 * redefine `process.env` in a way the workspace packages' own signatures
 * refuse, so it is checked separately with `bun-types` on top.
 *
 * Live GitHub suites require SMITHERS_REVIEW_E2E=1. Run `pnpm test:live`
 * separately with credentials; ordinary unit tests never contact GitHub.
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"

const cwd = "apps/review"

/** The CLI, the flow, the walkthrough renderer, and the Worker. */
const sources = [
  Smithers.glob("//apps/review/src/**/*.ts"),
  Smithers.glob("//apps/review/action/src/**/*.ts"),
  Smithers.glob("//apps/review/bin/*.mjs"),
  Smithers.file("//apps/review/action/action.yml")
]

/** The suite, and the fixtures it spawns. */
const suiteSources = [
  Smithers.glob("//apps/review/tests/**/*.ts"),
  Smithers.glob("//apps/review/tests/**/fixtures/*"),
  Smithers.file("//apps/review/CONTRIBUTING.md"),
  Smithers.file("//docs/api/github-maintainer-comment.vectors.json"),
  Smithers.file("//.github/workflows/ci.yml")
]

/**
 * Checks the application sources against the Node tsconfig.
 *
 * @since 1.0.0
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
 * Checks the suite against the Bun tsconfig.
 *
 * @since 1.0.0
 * @category build
 */
const checkTests = Smithers.Typecheck({
  srcs: [...sources, ...suiteSources],
  deps: [],
  tsconfig: Smithers.file("tsconfig.test.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The offline unit suite; live cases require explicit opt-in.
 *
 * @since 1.0.0
 * @category test
 */
// Coverage policy: assertion-only for the Bun suite. Mixed CLI/Worker code and
// the optional credentialed case have no measured whole-source denominator.
// See scripts/repo-contract/README.md; this is coverage debt, not a 100% claim.
const unitTests = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["tests"]),
  srcs: [...sources, ...suiteSources],
  deps: [],
  cwd
})

/**
 * Security review of the hosted review service, the GitHub Action, and the CLI.
 *
 * `security` reviews the diff against origin/main; `securityAudit` is the
 * manual full audit.
 *
 * @since 1.0.0
 * @category security
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "action/**", "bin/**", "alchemy.run.ts"],
  checks: [
    {
      id: "oidc-session-identity",
      title: "A review session is minted only for the registered repository's trusted workflow",
      threat:
        "Anyone who can push a branch, or any other GitHub repository, mints a session that spends a registered repo's inference budget and publishes under its name.",
      lookFor: [
        "verifyOidc accepting a token before RS256 signature, iss, aud 'smithers-review', exp, nbf, and iat are all checked.",
        "handleSessions trusting the name-only repository claim instead of repository_id and repository_owner_id matched against the registration.",
        "isTrustedWorkflow or WORKFLOW_REF admitting a refs/pull/* ref, a case-folded workflow path, or an empty or corrupt allowed_workflow_refs row.",
        "A body-supplied pr number overriding the PR in the OIDC ref or pull_request claim on a pull_request event."
      ],
      paths: ["src/server/sessions/**", "src/server/githubRepositoryId.ts", "src/server/sameRepoName.ts"]
    },
    {
      id: "proxy-key-confinement",
      title: "The shared Anthropic key reaches only POST /v1/messages on the configured origin",
      threat:
        "A session or srk_ key holder uses the service-wide Anthropic key to read, delete, or batch other tenants' Anthropic workspace objects, or exfiltrates the key itself.",
      lookFor: [
        "anthropicEndpointAllowed matching by prefix, decoded path, or trailing slash instead of the exact method and path pair.",
        "A redirect followed with the injected x-api-key to an origin other than new URL(anthropicBaseUrl).origin.",
        "pickForwardHeaders forwarding a client header beyond content-type, accept, accept-encoding, anthropic-version, anthropic-beta, or url.search forwarding a parameter that changes upstream behavior.",
        "An error body, log line, or passthrough header that echoes env.ANTHROPIC_API_KEY or upstream request headers."
      ],
      paths: ["src/server/proxy/**", "src/server/worker.ts"]
    },
    {
      id: "spend-metering",
      title: "Every proxied call is priced, reserved, and settled against session, key, and repo caps",
      threat:
        "A session or srk_ key holder drives Anthropic spend past the session, API key, or monthly repo cap that the operator pays for.",
      lookFor: [
        "priceRequest admitting a field, content block, tool type, beta header, or content-encoding whose cost the byte-based bound does not cover.",
        "reserveUsage or claimReviewSlot split into a read then a write so concurrent requests both pass the cap.",
        "A reservation deleted on an ambiguous 2xx or transport failure, or recordUsage accepting a response model priced differently from the admitted one.",
        "An srk_ key path where x-smithers-repo selects a repo outside the key's repos list or a repo-less key meters against any repo."
      ],
      paths: ["src/server/proxy/**", "src/server/sessions/claimReviewSlot.ts", "src/server/sessions/handleSessions.ts", "src/server/assertRepoUnderMonthlyCap.ts", "src/server/repoMonthly*.ts"]
    },
    {
      id: "tenant-scoped-walkthroughs",
      title: "Walkthrough history, publish, and delete are scoped to the caller's repositories",
      threat:
        "A session or API key for one repository lists, deletes, or floods another repository's hosted walkthroughs.",
      lookFor: [
        "handleHistory, handleDelete, or handlePlan skipping canAccessRepo, or comparing a query-supplied repo without the credential's repo list.",
        "A revoked srk_ key or an expired session still accepted by authenticateProxyRequest.",
        "The per-session publish limit counted outside the same INSERT that reserves the row."
      ],
      paths: ["src/server/walkthroughs/**", "src/server/plan/**", "src/server/proxy/authenticateProxyRequest.ts", "src/server/sessions/lookupApiKey*.ts"]
    },
    {
      id: "hosted-html-isolation",
      title: "Hosted and rendered walkthrough HTML cannot run script with the service origin's authority",
      threat:
        "A pull request author prompt-injects the narrator so the walkthrough runs script that reads another visitor's data or acts as review.jjhub.tech.",
      lookFor: [
        "The GET /w/<id> response losing its content-security-policy 'sandbox allow-scripts' header or allowing allow-same-origin.",
        "Model output (story prose, titles, paths, mermaid, quiz text, findings) interpolated into HTML without escapeHtml first.",
        "Mermaid initialized with a securityLevel other than 'strict', or JSON embedded in a <script> without escaping '</'."
      ],
      paths: ["src/server/worker.ts", "src/walkthrough/**", "src/diffs/**", "src/quiz/**"]
    },
    {
      id: "admin-token-endpoints",
      title: "Admin, metrics, and publish-token routes compare the bearer in constant time and fail closed when unset",
      threat:
        "An unauthenticated caller registers repositories, mints srk_ keys, or reads per-repo spend.",
      lookFor: [
        "A handler under src/server/admin or src/server/metrics that runs a query before the timingSafeStringEqual check or accepts an empty ADMIN_TOKEN or METRICS_TOKEN.",
        "handleAdminRepos rebinding an existing repository_id or owner_id to a different repo name.",
        "Minted srk_ plaintext written to D1, logs, or a list response."
      ],
      paths: ["src/server/admin/**", "src/server/metrics/**", "src/server/timingSafeStringEqual.ts", "src/server/walkthroughs/**"]
    },
    {
      id: "action-untrusted-pr-execution",
      title: "The GitHub Action never runs pull request code or leaks job credentials to the review subprocess",
      threat:
        "A fork contributor or read-only commenter runs code in the job or steals GH_TOKEN, the OIDC request token, or the session token.",
      lookFor: [
        "gateEvent admitting a fork PR, a non-'created' comment, a GitHub App comment, or a commenter without admin or write permission, or treating a failed permission read as allowed.",
        "An install, build, or bun invocation whose cwd or config resolves inside the checked-out PR tree instead of github.action_path.",
        "ACTIONS_ID_TOKEN_REQUEST_TOKEN or a caller provider key (materializeInferenceCredentials list) surviving into the spawned review CLI's environment.",
        "An action.yml `run:` that interpolates ${{ }} event data directly into shell text."
      ],
      paths: ["action/**", "src/github/runGh.ts"]
    },
    {
      id: "review-output-injection",
      title: "Model findings posted to GitHub cannot trigger actions or reach outside the reviewed PR",
      threat:
        "A pull request author prompt-injects the review model to post comments that mention, close, or approve on behalf of the token owner, or to address a different PR.",
      lookFor: [
        "buildPullRequestReview or postPullRequestReview passing model text into gh argv as a flag, or choosing the review event (APPROVE/REQUEST_CHANGES) from model output.",
        "A finding path or line not checked against the PR's own changed files before it becomes a review comment.",
        "supersedePriorReviews deleting or dismissing reviews it did not author."
      ],
      paths: ["src/github/**", "src/review/anchorFinding.ts", "src/workflow/applyFindingVerdicts.ts"]
    },
    {
      id: "checkout-path-confinement",
      title: "Reading the diff and writing the walkthrough stay inside the repository and never follow PR-controlled symlinks out",
      threat:
        "A pull request author commits a symlink so the review copies runner files into a prompt or published walkthrough, or overwrites a runner file.",
      lookFor: [
        "loadDiffs reading an untracked path without lstat plus O_NOFOLLOW.",
        "writeWalkthroughArtifact or walkthroughPath writing under <repo>/.smithers-review when that path is a symlink the PR controls.",
        "A git invocation where a PR-supplied ref, sha, or path can start with '-' and is not behind '--' or --end-of-options.",
        "buildFileFilter honoring .opencodereview/rule.json from the change under review in range or commit mode."
      ],
      paths: ["src/git/**", "src/walkthrough/writeWalkthroughArtifact.ts", "src/walkthrough/walkthroughPath.ts", "src/review/buildFileFilter.ts", "src/cli/runReview.ts"]
    },
    {
      id: "review-agent-authority",
      title: "Review, verify, narrate, and quiz seats get no tools and dial only the configured model hosts",
      threat:
        "A pull request author prompt-injects a review seat to read runner files, run commands, or send the diff and provider key to an attacker-chosen origin.",
      lookFor: [
        "agentHost registering a non-empty tool registry, or layerNode granting a capability beyond model:call on the modelCallHosts set.",
        "modelCallHosts widening to '*' or to a host derived from model output, a seat string, or PR content instead of the operator's ANTHROPIC_BASE_URL.",
        "An AgentAction prompt or system text that embeds PR-controlled content where the seat can treat it as instructions to change the output schema or the target PR."
      ],
      paths: ["src/workflow/reviewLayer.ts", "src/workflow/reviewSeatResolver.ts", "src/workflow/reviewSeats.ts", "src/workflow/reviewAgentActions.ts"]
    },
    {
      id: "publish-token-transport",
      title: "The CLI sends the walkthrough publish token only to the configured service over HTTPS",
      threat:
        "A network attacker or a hostile publish URL captures SMITHERS_REVIEW_PUBLISH_TOKEN and publishes or deletes walkthroughs as the token's repositories.",
      lookFor: [
        "loadPublishConfig accepting an http:// SMITHERS_REVIEW_PUBLISH_URL or publishUrl and sending the Bearer token over it.",
        "The publish fetch following a redirect that carries the authorization header to another origin.",
        "The token or ~/.smithers-review.json contents printed in an error or progress line."
      ],
      paths: ["src/cli/publishWalkthrough.ts", "src/cli/main.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, checkTests, unitTests, ...securityReview }
})
