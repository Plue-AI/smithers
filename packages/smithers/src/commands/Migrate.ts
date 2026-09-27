/**
 * `smthrs migrate`: one implementation behind both parsers.
 *
 * The flow ships inside `@smthrs/migrate`, which is where a 0.x project can
 * reach it: such a project has no `flows/` directory by definition. This is
 * the same entry `smithers-migrate` runs, so the two spellings are one
 * implementation.
 *
 * @since 1.0.0
 */

import * as MigrateCommand from "@smthrs/migrate/flow/Command"
import * as Report from "@smthrs/migrate/Report"
import { Effect, Schema } from "effect"
import * as CliError from "../CliError.ts"
import * as Legacy from "../Legacy.ts"
import * as Project from "../Project.ts"
import * as Globals from "./Globals.ts"

/**
 * The typed options both parsers produce. `target` is the 0.x project, never
 * the rc.0 one: `Project.ProjectRoot` anchors its walk on `.flows/`, which a
 * 0.x project does not have.
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly target: string
  readonly scan: boolean
  readonly apply: boolean
  readonly seat?: string | undefined
  readonly allowUnsafe?: string | undefined
  readonly acknowledgeRunState: boolean
  readonly allowNoVcs: boolean
  readonly keepOldSources: boolean
  readonly unit?: string | undefined
  readonly maxRepairRounds?: number | undefined
  readonly reportDir?: string | undefined
  readonly flowsDir?: string | undefined
  readonly verifyInstall?: string | undefined
  readonly verifyFormat?: string | undefined
  readonly verifyTypecheck?: ReadonlyArray<string> | undefined
  readonly verifyTest?: string | undefined
}

/**
 * A refused gate is not a crash: it prints the operator's own instructions
 * and leaves the project untouched. Operator gates and an existing apply
 * owner exit 3, matching the standalone migration CLI.
 * @category models
 * @since 1.0.0
 */
export interface Parked {
  readonly _tag: "Parked"
  readonly code: string
  readonly message: string
  readonly root: string
  readonly details?: string | undefined
}

/**
 * The migration ran; its own status is the exit code, where 3 is "parked,
 * the operator has a decision", not a failure.
 * @category models
 * @since 1.0.0
 */
export interface Reported {
  readonly _tag: "Reported"
  readonly report: Report.MigrationReport
  readonly reportDirectory: string
}

/**
 * The parked codes, so both entries agree which failures are decisions.
 * @category models
 * @since 1.0.0
 */
export const parkedCodes: ReadonlySet<string> = new Set(["run-state-blocked", "unsafe-blocked", "apply-in-progress"])

/**
 * Runs the migration and returns its outcome without rendering it.
 * @category constructors
 * @since 1.0.0
 */
export const run = (
  options: Options,
  globals: Globals.Options
): Effect.Effect<Parked | Reported, CliError.UnsupportedError> =>
  Effect.gen(function*() {
    yield* Globals.guard(globals)
    const environment = globals.environment ?? process.env
    const target = options.target
    // `legacyDatabases`, not `legacyState`: the 0.x-project guard is not
    // gated on `.flows/` being absent, and the project being migrated has
    // one by definition.
    const databases = Project.legacyDatabases(target).map(Legacy.read)
    const refusal = Legacy.refusal(databases)
    if (refusal !== undefined) return yield* Effect.fail(new CliError.UnsupportedError({ message: refusal }))
    const migrateOptions = MigrateCommand.optionsOf(
      {
        root: target,
        scan: options.scan,
        apply: options.apply,
        seat: options.seat,
        allowUnsafe: options.allowUnsafe,
        acknowledgeRunState: options.acknowledgeRunState,
        allowNoVcs: options.allowNoVcs,
        keepOldSources: options.keepOldSources,
        unit: options.unit,
        maxRepairRounds: options.maxRepairRounds,
        reportDir: options.reportDir,
        flowsDir: options.flowsDir,
        verifyInstall: options.verifyInstall,
        verifyFormat: options.verifyFormat,
        verifyTypecheck: options.verifyTypecheck ?? [],
        verifyTest: options.verifyTest
      },
      target,
      environment
    )
    const outcome = yield* Effect.result(MigrateCommand.runNode(migrateOptions, { environment }))
    if (outcome._tag === "Failure") {
      const error = outcome.failure
      if (parkedCodes.has(error.code)) {
        return {
          _tag: "Parked" as const,
          code: error.code,
          message: error.message,
          root: target,
          ...(error.details === undefined ? {} : { details: error.details })
        }
      }
      return yield* Effect.fail(
        new CliError.UnsupportedError({
          message: `smthrs migrate: ${error.message}${error.details === undefined ? "" : `\n${error.details}`}`
        })
      )
    }
    return {
      _tag: "Reported" as const,
      report: outcome.success,
      reportDirectory: MigrateCommand.reportDirectory(migrateOptions)
    }
  })

/**
 * The report as the JSON document `smithers-migrate --json` prints, so a
 * script reads one shape from either entry.
 * @category constructors
 * @since 1.0.0
 */
export const document = (report: Report.MigrationReport): unknown =>
  Schema.encodeUnknownSync(Report.MigrationReport)(report)
