/**
 * Which occurrences one scheduler tick owes a trigger.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import * as CatchUp from "../CatchUp.ts"
import * as Cron from "../Cron.ts"
import type { TriggerError } from "../TriggerError.ts"
import type { Registered } from "../TriggerStore.ts"

/**
 * The occurrences to claim, oldest first, and the watermark that stands once
 * every one of them has been dispatched.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export interface Due {
  readonly occurrences: ReadonlyArray<number>
  readonly watermark: number
}

// A bound the declaration cannot honour is a statement about how much history
// to replay, not a reason to stop scheduling: the backlog beyond the bound is
// abandoned, loudly, and the current occurrence still fires.
const withinBound = (
  triggerId: string,
  owed: Effect.Effect<ReadonlyArray<Date>, TriggerError>
): Effect.Effect<ReadonlyArray<Date>, TriggerError> =>
  Effect.catch(owed, (error) =>
    error.code === "catch_up_bound_exceeded"
      ? Effect.as(
        Effect.annotateLogs(
          Effect.logWarning("A trigger abandoned catch-up work beyond its bound", error),
          { triggerId }
        ),
        [] as ReadonlyArray<Date>
      )
      : Effect.fail(error))

/**
 * Computes what a trigger owes at `now`, given the watermark this process has
 * already dispatched through, or `undefined` on first sight of the trigger.
 *
 * The answer depends on nothing but its arguments. The watermark is the
 * caller's to keep: it only moves forward, and only past occurrences the
 * caller finished dispatching.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const compute = (
  trigger: Registered,
  now: number,
  observed: number | undefined
): Effect.Effect<Due, TriggerError> =>
  Effect.gen(function*() {
    const cron = yield* Cron.parse(trigger.cron, trigger.timezone)
    const current = (yield* Cron.previousAtOrBefore(cron, new Date(now))).getTime()
    if (observed === undefined) {
      // First sight of this trigger in this process. A trigger that has never
      // fired starts from here rather than from whatever occurrence last
      // passed: registering a weekly trigger on a Sunday evening owes nothing
      // for the Monday six days gone, which is what `catchUp` says.
      if (trigger.lastFiredAt === undefined) return { occurrences: [], watermark: current }
      if (current <= trigger.lastFiredAt) return { occurrences: [], watermark: current }
      const owed = yield* withinBound(
        trigger.id,
        CatchUp.occurrences(
          trigger.catchUp,
          trigger.maxCatchUp,
          new Date(trigger.lastFiredAt),
          new Date(now),
          cron
        )
      )
      // The current boundary is owed whatever the policy says about the
      // backlog, exactly as on every later poll. Under `none`, or once the
      // bound abandoned the backlog, a restart used to skip it.
      const occurrences = owed.map((occurrence) => occurrence.getTime())
      if (occurrences.at(-1) !== current) occurrences.push(current)
      return { occurrences, watermark: current }
    }
    if (current <= observed) return { occurrences: [], watermark: observed }
    const backlog = yield* withinBound(
      trigger.id,
      CatchUp.occurrences(
        trigger.catchUp,
        trigger.maxCatchUp,
        new Date(observed),
        new Date(current - 1),
        cron
      )
    )
    return {
      occurrences: [...backlog.map((occurrence) => occurrence.getTime()), current],
      watermark: current
    }
  })
