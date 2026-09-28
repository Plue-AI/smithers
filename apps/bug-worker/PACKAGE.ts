/**
 * Targets for the bug worker: the typecheck and the unit suite.
 *
 * The worker is deployed once and then receives reports from every `smithers
 * bug` ever installed, so its contract with the CLI's payload is the thing
 * worth gating. `tests/smithersBugPayload.test.ts` builds that payload out of
 * `@smthrs/control`'s own `RunSummary` and `ControlEvent`, which is why the
 * suite is in the graph rather than in a deploy script: a control DTO change
 * has to fail here, not in triage months later.
 *
 * The suite runs under Bun because the worker's own runtime is Workers, and Bun
 * is the interpreter the package's `test` script already uses.
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"

const cwd = "apps/bug-worker"

/** The worker, its schema, and the deployment description beside them. */
const sources = [
  Smithers.glob("//apps/bug-worker/src/**/*.ts"),
  Smithers.file("//apps/bug-worker/alchemy.run.ts")
]

/** The suite and its in-memory KV double. */
const suiteSources = [Smithers.glob("//apps/bug-worker/tests/**/*.ts")]

/**
 * Checks the worker and its suite against the package tsconfig.
 *
 * @since 1.0.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: [...sources, ...suiteSources],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The unit suite, including the CLI payload contract.
 *
 * @since 1.0.0
 * @category test
 */
// Coverage policy: assertion-only for the Bun Worker suite until a whole-source
// denominator is measured. See scripts/repo-contract/README.md; the real handler
// assertions remain required and no percentage guarantee is claimed.
const unitTests = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["tests"]),
  srcs: [...sources, ...suiteSources],
  deps: [],
  cwd
})

