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

export const Package = Smithers.Package({
  targets: { check, unitTests }
})
