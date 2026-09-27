/**
 * Pure catch-up policy decisions.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import type { Cron } from "./Cron.ts"
import * as CronSchedule from "./Cron.ts"
import type { CatchUp as Policy } from "./Schedule.ts"
import { TriggerError } from "./TriggerError.ts"

/**
 * The occurrences a trigger owes since it last fired, bounded by
 * `maxCatchUp` and by the policy named in `Schedule.CatchUp`: `none` owes
 * nothing, `one` owes only the most recent, and `all` owes every missed tick.
 *
 * Every policy answers to `maxCatchUp`, `one` included: a bound of zero says
 * no occurrence may be caught up, so a missed occurrence under `one` is
 * `catch_up_bound_exceeded` exactly as three missed occurrences under `all`
 * are. The bound is validated before any policy branch, so an unusable bound
 * is refused even where the policy owes nothing.
 *
 * @category computation
 * @since 0.1.0
 */
export const occurrences = (
  policy: Policy,
  maxCatchUp: number,
  lastFiredAt: Date | undefined,
  now: Date,
  cron: Cron
): Effect.Effect<ReadonlyArray<Date>, TriggerError> => {
  if (!Number.isSafeInteger(maxCatchUp) || maxCatchUp < 0) {
    return Effect.fail(
      new TriggerError({
        code: "catch_up_bound_exceeded",
        message: `maxCatchUp must be a non-negative safe integer, received ${maxCatchUp}`,
        path: "maxCatchUp"
      })
    )
  }
  if (lastFiredAt === undefined) return Effect.succeed([])
  if (policy === "none") return Effect.succeed([])
  if (policy === "one") {
    return CronSchedule.previousAtOrBefore(cron, now).pipe(
      Effect.flatMap((latest) =>
        latest.getTime() <= lastFiredAt.getTime()
          ? Effect.succeed<ReadonlyArray<Date>>([])
          : maxCatchUp < 1
          ? Effect.fail(
            new TriggerError({
              code: "catch_up_bound_exceeded",
              message: `missed 1 occurrence; maxCatchUp is ${maxCatchUp}`
            })
          )
          : Effect.succeed<ReadonlyArray<Date>>([latest])
      )
    )
  }
  return CronSchedule.occurrencesBetween(cron, lastFiredAt, now, maxCatchUp + 1).pipe(
    Effect.flatMap((missed) =>
      missed.length > maxCatchUp
        ? Effect.fail(
          new TriggerError({
            code: "catch_up_bound_exceeded",
            message: `missed ${missed.length} occurrences; maxCatchUp is ${maxCatchUp}`
          })
        )
        : Effect.succeed(missed)
    )
  )
}
