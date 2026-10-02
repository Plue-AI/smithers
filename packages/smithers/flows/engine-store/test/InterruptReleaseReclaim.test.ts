import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { executeAndDrain } from "./ExecuteAndDrain.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Pins issue #39: a run released by a non-cancel interruption (process
 * shutdown, heartbeat self-interrupt) must remain reachable. The #26 release
 * path transitioned the run to `suspended` without parking it, so it had no
 * durable waiting row: no sweep ever re-drove it, and the parked-run cancel
 * sweeper (which enumerates only `waitingRuns()`) could never deliver a
 * durable `requestCancel`. The release must park with a durable reason so
 * the run is re-drivable and cancellable.
 */
import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import type { Journal } from "@smthrs/journal"
import { Journal as JournalService } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Latch from "effect/Latch"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import { releaseCauseOf } from "../src/RunState.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("InterruptReleaseReclaim/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const makeDriver = (nonce: string) =>
  RunDriver.make({
    owner: { hostId: "reclaim-host", pid: 1, nonce },
    journalSource: "reclaim",
    isAlive: () => Effect.succeed(false),
    engine: Effect.succeed(fakeEngine)
  })

const provideJournal = <A, E, R>(
  effect: Effect.Effect<A, E, R | Journal.Journal | RunStore.RunStore>
) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(TestStores.layer()),
    Effect.provide(DurableEngineState.layerMemory),
    Effect.provide(TestClock.layer())
  )

/** Interrupts a run mid-action via driver-scope close and returns the row. */
const releaseMidAction = (executionId: string) =>
  Effect.gen(function*() {
    const driverScope = yield* Scope.make()
    const driver = yield* makeDriver("owner-1").pipe(Scope.provide(driverScope))
    const started = yield* Latch.make(false)
    yield* driver.register(TestFlow, () => Latch.open(started).pipe(Effect.andThen(Effect.never)))
    yield* executeAndDrain(driver, TestFlow, {
      executionId,
      payload: {},
      discard: true
    }).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Latch.await(started)
    // Process shutdown: the scope closes and interrupts the drive fiber.
    yield* Scope.close(driverScope, Exit.void)
  })

/** The `interrupt-released` decisions a run recorded, as written. */
const releases = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* JournalService.Journal
    yield* journal.flush
    const page = yield* JournalRecords.entries(runId, undefined, 100)
    return page.entries
      .filter((entry) => entry.eventType === "flows.engine.run-decision")
      .map((entry) => entry.payload as { readonly decision: string; readonly cause?: unknown })
      .filter((payload) => payload.decision === "interrupt-released")
  })

