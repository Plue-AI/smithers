/**
 * The two gates that stand between a scan and an edit.
 *
 * Neither gate is a judgement about the code. Both are decisions only a person
 * can make, and the tool refuses to make them silently:
 *
 * - **Run state.** A project that still holds 0.x run state cannot be
 *   migrated, because the 1.0 runtime can neither read nor resume it. That is
 *   true whether the runs are live, parked, or all finished, so `blocked` and
 *   `history-only` both refuse. `--acknowledge-run-state` is the operator
 *   saying what happens to it; the tool still never writes under any recorded
 *   path.
 * - **Unsafe constructs.** A construct with no counterpart has no honest
 *   automatic translation. `--allow-unsafe <construct,…>` is the operator
 *   accepting a `TODO(migrate-smithers-v1)` marker and a report entry in place
 *   of one.
 *
 * Both refusals exit 3 rather than 1: the project is intact, and there is a
 * decision to make rather than a failure to fix.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import * as Sort from "../internal/Sort.ts"
import { make, type MigrateError } from "../MigrateError.ts"
import type * as Report from "../Report.ts"
import type * as Scan from "../Scan.ts"

/**
 * What the operator allowed on this run.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
  readonly mode: Report.Mode
  readonly acknowledgeRunState?: boolean | undefined
  /** `"all"` waives every construct; an array waives only the names it lists. */
  readonly allowUnsafe?: "all" | ReadonlyArray<string> | undefined
}

/**
 * The unsafe constructs a scan found, deduplicated and sorted.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const unsafeConstructs = (scan: Scan.ScanResult): ReadonlyArray<string> =>
  [...new Set(scan.units.flatMap((unit) => unit.unsafe))].sort(Sort.byText)

/**
 * The unsafe constructs the operator has not waived.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const unwaived = (
  scan: Scan.ScanResult,
  allowUnsafe: Options["allowUnsafe"]
): ReadonlyArray<string> => {
  if (allowUnsafe === "all") return []
  const allowed = new Set(allowUnsafe ?? [])
  return unsafeConstructs(scan).filter((construct) => !allowed.has(construct))
}

/**
 * Whether the project's run state stands in the way.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const runStateBlocks = (
  scan: Scan.ScanResult,
  acknowledgeRunState: boolean | undefined
): boolean =>
  acknowledgeRunState !== true &&
  (scan.runState.verdict === "blocked" || scan.runState.verdict === "history-only")

/**
 * The operator instructions the run-state scan produced, in the order the
 * report renders them.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const instructions = (scan: Scan.ScanResult): ReadonlyArray<string> => scan.runState.instructions

/**
 * The refusal a scan that left part of the project unread earns, or
 * `undefined` when it read everything.
 *
 * A plan built over a directory the scanner could not list or a file it would
 * not read may be missing a workflow, a manifest, or a run-state path, and a
 * migration of an incomplete plan is a migration of the wrong project. The
 * fix is the operator's: make the path readable, or point the tool at a
 * smaller root.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const incompleteScan = (
  warnings: ReadonlyArray<{ readonly code: string; readonly file: string; readonly message: string }>
): MigrateError | undefined => {
  const skipped = warnings.filter((warning) => warning.code === "incomplete-scan")
  if (skipped.length === 0) return undefined
  return make(
    "unsupported-project",
    `The scan did not read the whole project, so the plan may be incomplete: ${skipped.length} path${
      skipped.length === 1 ? " was" : "s were"
    } skipped. Make ${skipped.length === 1 ? "it" : "them"} readable or move ${
      skipped.length === 1 ? "it" : "them"
    } out of the project, then rerun.`,
    skipped.map((warning) => warning.message).join("\n")
  )
}

// The two refusals an operator reads, built once. `evaluate` and
// `evaluateReport` reach the same two gates from a `ScanResult` and from the
// report derived from it, and the prose is the thing an operator acts on, so a
// sentence fixed in one spelling and not the other would be a silent
// divergence neither suite could see.
const runStateRefusal = (verdict: string, instructions: ReadonlyArray<string>): MigrateError =>
  make(
    "run-state-blocked",
    `This project still holds Smithers 0.x run state (${verdict}). Finish, archive, or discard it, then rerun with --acknowledge-run-state.`,
    instructions.join("\n")
  )

const unsafeRefusal = (blocked: ReadonlyArray<string>): MigrateError =>
  make(
    "unsafe-blocked",
    `${blocked.length} construct${blocked.length === 1 ? " has" : "s have"} no safe translation: ${
      blocked.join(", ")
    }. Rerun with --allow-unsafe ${
      blocked.join(",")
    } to accept a TODO marker and a report entry for each, or --allow-unsafe all.`,
    blocked.join("\n")
  )

/**
 * Decides whether this run may edit the project.
 *
 * `scan` and `plan` always pass: neither writes a project file, so neither
 * gate applies to them. Only `apply` is gated.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const evaluate = (
  scan: Scan.ScanResult,
  options: Options
): Effect.Effect<void, MigrateError> => {
  if (options.mode !== "apply") return Effect.void
  const incomplete = incompleteScan(scan.detection.warnings)
  if (incomplete !== undefined) return Effect.fail(incomplete)
  if (runStateBlocks(scan, options.acknowledgeRunState)) {
    return Effect.fail(runStateRefusal(scan.runState.verdict, instructions(scan)))
  }
  const blocked = unwaived(scan, options.allowUnsafe)
  if (blocked.length > 0) return Effect.fail(unsafeRefusal(blocked))
  return Effect.void
}

/**
 * The unsafe constructs a finished report names, deduplicated and sorted.
 *
 * The flow gates on the report rather than on the scan value, because the
 * report is what crosses the journal: a durable run that resumes reads the
 * report its own scan step recorded, not a `ScanResult` nobody serialized.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const unsafeInReport = (report: Report.MigrationReport): ReadonlyArray<string> =>
  [...new Set(report.units.flatMap((unit) => unit.unsupported.map((entry) => entry.construct)))].sort(Sort.byText)

/**
 * The unsafe constructs in a report the operator has not waived.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const unwaivedInReport = (
  report: Report.MigrationReport,
  allowUnsafe: Options["allowUnsafe"]
): ReadonlyArray<string> => {
  if (allowUnsafe === "all") return []
  const allowed = new Set(allowUnsafe ?? [])
  return unsafeInReport(report).filter((construct) => !allowed.has(construct))
}

/**
 * Decides whether this run may edit the project, reading the scan's own
 * report.
 *
 * Same two gates as {@link evaluate}, same two codes, same exit 3.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const evaluateReport = (
  report: Report.MigrationReport,
  options: Options
): Effect.Effect<void, MigrateError> => {
  if (options.mode !== "apply") return Effect.void
  const incomplete = incompleteScan(report.project.warnings)
  if (incomplete !== undefined) return Effect.fail(incomplete)
  if (
    options.acknowledgeRunState !== true &&
    (report.runState.verdict === "blocked" || report.runState.verdict === "history-only")
  ) {
    return Effect.fail(runStateRefusal(report.runState.verdict, report.runState.instructions))
  }
  const blocked = unwaivedInReport(report, options.allowUnsafe)
  if (blocked.length > 0) return Effect.fail(unsafeRefusal(blocked))
  return Effect.void
}
