/**
 * `smthrs gc`: the sweep, after the shared guard.
 *
 * The report is returned either way, so a `--json` caller still sees what the
 * readable databases held; `Gc.failureMessage` is what tells a script the
 * sweep was partial, and each entry decides the status from it.
 *
 * @since 1.0.0
 */

import { Effect } from "effect"
import type * as CliError from "../CliError.ts"
import * as Gc from "../Gc.ts"
import * as Project from "../Project.ts"
import * as Globals from "./Globals.ts"

/**
 * The typed options both parsers produce.
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly olderThan: string
  readonly dryRun: boolean
}

/**
 * Sweeps the project root in scope.
 * @category constructors
 * @since 1.0.0
 */
export const sweep = (
  options: Options,
  globals: Globals.Options
): Effect.Effect<
  Gc.Sweep,
  CliError.UsageError | CliError.UnsupportedError
> =>
  Effect.gen(function*() {
    yield* Globals.guard(globals)
    const projectRoot = yield* Project.ProjectRoot
    return yield* Gc.sweep(projectRoot, { olderThan: options.olderThan, dryRun: options.dryRun })
  })
