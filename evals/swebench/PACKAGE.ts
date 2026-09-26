/**
 * Targets for the SWE-bench benchmark rig.
 *
 * The offline fixtures and TypeScript check gate CI after the workspace install.
 * The subject and evaluator checks are an explicit operator target requiring
 * a built CLI and evaluator venv. Docker and funded-model benchmarks remain
 * documented operator commands.
 *
 * `lint` and `fmt` cover the rig's code only. The rest of this directory is
 * captured evaluator output (`baseline/`, `reports/`, `fullbench/`, fixture
 * data) whose bytes are evidence of what a wave measured.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "evals/swebench"

/**
 * Checks the scorecard generator and its price table against their tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: [Smithers.glob("//evals/swebench/*.ts")],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/** The rig's code, as `eslint.config.js` and `dprint.json` scope it. */
const code = [Smithers.glob("*.ts"), Smithers.glob("*.mjs"), Smithers.glob("lib/*.mjs")]

/**
 * Lints the rig's scripts.
 *
 * @since 1.0.0
 * @category lint
 */
const lint = Smithers.EsLint({
  sources: code,
  configs: [Smithers.file("eslint.config.js"), Smithers.file("//eslint.invariants.js")],
  deps: [],
  maxWarnings: 0,
  fix: false,
  cwd
})

/**
 * Checks formatting of the rig's scripts and fixture checks.
 *
 * @since 1.0.0
 * @category lint
 */
const fmt = Smithers.Dprint({
  sources: [...code, Smithers.glob("fixtures/*.mjs")],
  config: Smithers.file("dprint.json"),
  deps: [],
  fix: false,
  cwd
})

// Declare the rig scripts, recorded fixtures and imported workspace code.
const fixtureInputs = [
  Smithers.glob("//evals/swebench/*.{ts,mjs,sh,md}"),
  Smithers.glob("//evals/swebench/lib/**"),
  Smithers.glob("//evals/swebench/fixtures/**"),
  Smithers.glob("//evals/swebench/baseline/**"),
  Smithers.ImportClosure({
    entries: [
      Smithers.glob("*.ts"),
      Smithers.glob("*.mjs"),
      Smithers.glob("lib/*.mjs"),
      Smithers.glob("fixtures/*.mjs")
    ]
  }),
  Smithers.file("//packages/smithers/agent/harness/test/fixtures/wave10Journals.json"),
  Smithers.file("package.json"),
  Smithers.file("//packages/smithers/package.json"),
  Smithers.file("//packages/smithers/bin/smithers.mjs"),
  Smithers.file("//PACKAGE.ts"),
  Smithers.file("//.github/workflows/ci.yml")
]

const offline = Smithers.Shell.Test({
  summary: "Run the token-free SWE-bench fixtures serially, without Docker or a CLI build.",
  script: Smithers.file("verify.sh"),
  args: ["--offline"],
  data: fixtureInputs,
  timeout: "20m"
})

const prerequisites = Smithers.Shell.Run({
  summary: "Check the subject and evaluator after preflight.sh and bootstrap.sh.",
  script: Smithers.file("verify.sh"),
  args: ["--prerequisites"],
  data: fixtureInputs,
  timeout: "20m"
})

export const Package = Smithers.Package({
  targets: { check, lint, fmt, offline, prerequisites }
})
