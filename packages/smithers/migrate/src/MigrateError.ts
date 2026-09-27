/**
 * The single failure type of `@smthrs/migrate`.
 *
 * Every scanner, check, and migration step fails with this error so the CLI
 * maps a code onto an exit status without inspecting a cause chain.
 *
 * @since 1.0.0-rc.0
 */

import * as Schema from "effect/Schema"

/**
 * The closed set of migration failure codes.
 *
 * `run-state-blocked` and `unsafe-blocked` are the two operator gates.
 * `apply-in-progress` refuses a second apply over a project whose first one
 * is still running. All three exit 3 ("parked") rather than 1: the project is
 * intact and the operator has a decision to make.
 *
 * `invalid-layout` refuses a root, report directory, or flows directory that
 * could escape or overlap the project. `stale-plan` refuses an apply whose
 * plan no longer describes the tree it is about to edit. Both leave the
 * project untouched and exit 1.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const MigrateErrorCode = Schema.Literals([
  "run-state-blocked",
  "unsafe-blocked",
  "apply-in-progress",
  "no-vcs",
  "checkpoint-failed",
  "verify-failed",
  "agent-failed",
  "io",
  "unsupported-project",
  "invalid-layout",
  "stale-plan"
])

/**
 * A migration failure code.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type MigrateErrorCode = typeof MigrateErrorCode.Type

/**
 * A migration failure carrying a code, a human message, and optional
 * JSON-encodable details.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class MigrateError extends Schema.TaggedError<MigrateError>()("@smthrs/migrate/MigrateError", {
  code: MigrateErrorCode,
  message: Schema.String,
  details: Schema.optional(Schema.String)
}) {}

/**
 * Builds a {@link MigrateError} without naming the fields.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const make = (code: MigrateErrorCode, message: string, details?: string): MigrateError =>
  details === undefined ? new MigrateError({ code, message }) : new MigrateError({ code, message, details })

/**
 * Wraps an unknown cause as an `io` failure. Used at every filesystem seam so
 * a missing file never escapes as an untyped defect.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const io = (message: string) => (cause: unknown): MigrateError => make("io", message, String(cause))
