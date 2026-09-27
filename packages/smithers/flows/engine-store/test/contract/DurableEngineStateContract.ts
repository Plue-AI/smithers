/**
 * Shared behavioural contract for every `DurableEngineState` implementation.
 *
 * Modeled on `packages/smithers/flows/kernel/src/test/HostContract.ts`: one suite, run
 * against both the SQL and the in-memory implementations, so the two can
 * never diverge silently (issue #23 — memory `park` used to drop the owner
 * fence the SQL layer enforces).
 */
import { describe, expect, it } from "@effect/vitest"
import type { Ownership } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import { expectTypeOf } from "vitest"
import type * as DurableEngineState from "../../src/DurableEngineState.ts"

export interface HarnessContext {
  readonly state: DurableEngineState.Service
  /** A fresh service instance over the same underlying storage (restart). */
  readonly restart: Effect.Effect<DurableEngineState.Service>
  /** Seeds a run row the implementation's ownership fences read. */
  readonly seedRun: (
    runId: string,
    owner: Ownership.OwnerId | null,
    status?: "pending" | "running" | "suspended" | "completed" | "failed" | "cancelled",
    heartbeatAtMs?: number | null
  ) => Effect.Effect<void>
  /** Durably records a cancel request for an already-seeded run. */
  readonly setCancelRequested: (
    runId: string,
    requestedAtMs: number
  ) => Effect.Effect<void>
  /** Moves an already-seeded run to a new status (ownership released). */
  readonly setStatus: (
    runId: string,
    status: "pending" | "running" | "suspended" | "completed" | "failed" | "cancelled"
  ) => Effect.Effect<void>
  /** Removes an already-seeded run while leaving its engine-state rows intact. */
  readonly deleteRun: (runId: string) => Effect.Effect<void>
}

export interface Harness {
  readonly label: string
  readonly run: <A>(body: (context: HarnessContext) => Effect.Effect<A, any, never>) => Effect.Effect<A>
}

const owner: Ownership.OwnerId = { hostId: "contract", pid: 1, nonce: "owner" }
const otherOwner: Ownership.OwnerId = { hostId: "contract", pid: 2, nonce: "other" }

/** Observes a fence loss (self-interruption) as an Exit on a child fiber. */
const awaitExit = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Exit.Exit<A, E>, never, R> =>
  effect.pipe(Effect.forkChild({ startImmediately: true }), Effect.flatMap(Fiber.await))

