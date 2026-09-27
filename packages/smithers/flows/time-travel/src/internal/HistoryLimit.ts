/**
 * The bound every history read honours.
 *
 * A replay folds the prefix below a frame, a fork assesses the suffix above
 * one, and a rewind assesses that suffix while it holds the run. Each used to
 * read to the end of whatever history the journal held, so a long or hostile
 * run decided how much memory a verb took and how long a rewind owned the run.
 * `maxHistoryEntries` caps the entries any one operation reads, and an
 * operation that would cross the cap stops with `limit_exceeded` before it
 * materializes anything past it. The anchor refresh a fork or rewind runs
 * first is under the same cap: it resumes from the run's anchored high-water
 * mark and stops at the frame, so it reads only the entries between the two.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import { error, type TimeTravelError } from "../TimeTravelError.ts"

/**
 * The cap applied when neither the service nor the call names one.
 *
 * One hundred thousand entries is far past any run this engine has recorded
 * and small enough that a page of them fits comfortably in memory; a
 * composition that records longer runs raises it on `TimeTravel.Options`.
 *
 * @since 0.1.0
 * @category constants
 */
export const defaultMaxHistoryEntries = 100_000

/**
 * Resolves a caller-supplied cap against a fallback, refusing a value that is
 * not a positive safe integer with `invalid` before anything durable happens.
 *
 * @since 0.1.0
 * @category validators
 */
export const resolve = (
  value: number | undefined,
  fallback: number
): Effect.Effect<number, TimeTravelError> => {
  if (value === undefined) return Effect.succeed(fallback)
  if (!Number.isSafeInteger(value) || value < 1) {
    return Effect.fail(
      error("invalid", `maxHistoryEntries must be a positive integer, not ${String(value)}`)
    )
  }
  return Effect.succeed(value)
}

/**
 * The refusal an operation raises once its read would pass the cap.
 *
 * @since 0.1.0
 * @category constructors
 */
export const exceeded = (operation: string, runId: string, limit: number): TimeTravelError =>
  error(
    "limit_exceeded",
    `${operation} of ${runId} would read more than ${limit} journal entries; raise maxHistoryEntries to allow it`
  )
