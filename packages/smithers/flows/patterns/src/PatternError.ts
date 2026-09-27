/**
 * Stable failures shared by higher-order flow patterns.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * Stable pattern failure codes.
 *
 * `invalid_decorator` names a fault in the declaration: a decorator broke a
 * schema or authority contract, or an option was out of range. `invalid_input`
 * names a fault in the data a pattern read while running: a flow input, a
 * plan a boss returned, a score an evaluator returned, or a settlement
 * envelope. A caller retries or escalates on the second and never on the
 * first. `stalled` names a round loop whose stall policy said `escalate`.
 *
 * @category models
 * @since 0.1.0
 */
export const PatternErrorCode = Schema.Literals([
  "missing_slot",
  "recursion_bound",
  "envelope_conflict",
  "invalid_decorator",
  "invalid_input",
  "exhausted",
  "stalled",
  "finalizer_failed",
  "quarantined",
  "compensation_failed"
])

/**
 * Stable pattern failure code.
 *
 * @category models
 * @since 0.1.0
 */
export type PatternErrorCode = typeof PatternErrorCode.Type

/**
 * A typed pattern declaration or execution failure.
 *
 * `cause` carries the error or errors this failure reports on. It never carries
 * the input that produced them.
 *
 * @category errors
 * @since 0.1.0
 */
export class PatternError extends Schema.TaggedError<PatternError>()("flows/patterns/PatternError", {
  code: PatternErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}
