/**
 * Targets for the review seeded-bug suite.
 *
 * Two test targets, because the suite has two halves that fail for different
 * reasons. `test` is the corpus-integrity and scoring-math suite: pure, fast,
 * and independent of the review app. `suite` runs the real review flow over all
 * sixteen fixtures and gates the result on `baseline.json`; it is offline
 * because its reviewing seat is `deterministicReviewer.ts` rather than a model,
 * so it spends nothing and answers the same way twice. Both run from this
 * directory, which is a workspace member (`@smthrs/eval-review-seeded-bugs`),
 * so `bun` and `tsc` read the toolchain the manifest pins.
 *
 * There is no `lint` or `fmt` target. `corpus/` is the eval's input: thirty
 * base/head source files whose exact text — and therefore whose exact line
 * numbers — is what the reviewer anchors findings to and what `score.ts`
 * matches them against. A formatter would rewrite the corpus and silently move
 * the thing being measured.
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"

const cwd = "evals/review-seeded-bugs"

/** The suite's own sources, the corpus it reads, and the baseline it gates on. */
const sources = [
  Smithers.glob("//evals/review-seeded-bugs/*.ts"),
  Smithers.glob("//evals/review-seeded-bugs/corpus/**/*"),
  Smithers.file("//evals/review-seeded-bugs/baseline.json")
]

/**
 * Runs every fixture through the real review flow and gates on the baseline.
 *
 * A red run means the pipeline moved: diff ingestion, per-file fan-out,
 * scoping, anchoring, de-duplication, or the scorer's matching. The model's own
 * score is what `run.ts --live` measures, and it is never a gate.
 *
 * @since 1.0.0
 * @category test
 */
const suite = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.entrypoint(Smithers.file("//evals/review-seeded-bugs/run.ts")),
  srcs: sources,
  deps: [],
  cwd
})

/**
 * The corpus-integrity and scoring-math suite.
 *
 * @since 1.0.0
 * @category test
 */
const test = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["score.test.ts", "deterministicReviewer.test.ts"]),
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
 * Security review of the suite's harness and corpus: `security` reviews the
 * diff against origin/main, `securityAudit` reviews every included file.
 *
 * @since 1.0.0
 * @category security
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["*.ts", "corpus/**", "baseline.json", ".gitignore"],
  checks: [
    {
      id: "fixture-git-isolation",
      title: "Materializing a fixture never lets corpus content configure or run git",
      threat: "A contributor who adds a corpus fixture runs arbitrary commands on the maintainer's or CI machine when run.ts materializes it.",
      lookFor: [
        "copyDirectoryContents copying a base/ or head/ entry named .git, .gitattributes, or .gitmodules into the fixture repository after git init.",
        "clearWorktree skipping .git while head/ is copied over it, so a head/.git/config (core.fsmonitor, core.hooksPath, filter drivers) is honored by later git calls in the review flow.",
        "A corpus .gitattributes naming a filter, diff, or merge driver that git add or the review flow's git diff would honor."
      ],
      paths: ["run.ts", "corpus/**"]
    },
    {
      id: "fixture-symlink-escape",
      title: "Fixture trees cannot pull files from outside the corpus into a review prompt",
      threat: "A corpus fixture with a symlink makes the review flow read a maintainer's host file (SSH key, .env) and send it to a live model or write it into .report/.",
      lookFor: [
        "cpSync in copyDirectoryContents preserving or dereferencing a symlink under corpus/*/base or corpus/*/head that points outside the fixture.",
        "A committed symlink or absolute-path entry anywhere under corpus/."
      ],
      paths: ["run.ts", "corpus/**"]
    },
    {
      id: "scripted-cell-injection",
      title: "The scripted seat emits only a JSON literal inside ctx.done, whatever the diff contains",
      threat: "Diff text echoed back through existingCode breaks out of the cell fence or the ctx.done call and executes as agent cell code in the review flow.",
      lookFor: [
        "scriptedModel building the cell from anything other than JSON.stringify of the answer value.",
        "existingCode or content in reviewDiff carrying a ``` sequence from the diff that terminates the cell fence early.",
        "readPrompt trusting a 'Current file path:' line that diff content, not the prompt template, supplies."
      ],
      paths: ["scriptedSeats.ts", "deterministicReviewer.ts"]
    },
    {
      id: "live-report-leak",
      title: "--live reports hold scores and findings only, never credentials or prompts with secrets",
      threat: "A maintainer running --live writes provider keys or resolved seat routes into .report/ and later commits or shares them.",
      lookFor: [
        "report.json serializing seat, route, header, or environment values from resolveReviewSeats.",
        ".report/ missing from .gitignore.",
        "An error path in main that prints a resolved provider credential or request header."
      ],
      paths: ["run.ts", ".gitignore"]
    },
    {
      id: "live-cell-authority",
      title: "Under --live, a model steered by corpus text can only answer, never act on the host",
      threat: "A fixture whose diff carries prompt-injection text makes a live review seat run a cell that reads the maintainer's files, calls a tool, or dials a non-model host with the maintainer's provider keys.",
      lookFor: [
        "run.ts building the --live layer with anything other than layerMemory over reviewSeatResolver, so the tool-less agentHost (empty registry, calls limit, model-only capabilityEnvelope) is bypassed.",
        "run.ts passing layerMemory an environment other than process.env's seat settings, which widens the model-host capability envelope.",
        "The Review.execute payload in runFixture enabling verify, narrate, or quiz seats that are not bound by the same host."
      ],
      paths: ["run.ts"]
    },
    {
      id: "gate-integrity",
      title: "The offline gate cannot be satisfied by weakening the baseline or reading labels",
      threat: "A change makes the deterministic reviewer or the baseline gate pass regardless of pipeline regressions, hiding a security-relevant review failure.",
      lookFor: [
        "deterministicReviewer.ts reading label.json or any corpus ground truth.",
        "loadCorpus accepting a label whose fixture field differs from its directory or whose schema is loosened.",
        "drift in baseline.ts ignoring a changed per-fixture record, or run.ts treating an unreadable baseline as a pass."
      ],
      paths: ["deterministicReviewer.ts", "labels.ts", "baseline.ts", "run.ts", "baseline.json"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, suite, test, ...securityReview }
})
