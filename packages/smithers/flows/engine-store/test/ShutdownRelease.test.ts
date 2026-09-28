import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Pins issue #26: a drive-fiber interruption that is not an operator
 * cancellation — process shutdown closing the coordinator scope, or the
 * heartbeat loop self-interrupting on a transient error — must leave the run
 * reclaimable (Temporal worker-shutdown semantics), never durably
 * `cancelled`. Only an interruption backed by a durable cancel request
 * (`cancel_requested_at_ms`) may close the run terminally.
 */
import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("ShutdownRelease/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const owner: Ownership.OwnerId = {
  hostId: "shutdown-host",
  pid: 1,
  nonce: "shutdown-owner"
}

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const makeDriver = () =>
  RunDriver.make({
    owner,
    journalSource: "shutdown-release",
    isAlive: () => Effect.succeed(true),
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

describe("shutdown releases instead of cancelling (issue #26)", () => {
  it.effect("an external drive-fiber interruption parks the run reclaimably", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const journal = yield* Journal.Journal
        // The driver lives in its own scope so the test can close it while a
        // flow is in flight, exactly like process shutdown tearing down the
        // coordinator's fiber set.
        const driverScope = yield* Scope.make()
        const driver = yield* makeDriver().pipe(Scope.provide(driverScope))
        const started = yield* Latch.make(false)
        yield* driver.register(TestFlow, () => Latch.open(started).pipe(Effect.andThen(Effect.never)))
        yield* driver.execute(TestFlow, {
          executionId: "shutdown-interrupt",
          payload: {},
          discard: true
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Latch.await(started)

        // Process shutdown: the scope closes and interrupts the drive fiber.
        // No operator asked for cancellation.
        yield* Scope.close(driverScope, Exit.void)
        const row = yield* store.get("shutdown-interrupt")
        yield* journal.flush
        const entries = yield* journal.entries({ runId: "shutdown-interrupt" as never, limit: 100 })
        return { row, eventTypes: entries.entries.map((entry) => entry.eventType) }
      })))

      // Reclaimable, not terminally closed: another worker must be able to
      // claim and resume this run.
      expect(result.row.status).toBe("suspended")
      expect(result.row.owner).toBeNull()
      expect(result.eventTypes).not.toContain("flows.engine.interrupted")
    }))

  for (const boundary of ["claimed", "activated", "retained"] as const) {
    it.effect(`shutdown releases ownership at the ${boundary} boundary and same-PID replacement resumes`, () =>
      Effect.gen(function*() {
        const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const state = yield* DurableEngineState.DurableEngineState
          const atBoundary = yield* Latch.make(false)
          const driverScope = yield* Scope.make()
          const executionId = `shutdown-${boundary}`
          const firstOwner = { hostId: "same-process", pid: process.pid, nonce: "first" }
          const barrier = Latch.open(atBoundary).pipe(Effect.andThen(Effect.never))
          const interruptedStore = boundary === "claimed"
            ? RunStore.makeNoop({
              ...store,
              claim: (...args) => store.claim(...args).pipe(Effect.andThen(barrier))
            })
            : store
          const driver = yield* RunDriver.make({
            owner: firstOwner,
            journalSource: "shutdown-boundary-first",
            isAlive: Ownership.sameHostPidProbe,
            engine: boundary === "activated" ? barrier : Effect.succeed(fakeEngine),
            // The existing observation hook runs uninterruptibly. Queue the
            // interrupt there; it is delivered immediately after that finalizer.
            unsafeOnScopeRetained: boundary === "retained"
              ? () => Effect.withFiber((fiber) => Effect.sync(() => fiber.interruptUnsafe()))
              : undefined
          }).pipe(
            Effect.provideService(RunStore.RunStore, interruptedStore),
            Scope.provide(driverScope)
          )
          yield* driver.register(TestFlow, () =>
            Effect.gen(function*() {
              const instance = yield* FlowRuntime.FlowInstance
              instance.suspended = true
              instance.waiting = { reason: "approval", token: "approval-42" }
              return yield* Effect.interrupt
            }))
          // resume joins the complete round without adding a pending wake.
          yield* store.create(executionId, JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} }))
          const driving = yield* driver.resume(TestFlow, executionId).pipe(Effect.forkChild({ startImmediately: true }))
          if (boundary === "retained") {
            yield* Fiber.await(driving)
          } else {
            yield* Latch.await(atBoundary)
          }
          yield* Scope.close(driverScope, Exit.void)
          const released = yield* store.get(executionId)
          const waiting = yield* state.waiting(executionId)
          const replacement = yield* RunDriver.make({
            owner: { ...firstOwner, nonce: "replacement" },
            journalSource: "shutdown-boundary-replacement",
            isAlive: Ownership.sameHostPidProbe,
            engine: Effect.succeed(fakeEngine)
          })
          yield* replacement.register(TestFlow, () => Effect.succeed("resumed"))
          yield* replacement.resume(TestFlow, executionId)
          return { released, waiting, completed: yield* store.get(executionId) }
        })))
        expect(result.released.owner).toBeNull()
        expect(result.released.claim).toBeNull()
        expect(result.released.status).toBe(boundary === "claimed" ? "pending" : "suspended")
        if (boundary === "retained") {
          expect(Option.getOrThrow(result.waiting)).toMatchObject({ reason: "approval", token: "approval-42" })
          expect(JSON.parse(result.released.stateJson).result._tag).toBe("Suspended")
        }
        expect(result.completed.status).toBe("completed")
        expect(result.completed.owner).toBeNull()
      }))
  }

  it.effect("a persisted cancellation at the retained-scope boundary still closes with an interrupt exit", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const exits: Array<boolean> = []
        const driver = yield* RunDriver.make({
          owner,
          journalSource: "shutdown-retained-cancellation",
          engine: Effect.succeed(fakeEngine),
          unsafeOnScopeRetained: (runId) =>
            store.requestCancel(runId, 0).pipe(
              Effect.orDie,
              Effect.andThen(Effect.withFiber((fiber) => Effect.sync(() => fiber.interruptUnsafe())))
            )
        })
        yield* driver.register(TestFlow, () =>
          Effect.gen(function*() {
            const instance = yield* FlowRuntime.FlowInstance
            yield* Scope.addFinalizerExit(instance.scope, (exit) => Effect.sync(() => exits.push(Exit.isFailure(exit))))
            instance.suspended = true
            instance.waiting = { reason: "approval", token: "cancelled-approval" }
            return yield* Effect.interrupt
          }))
        const runId = "shutdown-retained-cancellation"
        yield* store.create(runId, JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} }))
        yield* Effect.exit(driver.resume(TestFlow, runId))
        return { row: yield* store.get(runId), exits, retained: [...yield* driver.retainedRuns] }
      })))
      expect(result.row.status).toBe("cancelled")
      expect(result.row.owner).toBeNull()
      expect(result.exits).toEqual([true])
      expect(result.retained).toEqual([])
    }))

  it.effect("can shut down before the first run read completes", () =>
    withCrypto(provideJournal(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const reading = yield* Latch.make(false)
      const driverScope = yield* Scope.make()
      let reads = 0
      const driver = yield* makeDriver().pipe(
        Effect.provideService(RunStore.RunStore, {
          ...store,
          get: (runId) =>
            Effect.suspend(() => {
              reads++
              // The admission read succeeds; the coordinator's first read stalls.
              return reads === 1 ? store.get(runId) : Latch.open(reading).pipe(Effect.andThen(Effect.never))
            })
        }),
        Scope.provide(driverScope)
      )
      yield* driver.register(TestFlow, () => Effect.die("must not start"))
      yield* store.create("shutdown-reading", JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} }))
      yield* driver.resume(TestFlow, "shutdown-reading").pipe(Effect.forkChild({ startImmediately: true }))
      yield* Latch.await(reading)
      yield* Scope.close(driverScope, Exit.void)
      expect((yield* store.get("shutdown-reading")).status).toBe("pending")
    }))))

  it.effect("tolerates a run removed before interrupted ownership cleanup", () =>
    withCrypto(provideJournal(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const started = yield* Latch.make(false)
      const driverScope = yield* Scope.make()
      let removed = false
      const driver = yield* makeDriver().pipe(
        Effect.provideService(RunStore.RunStore, {
          ...store,
          get: (runId) =>
            removed
              ? Effect.fail(
                new RunStore.RunStoreError({
                  code: "not_found_row",
                  method: "get",
                  message: "removed",
                  cause: undefined
                })
              )
              : store.get(runId)
        }),
        Scope.provide(driverScope)
      )
      yield* driver.register(TestFlow, () => Latch.open(started).pipe(Effect.andThen(Effect.never)))
      yield* store.create("shutdown-removed", JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} }))
      yield* driver.resume(TestFlow, "shutdown-removed").pipe(Effect.forkChild({ startImmediately: true }))
      yield* Latch.await(started)
      removed = true
      const closed = yield* Scope.close(driverScope, Exit.void).pipe(Effect.exit)
      expect(Exit.isSuccess(closed)).toBe(true)
    }))))

  it.effect("surfaces a real SQLite read failure during interrupted ownership cleanup", () =>
    withCrypto(
      Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const sql = yield* SqlClient.SqlClient
        const started = yield* Latch.make(false)
        const driverScope = yield* Effect.acquireRelease(
          Scope.make(),
          (scope) => Scope.close(scope, Exit.void)
        )
        const driver = yield* makeDriver().pipe(Scope.provide(driverScope))
        yield* driver.register(TestFlow, () => Latch.open(started).pipe(Effect.andThen(Effect.never)))
        const runId = "shutdown-storage-error"
        yield* store.create(runId, JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} }))
        const driving = yield* driver.resume(TestFlow, runId).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Latch.await(started)

        // Simulate the database losing its run table after a flow has started.
        // The real RunStore now reports persistence_failed from its SELECT.
        yield* sql`ALTER TABLE flows_runs RENAME TO flows_runs_unavailable`
        const readFailure = yield* store.get(runId).pipe(Effect.flip)
        expect(readFailure.code).toBe("persistence_failed")

        yield* Scope.close(driverScope, Exit.void)
        const exit = yield* Fiber.await(driving)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons.find(Cause.isDieReason)?.defect).toMatchObject({
            code: "persistence_failed",
            method: "get"
          })
        }

        yield* sql`ALTER TABLE flows_runs_unavailable RENAME TO flows_runs`
        const row = yield* store.get(runId)
        expect(row.status).toBe("running")
        expect(row.owner).toEqual(owner)
      }).pipe(
        Effect.scoped,
        Effect.provide(TestStores.layerAt(":memory:")),
        Effect.provide(TestClock.layer())
      )
    ))

  it.effect("operator interrupt still durably cancels the run", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver()
        const started = yield* Latch.make(false)
        yield* driver.register(TestFlow, () => Latch.open(started).pipe(Effect.andThen(Effect.never)))
        const fiber = yield* driver.execute(TestFlow, {
          executionId: "shutdown-operator-cancel",
          payload: {},
          discard: true
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Latch.await(started)

        yield* driver.interrupt(TestFlow, "shutdown-operator-cancel")
        yield* Fiber.await(fiber)
        const row = yield* store.get("shutdown-operator-cancel")
        return { row }
      })))

      expect(result.row.status).toBe("cancelled")
      expect(result.row.cancelRequestedAtMs).not.toBeNull()
      expect(result.row.owner).toBeNull()
    }))
})