export const describeContract = (harness: Harness): void => {
  describe(`DurableEngineState contract (${harness.label})`, () => {
    it.effect("round-trips a park through waiting and wake, surviving a restart", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun("parked", owner)
            const parked = yield* context.state.park(
              "parked",
              { reason: "approval", wakeAt: 1_000, token: "tok" },
              owner
            )
            const restarted = yield* context.restart
            const waiting = yield* restarted.waiting("parked")
            const woken = yield* restarted.wake("parked")
            const afterWake = yield* restarted.waiting("parked")
            return { parked, waiting, woken, afterWake }
          })
        )

        const row = { runId: "parked", reason: "approval", wakeAt: 1_000, token: "tok" }
        expect(result.parked).toEqual({ _tag: "Parked", row })
        expect(Option.getOrThrow(result.waiting)).toEqual(row)
        expect(result.woken).toEqual({ _tag: "Woken", row })
        expect(Option.isNone(result.afterWake)).toBe(true)
      }))

    it.effect("rejects a park from a non-owning process with NotFound", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun("fenced", owner)
            const attempt = yield* context.state.park("fenced", { reason: "approval" }, otherOwner)
            const waiting = yield* context.state.waiting("fenced")
            return { attempt, waiting }
          })
        )

        expect(result.attempt).toEqual({ _tag: "NotFound" })
        expect(Option.isNone(result.waiting)).toBe(true)
      }))

    it.effect("rejects a park for a run that does not exist", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((context) => context.state.park("missing", { reason: "event" }, owner))
        expect(result).toEqual({ _tag: "NotFound" })
      }))

    it.effect("rejects a park for an unowned run", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun("unowned", null, "pending")
            return yield* context.state.park("unowned", { reason: "quota" }, owner)
          })
        )
        expect(result).toEqual({ _tag: "NotFound" })
      }))

    it.effect("reports NotFound when waking an unknown run and NotWaiting for an unparked run", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun("unparked", owner)
            return {
              unknown: yield* context.state.wake("unknown-run"),
              unparked: yield* context.state.wake("unparked")
            }
          })
        )

        expect(result.unknown).toEqual({ _tag: "NotFound" })
        expect(result.unparked).toEqual({ _tag: "NotWaiting" })
      }))

    it.effect("overwrites the waiting payload when a parked run parks again", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun("re-parked", owner)
            yield* context.state.park("re-parked", { reason: "quota", wakeAt: 500 }, owner)
            yield* context.state.park("re-parked", { reason: "event", token: "second" }, owner)
            return Option.getOrThrow(yield* context.state.waiting("re-parked"))
          })
        )

        expect(result).toEqual({ runId: "re-parked", reason: "event", wakeAt: null, token: "second" })
      }))

    it.effect("records run-parent edges durably with a total seq order (issues #40/#41)", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            const first = yield* context.state.recordRunParent("edge-child", "edge-parent-a")
            const duplicate = yield* context.state.recordRunParent("edge-child", "edge-parent-a")
            const second = yield* context.state.recordRunParent("edge-child", "edge-parent-b")
            // Edges survive a restart: they are what a fresh owner's cycle
            // detector walks.
            const restarted = yield* context.restart
            const parents = yield* restarted.runParents("edge-child")
            yield* restarted.removeRunParentsForRun("edge-parent-a")
            const afterRemove = yield* restarted.runParents("edge-child")
            const none = yield* restarted.runParents("edge-none")
            return { first, duplicate, second, parents, afterRemove, none }
          })
        )

        expect(result.first._tag).toBe("Recorded")
        expect(result.duplicate).toEqual({ _tag: "Existing", edge: result.first.edge })
        expect(result.second._tag).toBe("Recorded")
        expect(result.second.edge.seq).toBeGreaterThan(result.first.edge.seq)
        expect(result.parents).toEqual([result.first.edge, result.second.edge])
        expect(result.afterRemove).toEqual([result.second.edge])
        expect(result.none).toEqual([])
      }))

    it.effect("filters and orders waitingRuns for sweeper consumption", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            for (const runId of ["due-quota", "future-quota", "due-approval", "no-wake"]) {
              yield* context.seedRun(runId, owner)
            }
            yield* context.state.park("due-quota", { reason: "quota", wakeAt: 500 }, owner)
            yield* context.state.park("future-quota", { reason: "quota", wakeAt: 5_000 }, owner)
            yield* context.state.park("due-approval", { reason: "approval", wakeAt: 100 }, owner)
            yield* context.state.park("no-wake", { reason: "event" }, owner)
            return {
              dueQuota: yield* context.state.waitingRuns({ reason: "quota", dueBeforeMs: 1_000 }),
              allQuota: yield* context.state.waitingRuns({ reason: "quota" }),
              dueAll: yield* context.state.waitingRuns({ dueBeforeMs: 1_000 }),
              all: yield* context.state.waitingRuns()
            }
          })
        )

        expect(result.dueQuota).toEqual([{ runId: "due-quota", reason: "quota", wakeAt: 500, token: null }])
        expect(result.allQuota.map((row) => row.runId)).toEqual(["due-quota", "future-quota"])
        expect(result.dueAll.map((row) => row.runId)).toEqual(["due-approval", "due-quota"])
        expect(result.all.map((row) => row.runId)).toEqual(["due-approval", "due-quota", "future-quota", "no-wake"])
      }))

    it.effect("orders waiting runs by wake time, sinks unbounded waits last, and breaks ties by run id", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            const waits = [
              { runId: "late", reason: "timer", wakeAt: 900 },
              { runId: "event-b", reason: "event" },
              { runId: "tie-b", reason: "timer", wakeAt: 100 },
              { runId: "z-max", reason: "event", wakeAt: Number.MAX_SAFE_INTEGER },
              { runId: "event-a", reason: "event" },
              { runId: "tie-a", reason: "timer", wakeAt: 100 },
              { runId: "timed-event", reason: "event", wakeAt: 400 }
            ] as const
            for (const { runId, ...wait } of waits) {
              yield* context.seedRun(runId, owner)
              yield* context.state.park(runId, wait, owner)
              yield* context.setCancelRequested(runId, 1)
            }
            return {
              all: yield* context.state.waitingRuns(),
              timers: yield* context.state.waitingRuns({ reason: "timer" }),
              events: yield* context.state.waitingRuns({ reason: "event" }),
              cancelled: yield* context.state.waitingRuns({ cancelRequested: true }),
              cancelledEvents: yield* context.state.waitingRuns({ reason: "event", cancelRequested: true }),
              dueAtBoundary: yield* context.state.waitingRuns({ dueBeforeMs: 100 }),
              dueTimers: yield* context.state.waitingRuns({ reason: "timer", dueBeforeMs: 100 }),
              dueAtMax: yield* context.state.waitingRuns({ dueBeforeMs: Number.MAX_SAFE_INTEGER })
            }
          })
        )

        const all = ["tie-a", "tie-b", "timed-event", "late", "z-max", "event-a", "event-b"]
        const events = ["timed-event", "z-max", "event-a", "event-b"]
        expect(result.all.map((row) => row.runId)).toEqual(all)
        expect(result.timers.map((row) => row.runId)).toEqual(["tie-a", "tie-b", "late"])
        expect(result.events.map((row) => row.runId)).toEqual(events)
        expect(result.cancelled.map((row) => row.runId)).toEqual(all)
        expect(result.cancelledEvents.map((row) => row.runId)).toEqual(events)
        // An unbounded (`wakeAt: null`) wait is never due, whatever the bound.
        expect(result.dueAtBoundary.map((row) => row.runId)).toEqual(["tie-a", "tie-b"])
        expect(result.dueTimers.map((row) => row.runId)).toEqual(["tie-a", "tie-b"])
        expect(result.dueAtMax.map((row) => row.runId)).toEqual(["tie-a", "tie-b", "timed-event", "late", "z-max"])
      }))

    it.effect("filters waitingRuns to cancel-requested rows (issue #68)", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun("cancel-parked", owner)
            yield* context.seedRun("calm-parked", owner)
            yield* context.state.park("cancel-parked", { reason: "event", wakeAt: 500 }, owner)
            yield* context.state.park("calm-parked", { reason: "event", wakeAt: 100 }, owner)
            yield* context.setCancelRequested("cancel-parked", 5)
            return {
              cancelOnly: yield* context.state.waitingRuns({ cancelRequested: true }),
              cancelAndReason: yield* context.state.waitingRuns({
                reason: "event",
                cancelRequested: true
              }),
              cancelAndDue: yield* context.state.waitingRuns({
                dueBeforeMs: 1_000,
                cancelRequested: true
              }),
              cancelReasonDue: yield* context.state.waitingRuns({
                reason: "event",
                dueBeforeMs: 1_000,
                cancelRequested: true
              }),
              unfiltered: yield* context.state.waitingRuns()
            }
          })
        )

        expect(result.cancelOnly.map((row) => row.runId)).toEqual(["cancel-parked"])
        expect(result.cancelAndReason.map((row) => row.runId)).toEqual(["cancel-parked"])
        expect(result.cancelAndDue.map((row) => row.runId)).toEqual(["cancel-parked"])
        expect(result.cancelReasonDue.map((row) => row.runId)).toEqual(["cancel-parked"])
        // The predicate is opt-in: an unfiltered query still lists everything.
        expect(result.unfiltered.map((row) => row.runId)).toEqual(["calm-parked", "cancel-parked"])
      }))

    it.effect("lists only stale-running rows from staleRunningRuns (issue #53)", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            // A hard-killed owner: running with a long-frozen heartbeat.
            yield* context.seedRun("stale-old", owner, "running", 0)
            // Same frozen heartbeat: run id breaks the tie deterministically.
            yield* context.seedRun("stale-old-b", owner, "running", 0)
            // A third stale run, later heartbeat: ordering material.
            yield* context.seedRun("stale-newer", owner, "running", 5_000)
            // A live run: fresh heartbeat, must never surface.
            yield* context.seedRun("fresh", owner, "running", 90_000)
            // Not running: staleness does not apply (a released/suspended row
            // has no owner and no heartbeat, per the flows_runs CHECK).
            yield* context.seedRun("parked-stale", null, "suspended", null)
            return {
              beforeOne: yield* context.state.staleRunningRuns(1_000),
              beforeBoth: yield* context.state.staleRunningRuns(10_000),
              // The per-tick cap (issue #79): oldest heartbeats first, the
              // backlog beyond the limit waits for the next sweep.
              capped: yield* context.state.staleRunningRuns(10_000, 2)
            }
          })
        )

        const oldest = [{ runId: "stale-old", heartbeatAtMs: 0 }, { runId: "stale-old-b", heartbeatAtMs: 0 }]
        expect(result.beforeOne).toEqual(oldest)
        expect(result.beforeBoth).toEqual([...oldest, { runId: "stale-newer", heartbeatAtMs: 5_000 }])
        expect(result.capped).toEqual(oldest)
      }))

    it.effect("excludes terminally closed runs from waitingRuns (issue #28)", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun("closed-timer", owner)
            yield* context.seedRun("live-timer", owner)
            yield* context.state.park("closed-timer", { reason: "timer", wakeAt: 100 }, owner)
            yield* context.state.park("live-timer", { reason: "timer", wakeAt: 200 }, owner)
            // A raced cancel closed the run after it parked; its stale waiting
            // row must never surface to a sweeper again.
            yield* context.setStatus("closed-timer", "cancelled")
            return {
              due: yield* context.state.waitingRuns({ reason: "timer", dueBeforeMs: 1_000 }),
              all: yield* context.state.waitingRuns()
            }
          })
        )

        expect(result.due.map((row) => row.runId)).toEqual(["live-timer"])
        expect(result.all.map((row) => row.runId)).toEqual(["live-timer"])
      }))

    it.effect("excludes engine-state rows after retention deletes their run", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            const runId = "retained-away"
            const flowName = "Contract/DeletedRun"
            yield* context.seedRun(runId, owner)
            yield* context.state.scheduleClock({
              flowName,
              executionId: runId,
              clockName: "wake",
              deferredName: "wake-deferred",
              dueAtMs: 1_000,
              completedAtMs: null
            }, owner)
            yield* context.state.completeDeferred({
              flowName,
              executionId: runId,
              deferredName: "completed",
              exit: { value: "done" },
              completedAtMs: 10
            })
            yield* context.state.park(runId, { reason: "event" }, owner)
            yield* context.deleteRun(runId)
            return {
              clocks: yield* context.state.pendingClocks({ executionId: runId }),
              deferreds: yield* context.state.completedDeferreds(flowName),
              waiting: yield* context.state.waitingRuns()
            }
          })
        )

        expect(result).toEqual({ clocks: [], deferreds: [], waiting: [] })
      }))

    it("requires an owner to schedule a clock", () => {
      expectTypeOf<Parameters<DurableEngineState.Service["scheduleClock"]>>()
        .toEqualTypeOf<[row: DurableEngineState.ClockRow, owner: Ownership.OwnerId]>()
    })

    it.effect("fences clock creation to the current owner of a running run", () =>
      Effect.gen(function*() {
        const clockRow: DurableEngineState.ClockRow = {
          flowName: "Contract/Flow",
          executionId: "clock-run",
          clockName: "wake",
          deferredName: "wake-deferred",
          dueAtMs: 1_000,
          completedAtMs: null
        }
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun("clock-run", owner, "running")
            const fenced = yield* awaitExit(context.state.scheduleClock(clockRow, otherOwner))
            const afterFenced = yield* context.state.clock(clockRow)
            const scheduled = yield* context.state.scheduleClock(clockRow, owner)
            const duplicate = yield* context.state.scheduleClock({ ...clockRow, dueAtMs: 9_999 }, owner)
            const staleDuplicate = yield* context.state.scheduleClock({ ...clockRow, dueAtMs: 9_999 }, otherOwner)
            return { fenced, afterFenced, scheduled, duplicate, staleDuplicate }
          })
        )

        expect(Exit.isFailure(result.fenced) && Cause.hasInterruptsOnly(result.fenced.cause)).toBe(true)
        expect(Option.isNone(result.afterFenced)).toBe(true)
        expect(result.scheduled).toEqual({ _tag: "Scheduled", row: clockRow })
        // First-writer-wins: a duplicate schedule returns the existing row.
        expect(result.duplicate).toEqual({ _tag: "Existing", row: clockRow })
        expect(result.staleDuplicate).toEqual({ _tag: "Existing", row: clockRow })
      }))

    it.effect("completes a clock exactly once and lists only due, uncompleted clocks", () =>
      Effect.gen(function*() {
        const base: DurableEngineState.ClockRow = {
          flowName: "Contract/Flow",
          executionId: "due-run",
          clockName: "first",
          deferredName: "first-deferred",
          dueAtMs: 100,
          completedAtMs: null
        }
        const later: DurableEngineState.ClockRow = {
          ...base,
          clockName: "second",
          deferredName: "second-deferred",
          dueAtMs: 5_000
        }
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun("due-run", owner, "running")
            yield* context.state.scheduleClock(base, owner)
            yield* context.state.scheduleClock(later, owner)
            const due = yield* context.state.dueClocks(1_000)
            const completed = yield* context.state.completeClock(base, 150)
            const again = yield* context.state.completeClock(base, 999)
            const missing = yield* context.state.completeClock({ ...base, clockName: "ghost" }, 1)
            const dueAfter = yield* context.state.dueClocks(1_000)
            return { due, completed, again, missing, dueAfter }
          })
        )

        expect(result.due).toEqual([base])
        expect(result.completed).toEqual({ _tag: "Completed", row: { ...base, completedAtMs: 150 } })
        expect(result.again).toEqual({ _tag: "AlreadyCompleted", row: { ...base, completedAtMs: 150 } })
        expect(result.missing).toEqual({ _tag: "NotFound" })
        expect(result.dueAfter).toEqual([])
      }))

    it.effect("scopes pendingClocks to an execution or flow without a due-time bound (issue #35)", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            for (const runId of ["clocks-target", "clocks-other"]) {
              yield* context.seedRun(runId, owner)
            }
            const base = {
              flowName: "clocks-flow",
              deferredName: "clocks-deferred",
              completedAtMs: null
            }
            // A populated store: another execution's clock, a future clock, a
            // due clock, and a completed clock on the target execution.
            yield* context.state.scheduleClock(
              { ...base, executionId: "clocks-other", clockName: "other", dueAtMs: 10 },
              owner
            )
            yield* context.state.scheduleClock(
              { ...base, executionId: "clocks-target", clockName: "future", dueAtMs: 999_999 },
              owner
            )
            yield* context.state.scheduleClock(
              { ...base, executionId: "clocks-target", clockName: "due", dueAtMs: 5 },
              owner
            )
            yield* context.state.scheduleClock(
              {
                ...base,
                flowName: "other-flow",
                executionId: "clocks-target",
                clockName: "cross-flow",
                dueAtMs: 4
              },
              owner
            )
            yield* context.state.scheduleClock(
              { ...base, executionId: "clocks-target", clockName: "done", dueAtMs: 1 },
              owner
            )
            yield* context.state.completeClock(
              { flowName: "clocks-flow", executionId: "clocks-target", clockName: "done" },
              2
            )
            return {
              byExecution: yield* context.state.pendingClocks({ executionId: "clocks-target" }),
              byFlow: yield* context.state.pendingClocks({ flowName: "clocks-flow" }),
              byExecutionAndFlow: yield* context.state.pendingClocks({
                executionId: "clocks-target",
                flowName: "clocks-flow"
              }),
              all: yield* context.state.pendingClocks({})
            }
          })
        )

        // Execution scope: pending only (future ones included), never other
        // executions' rows, ordered by due time.
        expect(result.byExecution.map((row) => row.clockName)).toEqual(["cross-flow", "due", "future"])
        expect(result.byFlow.map((row) => row.clockName)).toEqual(["due", "other", "future"])
        expect(result.byExecutionAndFlow.map((row) => row.clockName)).toEqual(["due", "future"])
        expect(result.all).toHaveLength(4)
      }))

    it.effect("consumption survives restart, rolls back, and never hides replay evidence", () =>
      harness.run((context) =>
        Effect.gen(function*() {
          const row: DurableEngineState.DeferredRow = {
            flowName: "Contract/Consumption",
            executionId: "consumption-run",
            deferredName: "answer",
            exit: { value: "first" },
            completedAtMs: 10
          }
          yield* context.seedRun(row.executionId, owner)
          // An absent result cannot be consumed ahead of its arrival.
          yield* context.state.consumeDeferred(row, 11)
          yield* context.state.completeDeferred(row)
          const before = yield* context.state.completedDeferreds(row.flowName)
          expect(before).toHaveLength(1)
          yield* context.state.transaction(Effect.gen(function*() {
            yield* context.state.consumeDeferred(row, 12)
            expect(yield* context.state.completedDeferreds(row.flowName)).toEqual([])
            return yield* Effect.fail("rollback")
          })).pipe(Effect.catch(() => Effect.void))
          expect(yield* context.state.completedDeferreds(row.flowName)).toEqual(before)
          yield* context.state.consumeDeferred(row, 13)
          const restarted = yield* context.restart
          yield* restarted.consumeDeferred(row, 14)
          yield* restarted.completeDeferred({ ...row, exit: { value: "duplicate" } })
          expect(yield* restarted.completedDeferreds(row.flowName)).toEqual([])
          expect(Option.getOrThrow(yield* restarted.deferred(row))).toEqual(row)
        })
      ))

    it.effect("keeps the first deferred completion and reads it back after a restart", () =>
      Effect.gen(function*() {
        const row: DurableEngineState.DeferredRow = {
          flowName: "Contract/Flow",
          executionId: "deferred-run",
          deferredName: "answer",
          exit: { value: "first" },
          completedAtMs: 10
        }
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun("deferred-run", owner, "running")
            const first = yield* context.state.completeDeferred(row)
            const second = yield* context.state.completeDeferred({
              ...row,
              exit: { value: "different" },
              completedAtMs: 20
            })
            const restarted = yield* context.restart
            const read = yield* restarted.deferred(row)
            const listed = yield* restarted.completedDeferreds("Contract/Flow")
            return { first, second, read, listed }
          })
        )

        expect(result.first._tag).toBe("Completed")
        expect(result.second._tag).toBe("Existing")
        expect(Option.getOrThrow(result.read).exit).toEqual({ value: "first" })
        expect(result.listed).toEqual([
          { flowName: "Contract/Flow", executionId: "deferred-run", deferredName: "answer" }
        ])
      }))
  })
}
