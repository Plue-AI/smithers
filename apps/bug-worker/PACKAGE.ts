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

/** Security review of anonymous intake and authenticated report retrieval. */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "alchemy.run.ts"],
  checks: [
    {
      id: "operator-gate",
      title: "Stored reports require the x-bug-admin token before any read",
      threat: "An anonymous caller reads private bug report contents.",
      lookFor: [
        "GET /api/bugs/:id reads storage before isOperator succeeds.",
        "A missing admin token admits a caller or comparison leaks the secret length."
      ],
      paths: ["src/worker.ts", "src/isOperator.ts"]
    },
    {
      id: "intake-abuse-bounds",
      title: "Anonymous bug intake is bounded in body size, rate, and stored content",
      threat: "An anonymous caller exhausts storage or Worker memory, or plants HTML for triage tools.",
      lookFor: [
        "A body read buffers before readBodyBounded, or the cap trusts content-length alone.",
        "A rate-limit key trusts x-forwarded-for instead of cf-connecting-ip.",
        "Counters use KV read-modify-write instead of RateLimiter, IPv6 bypasses the /64 budget, or the all-clients hourly cap is absent.",
        "A stored report is served as HTML or loose fields are echoed into HTML."
      ],
      paths: ["src/worker.ts", "src/readBodyBounded.ts", "src/checkRateLimit.ts", "src/RateLimiter.ts", "src/bugReportSchema.ts"]
    },
    {
      id: "kv-key-space",
      title: "Report retrieval stays inside the generated bug key space",
      threat: "A caller chooses an ID that reads a different KV namespace prefix.",
      lookFor: ["A report ID admits path separators, colons or other characters outside the generated ID format."],
      paths: ["src/worker.ts", "src/newBugId.ts"]
    },
    {
      id: "deploy-secrets",
      title: "Deployment redacts the admin secret and serves only declared hosts",
      threat: "Deployment leaks BUG_ADMIN_TOKEN into plain bindings or exposes intake outside the configured domain.",
      lookFor: [
        "The admin token uses a literal or plaintext Config instead of requireSecret.",
        "workersDev is enabled, a domain alias escapes smithers.sh, or a missing token defaults to an empty value."
      ],
      paths: ["alchemy.run.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, unitTests, ...securityReview }
})