describe("interrupt-released records why the run was released (#3328)", () => {
  it("decodes a recorded cause and answers undefined for a decision written before causes existed", () => {
    expect(releaseCauseOf({ decision: "interrupt-released", cause: { kind: "lease-lapsed", unconfirmedMs: 20_412 } }))
      .toEqual({ kind: "lease-lapsed", unconfirmedMs: 20_412 })
    expect(releaseCauseOf({ decision: "interrupt-released", cause: { kind: "interrupted" } }))
      .toEqual({ kind: "interrupted" })
    // A journal written by an older build: same decision, no cause field.
    expect(releaseCauseOf({ decision: "interrupt-released", owner: { hostId: "h", pid: 1, nonce: "n" } }))
      .toBeUndefined()
    expect(releaseCauseOf({ decision: "interrupt-released", cause: { kind: "lease-lapsed", unconfirmedMs: -1 } }))
      .toBeUndefined()
    expect(releaseCauseOf({ decision: "interrupt-released", cause: { kind: "solar-flare" } })).toBeUndefined()
    expect(releaseCauseOf({ decision: "transitioned", cause: { kind: "interrupted" } })).toBeUndefined()
    expect(releaseCauseOf(null)).toBeUndefined()
    expect(releaseCauseOf("interrupt-released")).toBeUndefined()
  })

  it.effect("records an interrupted cause when the host shuts down", () =>
    Effect.gen(function*() {
      const recorded = yield* withCrypto(provideJournal(Effect.gen(function*() {
        yield* releaseMidAction("release-shutdown")
        return yield* releases("release-shutdown")
      })))

      expect(recorded).toHaveLength(1)
      expect(recorded[0]!.cause).toEqual({ kind: "interrupted" })
    }))

  it.effect("retains owned work after a successful reconfirm and durably records the recovered lease", () =>
    withCrypto(provideJournal(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const journal = yield* JournalService.Journal
      const executionId = "release-reconfirmed"
      const toleranceMs = Duration.toMillis(Ownership.heartbeatWriteTolerance)
      const intervalMs = Duration.toMillis(Ownership.heartbeatInterval)
      let heartbeatFailures = 0
      const renewalStamps: Array<number> = []
      const recovering: RunStore.Service = {
        ...store,
        heartbeat: () =>
          Effect.sync(() => {
            heartbeatFailures++
          }).pipe(Effect.andThen(Effect.fail(
            new RunStore.RunStoreError({
              method: "heartbeat",
              code: "persistence_failed",
              message: "ordinary heartbeat write unavailable",
              cause: undefined
            })
          ))),
        reconfirm: (runId, claimant, nowMs) =>
          store.reconfirm(runId, claimant, nowMs).pipe(
            Effect.tap((outcome) =>
              Effect.sync(() => {
                if (outcome._tag === "Updated") renewalStamps.push(nowMs)
              })
            )
          )
      }
      const driver = yield* makeDriver("owner-positive").pipe(Effect.provideService(RunStore.RunStore, recovering))
      const started = yield* Latch.make(false)
      let executions = 0
      yield* driver.register(TestFlow, () =>
        Effect.sync(() => {
          executions++
        }).pipe(
          Effect.andThen(Latch.open(started)),
          Effect.andThen(Effect.never)
        ))
      yield* executeAndDrain(driver, TestFlow, {
        executionId,
        payload: {},
        discard: true
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Latch.await(started)
      const original = yield* store.get(executionId)
      expect(original).toMatchObject({
        status: "running",
        owner: { hostId: "reclaim-host", pid: 1, nonce: "owner-positive" },
        claim: null
      })
      expect(original.heartbeatAtMs).not.toBeNull()
      yield* TestClock.adjust(intervalMs)
      yield* TestDatabase.until(Effect.sync(() => heartbeatFailures > 0))
      // Reach the old lease's complete budget, then let actual adapter I/O
      // finish without advancing the new lease while its receipt commits.
      yield* TestClock.adjust(toleranceMs - intervalMs)
      const reconfirmed = () =>
        Effect.gen(function*() {
          yield* journal.flush
          const page = yield* JournalRecords.entries(executionId, undefined, 100)
          return page.entries.filter((entry) =>
            entry.eventType === "flows.engine.run-decision" &&
            (entry.payload as { decision: string }).decision === "lease-reconfirmed"
          )
        })
      yield* TestDatabase.until(reconfirmed().pipe(Effect.map((records) => records.length === 1)))
      const renewed = yield* store.get(executionId)
      expect(renewalStamps).toHaveLength(1)
      expect(renewed).toMatchObject({ status: "running", owner: original.owner, claim: null })
      expect(renewed.heartbeatAtMs).toBe(renewalStamps[0])
      expect(renewed.heartbeatAtMs! - original.heartbeatAtMs!).toBe(toleranceMs)
      expect((yield* reconfirmed())[0]?.payload).toMatchObject({
        decision: "lease-reconfirmed",
        detail: { unconfirmedMs: toleranceMs }
      })
      // Prove the same action survives beyond the original deadline, rather
      // than being released and silently replaced by the reclaim sweep.
      yield* TestClock.adjust(intervalMs)
      yield* TestDatabase.until(Effect.sync(() => heartbeatFailures >= 2))
      expect(yield* store.get(executionId)).toMatchObject({ status: "running", owner: original.owner })
      expect(executions).toBe(1)
      expect(yield* releases(executionId)).toEqual([])
      expect(yield* reconfirmed()).toHaveLength(1)
      yield* driver.interrupt(TestFlow, executionId)
      yield* TestDatabase.until(store.get(executionId).pipe(Effect.map((row) => row.status === "cancelled")))
      expect(yield* store.get(executionId)).toMatchObject({ status: "cancelled", owner: null, claim: null })
      yield* journal.flush
      const final = yield* JournalRecords.entries(executionId, undefined, 100)
      const interruptions = final.entries.filter((entry) => entry.eventType === "flows.engine.interrupted")
      expect(interruptions).toHaveLength(1)
      expect(interruptions[0]?.payload).toMatchObject({ outcome: "cancelled" })
      expect(yield* releases(executionId)).toEqual([])
      expect(yield* reconfirmed()).toHaveLength(1)
      expect(executions).toBe(1)
    }))))

  it.effect("records lease-lapsed with the unconfirmed duration when heartbeat writes stall", () =>
    Effect.gen(function*() {
      const toleranceMs = Duration.toMillis(Ownership.heartbeatWriteTolerance)
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        let reconfirmAttempts = 0
        const unavailable = (method: "heartbeat" | "reconfirm") =>
          Effect.fail(
            new RunStore.RunStoreError({
              method,
              code: "persistence_failed",
              message: "database unavailable",
              cause: undefined
            })
          )
        const stalled = RunStore.makeNoop({
          ...store,
          heartbeat: () => unavailable("heartbeat"),
          reconfirm: () =>
            Effect.sync(() => {
              reconfirmAttempts++
            }).pipe(Effect.andThen(unavailable("reconfirm")))
        })
        const driver = yield* makeDriver("owner-1").pipe(Effect.provideService(RunStore.RunStore, stalled))
        const started = yield* Latch.make(false)
        yield* driver.register(TestFlow, () => Latch.open(started).pipe(Effect.andThen(Effect.never)))
        yield* executeAndDrain(driver, TestFlow, {
          executionId: "release-lapsed",
          payload: {},
          discard: true
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Latch.await(started)
        let row = yield* store.get("release-lapsed")
        for (let i = 0; i < 200 && row.status !== "suspended"; i++) {
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
          yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
          row = yield* store.get("release-lapsed")
        }
        return { row, recorded: yield* releases("release-lapsed"), reconfirmAttempts }
      })))

      expect(result.row.status).toBe("suspended")
      expect(result.reconfirmAttempts).toBeGreaterThan(0)
      expect(result.recorded).toHaveLength(1)
      const cause = result.recorded[0]!.cause as { readonly kind: string; readonly unconfirmedMs: number }
      expect(cause.kind).toBe("lease-lapsed")
      expect(cause.unconfirmedMs).toBeGreaterThanOrEqual(toleranceMs)
      expect(cause.unconfirmedMs).toBeLessThan(toleranceMs + Duration.toMillis(Ownership.heartbeatInterval) * 2)
    }))
})