/**
 * Security review of the public Worker: every route is reachable from the
 * internet, so the checks name the admin gate, the consent tokens, the
 * outbound GitHub and Resend calls, and the KV key space.
 *
 * @since 1.0.0
 * @category security
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "alchemy.run.ts"],
  checks: [
    {
      id: "operator-gate",
      title: "Every admin route requires the x-bug-admin token before any side effect",
      threat:
        "An anonymous internet caller reads stored bug reports, records a repository claim, forks repositories with the GitHub token, or publishes an app URL.",
      lookFor: [
        "A handler for GET /api/bugs/:id, POST /api/repo-claims, POST /api/repo-requests, /complete, or /notify that reads the body, KV, or calls fetch before isOperator returns true.",
        "isOperator comparing the token with === or short-circuiting, or passing when BUG_ADMIN_TOKEN is empty or unset.",
        "A new route branch in worker.ts or repoRequests.ts that performs a write without calling isOperator."
      ],
      paths: ["src/worker.ts", "src/isOperator.ts", "src/repoClaims.ts", "src/repoRequests.ts"]
    },
    {
      id: "consent-tokens",
      title: "Confirmation and cancellation tokens are unguessable, single-use, and act only on POST",
      threat:
        "A caller or a mail scanner subscribes a third party's address, or cancels someone else's notification, without the recipient pressing the button.",
      lookFor: [
        "A token drawn from anything but crypto.getRandomValues with at least 128 bits, or accepted without matching tokenPattern.",
        "A GET on /confirm or /cancel that mutates KV instead of only rendering tokenPage.",
        "A confirm token that is not deleted after use, or a cancel record whose stored key can point outside the repo-subscriber: prefix.",
        "The token interpolated into tokenPage HTML or the email body without the hex pattern check first."
      ],
      paths: ["src/repoRequests.ts"]
    },
    {
      id: "outbound-fetch-targets",
      title: "Outbound requests carrying secrets go only to fixed GitHub and Resend hosts",
      threat:
        "A caller-supplied repository name steers a request holding GITHUB_FORK_TOKEN or RESEND_API_KEY to another host or GitHub API path.",
      lookFor: [
        "A deps.fetch URL built from a value that did not pass repoName, or repoName accepting '..', '/', '?', '#', or '%' in owner or repo.",
        "A GitHub request that follows redirects instead of redirect: \"manual\", or treats a 3xx as a found repository.",
        "A fetch with no AbortSignal timeout that lets a slow upstream hold the Worker."
      ],
      paths: ["src/repoName.ts", "src/repoRequests.ts", "src/repoForks.ts", "src/sendMail.ts"]
    },
    {
      id: "published-url-allowlist",
      title: "Only HTTPS URLs on Smithers app hosts are published or emailed",
      threat:
        "A holder of the operator token, or a corrupt KV mirror, gets subscribers emailed a phishing link or the public list serving a javascript: or foreign URL.",
      lookFor: [
        "parseAppUrl accepting a scheme other than https:, a host outside appHosts, userinfo, or a port.",
        "A readiness record read from KV and mailed or listed without parseReady or parseAppUrl.",
        "RepoCompletion accepting a POST from anything but the Worker binding after validation."
      ],
      paths: ["src/appUrl.ts", "src/repoDelivery.ts", "src/repoRequests.ts", "src/RepoCompletion.ts"]
    },
    {
      id: "pii-in-responses-and-logs",
      title: "Subscriber and claimant emails never appear in public responses or logs",
      threat:
        "An anonymous reader of GET /api/repo-claims, GET /api/repo-requests, or Workers Logs harvests the email addresses of claimants and subscribers.",
      lookFor: [
        "A GET response that spreads a stored Claim or subscriber record without removing email.",
        "logFailure or console.error given a record, request body, or error that embeds an email address or a token.",
        "A cancel URL or confirm token returned in a response to someone other than the recipient."
      ],
      paths: ["src/repoClaims.ts", "src/repoRequests.ts", "src/repoDelivery.ts", "src/logFailure.ts"]
    },
    {
      id: "intake-abuse-bounds",
      title: "Anonymous bug intake is bounded in body size, rate, and stored content",
      threat:
        "An anonymous caller exhausts KV storage or Worker memory, or plants content that triage tools later render as HTML.",
      lookFor: [
        "A body read with request.text() or request.json() instead of readBodyBounded, or a cap checked only on content-length.",
        "A rate-limit key taken from x-forwarded-for when cf-connecting-ip is present, letting a caller pick its own bucket.",
        "A stored report served with a content type other than application/json, or loose() fields echoed into HTML."
      ],
      paths: ["src/worker.ts", "src/readBodyBounded.ts", "src/checkRateLimit.ts", "src/bugReportSchema.ts"]
    },
    {
      id: "kv-key-space",
      title: "Caller input never forms a KV key outside its own prefix and repository",
      threat:
        "An anonymous caller or a confirmed subscriber reads, overwrites, or deletes another repository's subscribers, readiness, or rate-limit counters by choosing a key segment.",
      lookFor: [
        "A KV key or list prefix built from a request value that did not pass repoName, tokenPattern, or loginName, or a repoName regex that admits ':'.",
        "A subscriber list prefix `repo-subscriber:${name}:` that one repository name can extend into another's.",
        "A rate-limit bucket whose caller-chosen segment (x-forwarded-for, 'unknown') lets one caller share or reset another bucket such as repos-read: or claims:.",
        "cancelSubscription deleting a stored key without checking it still starts with repo-subscriber:."
      ],
      paths: ["src/worker.ts", "src/repoRequests.ts", "src/repoClaims.ts", "src/repoDelivery.ts", "src/checkRateLimit.ts", "src/repoName.ts"]
    },
    {
      id: "deploy-secrets",
      title: "Deployment binds every secret as a redacted secret and serves only declared hosts",
      threat:
        "A deploy leaks BUG_ADMIN_TOKEN, RESEND_API_KEY, or GITHUB_FORK_TOKEN into plain-text bindings or state, or exposes the Worker on workers.dev without its domain.",
      lookFor: [
        "A secret bound with requireText or a literal instead of requireSecret.",
        "workersDev set to true or a domain alias outside smithers.sh.",
        "A default or empty admin token that a missing env var would deploy."
      ],
      paths: ["alchemy.run.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, unitTests, ...securityReview }
})
