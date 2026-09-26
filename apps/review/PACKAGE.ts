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

export const Package = Smithers.Package({
  targets: { check, checkTests, unitTests }
})
