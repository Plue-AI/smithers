/**
 * The Bun runtime-compatibility suite a package declares for itself.
 *
 * @since 0.1.0
 */

import * as Input from "./Input.ts"
import * as Runtime from "./Runtime.ts"
import type * as Target from "./Target.ts"
import { Vitest } from "./Vitest.ts"

/**
 * Options accepted by {@link BunSuite}.
 *
 * `cwd` is the workspace-relative directory containing the package to test.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** The workspace-relative package directory the run starts in. */
  readonly cwd: string
  /** @default [] */
  readonly deps?: ReadonlyArray<Target.AnyTarget> | undefined
  /** The source tree the run keys on. Defaults to the package `src` tree. */
  readonly sources?: Input.Glob | undefined
  /** The suite the run keys on. Defaults to the package `test` tree. */
  readonly tests?: Input.Glob | undefined
  /**
   * The vitest config the run names. It defaults to the package's own
   * `vitest.config.ts`, which is the file vitest would discover from `cwd`
   * anyway; `null` leaves the discovery implicit.
   */
  readonly config?: Input.File | null | undefined
  /** @default ">=1.4.0" */
  readonly version?: ">=1.4.0" | undefined
  /** @default "node" */
  readonly environment?: string | undefined
}

/**
 * Re-runs one package's vitest suite under Bun.
 *
 * The emitted target is an ordinary {@link Vitest} target with the Bun
 * interpreter named on it, so a package carries its Bun claim next to the
 * Node one instead of in a central list. The conventional key is `bunTest`,
 * which makes `//packages/...:bunTest` the whole matrix.
 *
 * Coverage is off on every suite this macro emits: `@vitest/coverage-v8`
 * needs V8's inspector and Bun runs JavaScriptCore, so a coverage-enabled
 * config cannot attach there. The Node `test` target beside it stays the
 * coverage gate.
 *
 * Check that the suite and its native dependencies support Bun before adding
 * this target. Use the ordinary Node test target for Node-specific behavior.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const bunTest = Smithers.BunSuite({ cwd: "packages/core" })
 * ```
 *
 * @category macros
 * @since 0.1.0
 */
export const BunSuite = (options: Options): ReturnType<typeof Vitest> =>
  Vitest({
    runtime: Runtime.Bun({ version: options.version ?? ">=1.4.0" }),
    tests: [options.tests ?? Input.glob("test/**/*.test.ts")],
    sources: [options.sources ?? Input.glob("src/**/*.ts")],
    deps: options.deps ?? [],
    config: options.config === undefined ? Input.file("vitest.config.ts") : options.config,
    environment: options.environment ?? "node",
    coverage: false,
    passWithNoTests: false,
    cwd: options.cwd
  })