describe("interrupt-released runs are reclaimable (issue #39)", () => {
  it.effect("clears its release marker when the ownership fence is lost", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const state = yield* DurableEngineState.DurableEngineState
        const fenceLost = RunStore.makeNoop({
          ...store,
          transitionOwned: (runId, claimant, status, stateJson, guard) =>
            status === "suspended"
              ? store.transitionOwned(
                runId,
                { hostId: "other-host", pid: 2, nonce: "other-owner" },
                status,
                stateJson,
                guard
              )
              : store.transitionOwned(runId, claimant, status, stateJson, guard)
        })
        const driverScope = yield* Scope.make()
        const driver = yield* makeDriver("owner-1").pipe(
          Effect.provideService(RunStore.RunStore, fenceLost),
          Scope.provide(driverScope)
        )
        const started = yield* Latch.make(false)
        yield* driver.register(TestFlow, () => Latch.open(started).pipe(Effect.andThen(Effect.never)))
        yield* executeAndDrain(driver, TestFlow, {
          executionId: "release-fence-lost",
          payload: {},
          discard: true
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Latch.await(started)
        yield* Scope.close(driverScope, Exit.void)
        return {
          row: yield* store.get("release-fence-lost"),
          waiting: yield* state.waiting("release-fence-lost")
        }
      })))

      expect(result.row.status).toBe("running")
      expect(Option.isNone(result.waiting)).toBe(true)
    }))

  it.effect("parks the released run with a durable waiting reason", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const state = yield* DurableEngineState.DurableEngineState
        yield* releaseMidAction("release-parked")
        const row = yield* store.get("release-parked")
        const waiting = yield* state.waiting("release-parked")
        return { row, waiting }
      })))

      expect(result.row.status).toBe("suspended")
      expect(result.row.owner).toBeNull()
      expect(Option.isSome(result.waiting)).toBe(true)
      if (Option.isSome(result.waiting)) {
        expect(result.waiting.value.reason).toBe("released")
      }
    }))

  it.effect("a later worker's sweep re-drives the released run to completion", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* releaseMidAction("release-redrive")

        // A fresh worker over the same store: its sweep must find the
        // released run and re-drive it without any operator action.
        const successor = yield* makeDriver("owner-2")
        yield* successor.register(TestFlow, () => Effect.succeed("reclaimed"))

        let row = yield* store.get("release-redrive")
        for (let i = 0; i < 2000 && row.status !== "completed"; i++) {
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
          yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
          row = yield* store.get("release-redrive")
        }
        return { row }
      })))

      expect(result.row.status).toBe("completed")
    }))

  it.effect("requestCancel against a released run is eventually delivered", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* releaseMidAction("release-cancel")

        // Another process (the CLI) durably requests cancellation while
        // nothing owns the run.
        yield* store.requestCancel("release-cancel", 1)

        const successor = yield* makeDriver("owner-2")
        // The flow body must never re-run: the re-activation cancel guard
        // closes the run instead.
        let bodyRuns = 0
        yield* successor.register(TestFlow, () =>
          Effect.sync(() => {
            bodyRuns += 1
          }).pipe(Effect.andThen(Effect.never)))

        let row = yield* store.get("release-cancel")
        for (let i = 0; i < 2000 && row.status !== "cancelled"; i++) {
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
          yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
          row = yield* store.get("release-cancel")
        }
        return { row, bodyRuns }
      })))

      expect(result.row.status).toBe("cancelled")
      expect(result.bodyRuns).toBe(0)
    }))
})
