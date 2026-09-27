/**
 * The fault-injection suite a package declares for itself.
 *
 * @since 0.1.0
 */

import * as Input from "./Input.ts"
import type * as PackageManager from "./PackageManager.ts"
import type * as Target from "./Target.ts"
import { Vitest } from "./Vitest.ts"

/**
 * Options accepted by {@link FaultSuite}.
 *
 * `cwd` is the workspace-relative directory containing the package to test.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * The package manager the run goes through. When omitted in a PACKAGE.ts,
   * it resolves from the workspace declaration when the
   * graph is planned.
   */
  readonly packageManager?: PackageManager.PackageManager | undefined
  /** The workspace-relative package directory the run starts in. */
  readonly cwd: string
  /** @default [] */
  readonly deps?: ReadonlyArray<Target.AnyTarget> | undefined
  /** The source tree the run keys on. Defaults to the package `src` tree. */
  readonly sources?: Input.Glob | undefined
  /** The cases the run keys on. Defaults to the package `test/faults` tree. */
  readonly tests?: Input.Glob | undefined
  /**
   * The harness, fixtures, and budgets the cases read. They are separate from
   * `tests` because they are not test files and vitest never selects them,
   * while a change to one still has to re-key the suite. Defaults to
   * everything under `test/faults` that is not a case.
   */
  readonly fixtures?: Input.Glob | undefined
  /**
   * The vitest config the run names. It defaults to the package's own
   * `vitest.faults.config.ts`, which is a second config rather than the
   * package's `vitest.config.ts` because the two tiers disagree about file
   * parallelism and about coverage; `null` leaves the discovery implicit.
   */
  readonly config?: Input.File | null | undefined
  /** @default "node" */
  readonly environment?: string | undefined
}

/**
 * Runs one package's fault-injection cases, serially, without coverage.
 *
 * A fault case injects a real fault into a real process: it `SIGKILL`s a pid,
 * cuts a live socket, binds an ephemeral port, or reads the machine's process
 * table. Every one of those is machine-global, so two cases in two files
 * cannot share a machine safely and the emitted target names a config whose
 * `fileParallelism` is `false`. That is also why the tier is a second target
 * rather than more files under the package's ordinary `test`: a unit suite
 * that ran beside a case would be racing a process reaper it never declared.
 *
 * The emitted Vitest target carries `exclusive: true`. Wildcard `ci` and
 * `test` selections omit it unless `--include-exclusive` opts in. An explicit
 * label such as `//packages/...:faults` selects it directly. The executor
 * drains ready ordinary work before running each exclusive target alone,
 * regardless of `--jobs`. This isolation covers one executor invocation;
 * independent invocations still need separate machines or external coordination.
 *
 * Coverage is off because these cases are the wrong
 * instrument for it. A case spends most of its wall time in child processes
 * whose coverage this process never sees, and the package's `test` target
 * beside it stays the coverage gate.
 *
 * The conventional key is `faults`, which makes `//packages/...:faults` the
 * whole matrix, and the package's `check` target already typechecks
 * `test/**` so a stale harness or fixture fails fast and cheaply before any
 * case spawns anything.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const faults = Smithers.FaultSuite({ cwd: "packages/core" })
 * ```
 *
 * @category macros
 * @since 0.1.0
 */
export const FaultSuite = (options: Options): ReturnType<typeof Vitest> =>
  Vitest({
    ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
    tests: [options.tests ?? Input.glob("test/faults/**/*.test.ts")],
    sources: [
      options.sources ?? Input.glob("src/**/*.ts"),
      options.fixtures ?? Input.glob("test/faults/**/*", { exclude: ["test/faults/**/*.test.ts"] })
    ],
    deps: options.deps ?? [],
    config: options.config === undefined ? Input.file("vitest.faults.config.ts") : options.config,
    environment: options.environment ?? "node",
    coverage: false,
    exclusive: true,
    passWithNoTests: false,
    cwd: options.cwd
  })
