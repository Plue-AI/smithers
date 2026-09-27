/**
 * The `@smthrs/control` `DispatchReader` port served from a `TriggerStore`.
 *
 * `Control.list` answers `{ _tag: "triggers" }` and `{ _tag: "fires" }` through
 * the port declared in `@smthrs/control/DispatchReader`. The port lives there
 * because this package depends on control (the scheduler launches runs through
 * it); the adapter lives here because only this package can read the store.
 * The host composes the two: {@link layer} over the same store the scheduler
 * writes.
 *
 * @see packages/smithers/agent/triggers/docs/api.md
 *
 * @since 1.0.0-rc.0
 */

import type { ControlError } from "@smthrs/control/ControlError"
import { PersistenceError } from "@smthrs/control/ControlError"
import { defaultPageSize, type FireSummary, type TriggerSummary } from "@smthrs/control/ControlSchema"
import * as Port from "@smthrs/control/DispatchReader"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Cron from "./Cron.ts"
import type { TriggerError } from "./TriggerError.ts"
import { type FireRecord, type Held, isReservation, type Registered, TriggerStore } from "./TriggerStore.ts"

/**
 * How many upcoming occurrences a trigger summary carries.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const nextOccurrenceCount = 5

/**
 * How many ledger rows one `fires` page needs: every row before the page's
 * offset cursor, the page, and one more so `Control.list` can tell a next page
 * exists. A cursor Control will refuse reads nothing extra: it answers
 * `undefined`, and the refusal comes from Control.
 */
const firesNeeded = (request: Port.FiresRequest): number | undefined => {
  const start = request.cursor === undefined ? 0 : Number(request.cursor)
  const size = request.limit ?? defaultPageSize
  return Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(size) && size >= 1
    ? start + size + 1
    : undefined
}

const persistence = (operation: string) => (error: TriggerError): ControlError =>
  new PersistenceError({ operation, message: error.message, cause: error })

/**
 * The next {@link nextOccurrenceCount} occurrences strictly after `now`, as
 * epoch milliseconds in ascending order.
 *
 * @category getters
 * @since 1.0.0-rc.0
 */
export const nextOccurrences = (
  trigger: Pick<Registered, "cron" | "timezone">,
  now: number
): Effect.Effect<ReadonlyArray<number>, TriggerError> =>
  Effect.gen(function*() {
    const cron = yield* Cron.parse(trigger.cron, trigger.timezone)
    const occurrences: Array<number> = []
    let from = new Date(now)
    while (occurrences.length < nextOccurrenceCount) {
      from = yield* Cron.next(cron, from)
      occurrences.push(from.getTime())
    }
    return occurrences
  })

/**
 * Maps one stored trigger and what it holds to the control plane's summary.
 *
 * A launch reservation is not a run the runtime knows about, so it is
 * reported as no active run; the ledger still shows the claimed occurrence.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const toTriggerSummary = (
  trigger: Registered,
  held: Held,
  nextOccurrencesMs: ReadonlyArray<number>,
  schedulerLastTickMs: Option.Option<number>
): TriggerSummary => ({
  triggerId: trigger.id,
  flowId: trigger.flowId,
  input: trigger.input,
  cron: trigger.cron,
  ...(trigger.timezone === undefined ? {} : { timezone: trigger.timezone }),
  overlap: trigger.overlap,
  catchUp: trigger.catchUp,
  maxCatchUp: trigger.maxCatchUp,
  enabled: trigger.enabled,
  revision: trigger.revision,
  ...(trigger.lastFiredAt === undefined ? {} : { lastFiredAtMs: trigger.lastFiredAt }),
  ...(held.pendingAt === undefined ? {} : { pendingAtMs: held.pendingAt }),
  ...(held.activeRunId === undefined || isReservation(held.activeRunId) ? {} : { activeRunId: held.activeRunId }),
  nextOccurrencesMs,
  ...(Option.isSome(schedulerLastTickMs) ? { schedulerLastTickMs: schedulerLastTickMs.value } : {})
})

/**
 * Maps one ledger row to the control plane's fire summary.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const toFireSummary = (record: FireRecord): FireSummary => ({
  triggerId: record.triggerId,
  occurrenceAtMs: record.occurrence,
  outcome: record.outcome,
  ...(record.runId === undefined ? {} : { runId: record.runId }),
  ...(record.error === undefined ? {} : { error: record.error })
})

/**
 * Builds the port over the ambient {@link TriggerStore}.
 *
 * `list` answers every trigger the store holds, taking each row's held state
 * from the listing itself; `fires` pushes the request's filters into the
 * ledger query and answers the matching rows newest first, reading only as
 * many as the requested page needs.
 * `Control.list` applies the filters again and pages. A store failure is a
 * `PersistenceError` naming the listing that failed.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const make: Effect.Effect<Port.Service, never, TriggerStore> = Effect.gen(function*() {
  const store = yield* TriggerStore
  return Port.make({
    list: Effect.fn("DispatchReader.list")(() =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const heartbeat = yield* store.lastHeartbeat()
        const lastTick = Option.map(heartbeat, (beat) => beat.tickedAt)
        const listing = yield* store.list()
        return yield* Effect.forEach(listing, (row) =>
          Effect.gen(function*() {
            // A row the store could not decode fails the listing rather than
            // being reported as a trigger with invented fields; the failure
            // names the row. The listing already carries what `inspect` reads,
            // so a summary costs no second read per trigger.
            if (Result.isFailure(row.trigger)) return yield* Effect.fail(row.trigger.failure)
            const trigger = row.trigger.success
            const upcoming = yield* nextOccurrences(trigger, now)
            return toTriggerSummary(trigger, row, upcoming, lastTick)
          }))
      }).pipe(Effect.mapError(persistence("triggers")))
    ),
    fires: Effect.fn("DispatchReader.fires")((request) =>
      store.history({
        triggerId: request.filters?.triggerId,
        runId: request.filters?.runId,
        outcome: request.filters?.outcome,
        limit: firesNeeded(request)
      }).pipe(
        Effect.map((page) => page.items.map(toFireSummary)),
        Effect.mapError(persistence("fires"))
      )
    )
  })
})

/**
 * Provides the control plane's `DispatchReader` from the ambient
 * {@link TriggerStore}, so `Control.list` answers `triggers` and `fires` from
 * the store the scheduler writes.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer: Layer.Layer<Port.DispatchReader, never, TriggerStore> = Layer.effect(Port.DispatchReader)(make)
