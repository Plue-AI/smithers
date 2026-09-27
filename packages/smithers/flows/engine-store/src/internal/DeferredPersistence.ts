/**
 * Durable deferred delivery and absolute clock scheduling.
 *
 * @since 0.1.0
 */

import { FlowEngine } from "@smthrs/engine"
import { type DurableClock, type DurableDeferred, type Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import type { Ownership } from "@smthrs/run-store"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FiberMap from "effect/FiberMap"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import type * as Scope from "effect/Scope"
import * as DurableEngineState from "../DurableEngineState.ts"
import * as JournalRecords from "./JournalRecords.ts"
import * as StateTransaction from "./StateTransaction.ts"

/**
 * Reasons passed to the single claim-gated resume scheduler.
 *
 * @since 0.1.0
 * @category models
 */
export type ResumeReason = "deferred" | "clock"

/**
 * Dependencies for durable deferred and clock persistence.
 *
 * `scheduleResume` must enter the run coordinator and ownership claim path. It
 * must never invoke a flow handler directly.
 *
 * @since 0.1.0
 * @category models
 */
export interface Dependencies {
  readonly owner: Ownership.OwnerId
  readonly journalSource: string
  readonly scheduleResume: (
    flowName: string,
    executionId: string,
    reason: ResumeReason,
    sourceId?: string | undefined
  ) => Effect.Effect<void>
  /**
   * Redispatch policy for a durable clock whose fire failed. Defaults to
   * {@link defaultFireRetryPolicy}; a composition supplies its own the way
   * the engine's `suspendedRetryPolicy` option is supplied, rather than
   * editing the constant.
   */
  readonly fireRetryPolicy?: FireRetryPolicy | undefined
}

/**
 * Encoded deferred completion with optional opaque correlation metadata.
 *
 * @since 0.1.0
 * @category models
 */
export interface DeferredDoneOptions {
  readonly flowName: string
  readonly executionId: string
  readonly deferredName: string
  readonly exit: Exit.Exit<unknown, unknown>
  readonly metadata?: unknown
}

/**
 * Durable deferred and clock operations composed into the encoded engine.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly deferredResult: (
    deferred: DurableDeferred.Any
  ) => Effect.Effect<
    Option.Option<Exit.Exit<unknown, unknown>>,
    never,
    FlowRuntime.FlowInstance
  >
  readonly deferredDone: (options: DeferredDoneOptions) => Effect.Effect<void>
  readonly deferredDoneIfWaiting: (
    options: DeferredDoneOptions & {
      readonly reason: string
      readonly token: string
    }
  ) => Effect.Effect<FlowRuntime.DeferredDoneIfWaitingOutcome>
  readonly scheduleClock: (
    flow: Flow.Any,
    options: {
      readonly executionId: string
      readonly clock: DurableClock.DurableClock
    }
  ) => Effect.Effect<void>
  readonly sweepDue: (flowName?: string) => Effect.Effect<void>
}

const clockKey = (row: DurableEngineState.ClockAddress): string =>
  JSON.stringify([row.flowName, row.executionId, row.clockName])

/**
 * A clock-fire redispatch policy. The input is the sandboxed cause of a failed
 * fire, so any schedule that recurs on an arbitrary input fits.
 *
 * @since 0.1.0
 * @category models
 */
export type FireRetryPolicy = Schedule.Schedule<unknown, unknown>

/**
 * The default redispatch policy for a durable clock whose fire failed.
 *
 * Temporal redispatches timer-queue tasks with backoff until they are acked
 * (`reference/temporal` `service/history` timer queue + `common/backoff`); we
 * mirror that here so one transient journal/flush error at fire time cannot
 * lose the timer until a process restart. Exponential from 100ms, capped at
 * 30s, forever — the fire is idempotent (first-writer deferred completion,
 * deduplicated journal admission, CAS clock completion), so retrying an
 * arbitrary prefix is safe.
 *
 * @since 0.1.0
 * @category constructors
 */
export const defaultFireRetryPolicy: FireRetryPolicy = Schedule.min([
  Schedule.exponential("100 millis"),
  Schedule.spaced("30 seconds")
])

/**
 * Constructs durable deferred and clock persistence.
 *
 * Delivery ordering is `durable state -> durable journal -> claim-gated
 * resume`. The delivery operation itself never invokes a flow handler.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  dependencies: Dependencies
): Effect.Effect<
  Service,
  never,
  DurableEngineState.DurableEngineState | Journal.Journal | Scope.Scope
> =>
  Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const journal = yield* Journal.Journal
    /**
     * The package's ordered state-and-journal boundary: engine state first,
     * the journal's write transaction inside it. See
     * {@link StateTransaction.make} for the order and what it guarantees.
     */
    const transactState = StateTransaction.make(state, journal)
    const timers = yield* FiberMap.make<string>()
    const fireRetryPolicy = dependencies.fireRetryPolicy ?? defaultFireRetryPolicy

    // The durable channel commits inside `emitDurable`; the flush that
    // follows only pushes the *lossy* queue. Once the journal's lossy writer
    // latches a `sink_failed` it stays latched for the process (issue #43),
    // so treating a flush failure as a defect would turn every committed
    // durable write into a permanent stall. Log and move on: durable
    // delivery must never be coupled to lossy-channel health.
    const flushLossy = journal.flush.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "engine-store: lossy journal flush failed after a committed durable write; continuing",
          cause
        )
      )
    )

    const persistDeferred = (
      options: DeferredDoneOptions,
      reason: ResumeReason = "deferred",
      expectedWaiting?: { readonly reason: string; readonly token: string } | undefined
    ): Effect.Effect<FlowRuntime.DeferredDoneIfWaitingOutcome> =>
      Effect.gen(function*() {
        const completedAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
        // The completion row and the record describing it commit as one unit:
        // a crash between them left a resumable deferred the journal never
        // announced. The lossy flush below stays outside — it waits on the
        // journal's writer fiber, which would deadlock against the write
        // transaction this holds.
        const admission = yield* transactState(
          Effect.gen(function*() {
            if (expectedWaiting !== undefined) {
              const waiting = yield* state.waiting(options.executionId)
              if (
                Option.isNone(waiting) ||
                waiting.value.reason !== expectedWaiting.reason ||
                waiting.value.token !== expectedWaiting.token
              ) {
                return { _tag: "NotWaiting" as const }
              }
            }
            const completion = yield* state.completeDeferred({
              flowName: options.flowName,
              executionId: options.executionId,
              deferredName: options.deferredName,
              exit: options.exit,
              ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
              completedAtMs
            })
            const row = completion.row

            // Durable channel: a deferred completion is a lifecycle record and
            // must never take the droppable lossy queue. It is unfenced by
            // design — external-trigger admissions are first-writer-wins
            // regardless of who owns the run (issue #10), which is exactly the
            // admission `emitDurableUnfenced` exists for.
            yield* journal.emitDurableUnfenced(
              JournalRecords.deferredCompleted({
                runId: options.executionId,
                lineageId: FlowEngine.Lineage.root(options.executionId),
                sourceId: `${dependencies.journalSource}:deferred:${
                  JSON.stringify([options.flowName, options.executionId, options.deferredName])
                }`,
                sourceSeq: 0
              }, {
                flowName: row.flowName,
                executionId: row.executionId,
                deferredName: row.deferredName,
                exit: row.exit,
                ...(row.metadata === undefined ? {} : { metadata: row.metadata })
              })
            ).pipe(Effect.orDie)
            return { _tag: "Admitted" as const, completion }
          })
        ).pipe(Effect.orDie)
        if (admission._tag === "NotWaiting") return "NotWaiting"
        const row = admission.completion.row
        yield* flushLossy
        yield* dependencies.scheduleResume(
          row.flowName,
          row.executionId,
          reason
        )
        return admission.completion._tag
      })

    const completeDeferred = (
      options: DeferredDoneOptions,
      reason: ResumeReason = "deferred"
    ): Effect.Effect<void> => persistDeferred(options, reason).pipe(Effect.asVoid)

    const fireClock = (row: DurableEngineState.ClockRow): Effect.Effect<void> =>
      Effect.gen(function*() {
        const completedAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
        yield* completeDeferred(
          {
            flowName: row.flowName,
            executionId: row.executionId,
            deferredName: row.deferredName,
            exit: Exit.void,
            metadata: {
              clockName: row.clockName,
              dueAtMs: row.dueAtMs,
              completedAtMs
            }
          },
          "clock"
        )
        yield* state.completeClock(row, completedAtMs)
      })

    const armClock = (row: DurableEngineState.ClockRow): Effect.Effect<void> =>
      // A replayed sleep re-schedules its clock and gets the existing row
      // back. A fired clock whose completion stands is not armed again: firing
      // it would re-admit that completion and wake the run, whose replay would
      // re-schedule the clock again, re-driving the parked run forever. A
      // rewind can drop the completion and keep the fired row; that clock
      // still has to fire.
      (row.completedAtMs === null
        ? Effect.succeed(false)
        : Effect.map(state.deferred(row), Option.isSome)).pipe(
          Effect.flatMap((fired) => fired ? Effect.void : armTimer(row))
        )

    const armTimer = (row: DurableEngineState.ClockRow): Effect.Effect<void> =>
      Clock.currentTimeMillis.pipe(Effect.map(Math.floor)).pipe(
        Effect.flatMap((nowMs) =>
          fireClock(row).pipe(
            // A failed fire (journal emit/flush defect included) must not kill
            // the one-shot timer fiber: expose the full cause and redispatch
            // with backoff until the fire is durably acked.
            Effect.sandbox,
            Effect.retry(fireRetryPolicy),
            Effect.orDie,
            Effect.delay(Duration.millis(Math.max(0, row.dueAtMs - nowMs))),
            FiberMap.run(timers, clockKey(row), { onlyIfMissing: true })
          )
        ),
        Effect.asVoid
      )

    /**
     * Durable channel: clock schedule records are lifecycle evidence and must
     * never be droppable (issue #10). Unfenced: registration-time sweeps
     * re-record clocks the current process does not own.
     */
    const emitClockScheduled = (
      row: DurableEngineState.ClockRow
    ): Effect.Effect<void> =>
      journal.emitDurableUnfenced(
        JournalRecords.clockScheduled({
          runId: row.executionId,
          lineageId: FlowEngine.Lineage.root(row.executionId),
          sourceId: `${dependencies.journalSource}:clock:${
            JSON.stringify([row.flowName, row.executionId, row.clockName])
          }`,
          sourceSeq: 0
        }, {
          flowName: row.flowName,
          executionId: row.executionId,
          clockName: row.clockName,
          deferredName: row.deferredName,
          dueAtMs: row.dueAtMs
        })
      ).pipe(Effect.asVoid, Effect.orDie)

    /** Re-announces an already persisted clock row (the sweep path). */
    const recordClockScheduled = (
      row: DurableEngineState.ClockRow
    ): Effect.Effect<void> => emitClockScheduled(row).pipe(Effect.andThen(flushLossy))

    const scheduleClock: Service["scheduleClock"] = Effect.fn("DeferredPersistence.scheduleClock")((
      flow,
      options
    ) =>
      Effect.gen(function*() {
        const nowMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
        // The clock row and its schedule record commit as one unit, so a
        // crash between them can no longer arm a durable timer the journal
        // never announced (or announce one that was rolled back).
        const scheduled = yield* transactState(
          Effect.gen(function*() {
            const scheduled = yield* state.scheduleClock({
              flowName: flow._tag,
              executionId: options.executionId,
              clockName: options.clock.name,
              deferredName: options.clock.deferred.name,
              dueAtMs: nowMs + Duration.toMillis(options.clock.duration),
              completedAtMs: null
            }, dependencies.owner)
            yield* emitClockScheduled(scheduled.row)
            return scheduled
          })
        ).pipe(Effect.orDie)
        yield* flushLossy
        yield* armClock(scheduled.row)
      })
    )

    const sweepDue: Service["sweepDue"] = Effect.fn("DeferredPersistence.sweepDue")((flowName) =>
      Effect.gen(function*() {
        const rows = yield* state.pendingClocks(flowName === undefined ? {} : { flowName })
        yield* Effect.forEach(
          rows,
          (row) => recordClockScheduled(row).pipe(Effect.andThen(armClock(row))),
          { discard: true }
        )
        if (flowName !== undefined) {
          const completions = yield* state.completedDeferreds(flowName)
          yield* Effect.forEach(
            completions,
            (address) =>
              dependencies.scheduleResume(
                address.flowName,
                address.executionId,
                "deferred",
                `${dependencies.journalSource}:wake:${
                  JSON.stringify([
                    address.flowName,
                    address.executionId,
                    address.deferredName
                  ])
                }`
              ),
            { discard: true }
          )
        }
      })
    )

    return {
      deferredResult: Effect.fn("DeferredPersistence.deferredResult")(function*(deferred) {
        const instance = yield* FlowRuntime.FlowInstance
        const address = {
          flowName: instance.flow._tag,
          executionId: instance.executionId,
          deferredName: deferred.name
        }
        const row = yield* state.deferred(address)
        if (Option.isSome(row)) {
          // Keep the result for replay, but stop registration from waking a
          // run that already observed it and may now be parked on another wait.
          yield* state.consumeDeferred(address, yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor)))
        }
        return Option.map(row, (value) => value.exit as Exit.Exit<unknown, unknown>)
      }),
      deferredDone: Effect.fn("DeferredPersistence.deferredDone")(completeDeferred),
      deferredDoneIfWaiting: Effect.fn("DeferredPersistence.deferredDoneIfWaiting")((options) =>
        persistDeferred(options, "deferred", {
          reason: options.reason,
          token: options.token
        })
      ),
      scheduleClock,
      sweepDue
    }
  })
