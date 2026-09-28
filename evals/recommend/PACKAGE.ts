/**
 * Targets for the command-recommender eval.
 *
 * Two test targets, because the suite has two halves that fail for different
 * reasons. `test` is the scoring-math and program-behaviour suite: pure,
 * fast, and offline. `suite` scores the checked-in fixture and gates the
 * result on `baseline.json`, so a red run means the scorer moved. Neither
 * touches the network: the live pull (`run.ts --live`) is an operator command
 * that reads an admin token from the environment, and it has no target.
 *
 * Both run from this directory, which is a workspace member
 * (`@smthrs/eval-recommend`), so `bun` and `tsc` read the toolchain the
 * manifest pins.
 *
 * There is no `lint` or `fmt` target. `baseline.json` is the canonical JSON
 * `run.ts --update` writes byte for byte, and `fixtures/sample.jsonl` is one
 * JSON object per line; a formatter would rewrite both.
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"

const cwd = "evals/recommend"

/** The suite's own sources, the fixture it scores, and the baseline it gates on. */
const sources = [
  Smithers.glob("//evals/recommend/*.ts"),
  Smithers.file("//evals/recommend/fixtures/sample.jsonl"),
  Smithers.file("//evals/recommend/baseline.json")
]

/**
 * Scores the fixture and gates on the baseline.
 *
 * @since 1.0.0
 * @category test
 */
const suite = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.entrypoint(Smithers.file("//evals/recommend/run.ts")),
  srcs: sources,
  deps: [],
  cwd
})

/**
 * The scoring-math and program-behaviour suite.
 *
 * @since 1.0.0
 * @category test
 */
const test = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["score.test.ts", "run.test.ts"]),
  srcs: sources,
  deps: [],
  cwd
})

/**
 * Checks the suite's own sources, including its two `bun:test` files, against
 * its tsconfig.
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
 * Security review of the suite's sources: `security` reviews the diff against
 * origin/main and `securityAudit` audits every file.
 *
 * @since 1.0.0
 * @category security
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["*.ts", "fixtures/**", "baseline.json", "README.md"],
  checks: [
    {
      id: "admin-token-confinement",
      title: "SMITHERS_ADMIN_TOKEN reaches only the admin log route and never an output stream",
      threat: "Anyone reading CI logs, a pasted report, or a redirect target obtains the deployment's admin bearer and reads every admin route.",
      lookFor: [
        "The token or the Authorization header value interpolated into a stdout or stderr message in pullRows or main.",
        "A thrown error or fetch failure message that echoes request headers or the token.",
        "SMITHERS_ORIGIN accepted with an http:// scheme or a non-smithers host, so the bearer is sent in cleartext or to an arbitrary server.",
        "The live fetch following a redirect that forwards the Authorization header to another origin (no redirect: \"manual\" or \"error\").",
        "A test in run.test.ts that stubs fetch without asserting the token never appears in captured stdout and stderr."
      ],
      paths: ["run.ts", "run.test.ts", "README.md"]
    },
    {
      id: "live-log-parsing",
      title: "A hostile or compromised deployment's log response cannot crash, hang, or mislead the scorer",
      threat: "Whoever controls the SMITHERS_ORIGIN response feeds rows that exhaust memory, pollute prototypes, or forge the operator's quality report.",
      lookFor: [
        "response.json() read without a size cap, so an unbounded body is buffered in memory.",
        "scoreLog assigning perRepo[key] on a plain {} object, so a row with repo \"__proto__\" replaces the prototype and silently drops that bucket from the report and --json output.",
        "The rows array accepted with more than LIVE_LIMIT entries, or a row's commands or string fields accepted without a length cap.",
        "asLogRow passing through a field it did not type-check, so a crafted row carries objects where strings are rendered."
      ],
      paths: ["run.ts", "score.ts"]
    },
    {
      id: "terminal-escape-injection",
      title: "Repo, model, and command strings from a log are printed without terminal control sequences",
      threat: "A user who names a repository, or a deployment that returns crafted rows, injects ANSI or OSC escapes into the operator's terminal to hide rows or plant clickable links.",
      lookFor: [
        "renderBuckets, renderPerModel, or renderFrontDoor writing repo or model names raw without stripping C0/C1 control characters.",
        "RecommendLogError messages that quote a row id or field value from untrusted input verbatim to stderr."
      ],
      paths: ["score.ts", "run.ts"]
    },
    {
      id: "fixture-privacy",
      title: "The checked-in fixture and baseline hold no real user data or credentials",
      threat: "A contributor commits exported production rows, leaking real users' repositories, chat-tail digests of guessable text, or tokens to anyone who clones the repo.",
      lookFor: [
        "fixtures/sample.jsonl rows naming private repositories, real user ids, emails, or bearer-shaped strings.",
        "A log row field that carries chat text instead of only the tailDigest.",
        "--update writing a live or --input score into baseline.json instead of only the fixture's score."
      ],
      paths: ["fixtures/**", "baseline.json", "run.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, suite, test, ...securityReview }
})
