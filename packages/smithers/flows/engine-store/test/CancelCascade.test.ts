import type { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
/**
 * A durable cancellation must reach the linked children of the run it
 * cancelled, and must release the flow scope a parked run retained.
 *
 * Both properties used to hold only in-process and only by accident.
 * Child-flow handling rode on `FlowInstance.interrupted`, an ephemeral flag
 * that `FlowEngine.make`'s parent link reads and that only the process which
 * called `interrupt` ever sets: a cancellation observed from durable state —
 * another CLI, another worker, a lease recovery, this process's own cancel
 * poll — left every linked child running. And `Flow.intoResult` deliberately
 * keeps the flow scope OPEN across a suspension, but nothing owned that scope
 * once the round returned, so cancelling a parked flow ran none of its
 * finalizers and every park leaked a scope.
 *
 * The cascade is therefore driven by the DURABLE `flows_run_parents` edge
 * table, and the scope by an explicit per-run retention whose removal is the
 * close (`RunDriver.releaseRetainedScope`), so "exactly once" is a property of
 * the state machine rather than of a timing hook.
 */
import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const CascadeFlow = Flow.make("CancelCascade/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

/**
 * Two drivers over ONE store and ONE durable state, with distinct owners.
 *
 * Distinct instances are the point: `driverB` never spawned any of the runs,
 * holds no `FlowInstance` for any of them, and shares no in-process map with
 * `driverA`. Anything it manages to cancel, it cancelled from durable state.
 */
const makeDriver = (nonce: string) =>
  RunDriver.make({
    owner: { hostId: `cascade-host-${nonce}`, pid: 1, nonce: `cascade-owner-${nonce}` },
    journalSource: `cascade-${nonce}`,
    isAlive: () => Effect.succeed(true),
    engine: Effect.succeed(fakeEngine)
  })

const provide = <A, E, R>(
  effect: Effect.Effect<A, E, R | Journal.Journal | RunStore.RunStore>
) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(TestStores.layer()),
    Effect.provide(DurableEngineState.layerMemory),
    Effect.provide(TestClock.layer())
  ) as Effect.Effect<
    A,
    E,
    Exclude<
      R,
      DurableWriter | Journal.Journal | RunStore.RunStore | DurableEngineState.DurableEngineState | Scope.Scope
    >
  >

const state = (executionId: string) =>
  JSON.stringify({ version: 1, flowName: CascadeFlow._tag, payload: {}, executionId })

/**
 * Materializes a linked run family in durable state only: rows plus
 * `flows_run_parents` edges, no live instance anywhere.
 *
 *   parent ─┬─ childA ── grandchild
 *           └─ childB
 *   unrelated (no edge)
 */
const seedFamily = (
  store: RunStore.Service,
  engineState: DurableEngineState.Service,
  parentId: string
) =>
  Effect.gen(function*() {
    const childA = `${parentId}-child-a`
    const childB = `${parentId}-child-b`
    const grandchild = `${parentId}-grandchild`
    const unrelated = `${parentId}-unrelated`
    for (const runId of [childA, childB, grandchild, unrelated]) {
      yield* store.create(runId, state(runId))
    }
    yield* engineState.recordRunParent(childA, parentId)
    yield* engineState.recordRunParent(childB, parentId)
    yield* engineState.recordRunParent(grandchild, childA)
    return { childA, childB, grandchild, unrelated }
  })

describe("cancellation cascades to linked children", () => {
  it.effect("a cancel observed from durable state reaches every transitive child", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provide(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const engineState = yield* DurableEngineState.DurableEngineState
        const driver = yield* makeDriver("owner")
        const family = yield* seedFamily(store, engineState, "cascade-observed")

        const started = yield* Latch.make(false)
        yield* driver.register(CascadeFlow, () => Latch.open(started).pipe(Effect.andThen(Effect.never)))
        const fiber = yield* driver.execute(CascadeFlow, {
          executionId: "cascade-observed",
          payload: {},
          discard: true
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Latch.await(started)

        // Another process durably requests cancellation of the parent only. No
        // in-process interrupt is issued, so `FlowInstance.interrupted` is never
        // set and the `FlowEngine.make` parent link cannot fire.
        const nowMs = yield* Clock.currentTimeMillis
        yield* store.requestCancel("cascade-observed", nowMs)
        yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval) * 2)
        yield* Fiber.join(fiber)

        const rows = yield* Effect.forEach(
          ["cascade-observed", family.childA, family.childB, family.grandchild, family.unrelated],
          (runId) => store.get(runId)
        )
        return { rows, family }
      })))

      const [parent, childA, childB, grandchild, unrelated] = result.rows
      expect(parent!.status).toBe("cancelled")
      expect(childA!.cancelRequestedAtMs).not.toBeNull()
      expect(childB!.cancelRequestedAtMs).not.toBeNull()
      // Transitive: a grandchild is linked through `childA`, not to the parent.
      expect(grandchild!.cancelRequestedAtMs).not.toBeNull()
      // A run with no edge to the cancelled family is untouched.
      expect(unrelated!.cancelRequestedAtMs).toBeNull()
    }))

  it.effect("a driver that never ran the family still cascades from its own interrupt", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provide(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const engineState = yield* DurableEngineState.DurableEngineState
        // driverA created nothing here either; the family is durable state, and
        // driverB is the separate instance an operator CLI would hold.
        const driverB = yield* makeDriver("cli")
        const family = yield* seedFamily(store, engineState, "cascade-cli")
        yield* store.create("cascade-cli", state("cascade-cli"))

        yield* driverB.interrupt(CascadeFlow, "cascade-cli")

        const rows = yield* Effect.forEach(
          ["cascade-cli", family.childA, family.childB, family.grandchild, family.unrelated],
          (runId) => store.get(runId)
        )
        return rows
      })))

      const [parent, childA, childB, grandchild, unrelated] = result
      expect(parent!.cancelRequestedAtMs).not.toBeNull()
      expect(childA!.cancelRequestedAtMs).not.toBeNull()
      expect(childB!.cancelRequestedAtMs).not.toBeNull()
      expect(grandchild!.cancelRequestedAtMs).not.toBeNull()
      expect(unrelated!.cancelRequestedAtMs).toBeNull()
    }))

  it.effect("is idempotent across repeated cancels and separate driver instances", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provide(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const engineState = yield* DurableEngineState.DurableEngineState
        const driverA = yield* makeDriver("a")
        const driverB = yield* makeDriver("b")
        const family = yield* seedFamily(store, engineState, "cascade-idempotent")
        yield* store.create("cascade-idempotent", state("cascade-idempotent"))

        yield* driverA.interrupt(CascadeFlow, "cascade-idempotent")
        const first = yield* Effect.forEach(
          [family.childA, family.childB, family.grandchild],
          (runId) => store.get(runId).pipe(Effect.map((row) => row.cancelRequestedAtMs))
        )
        // Time moves on, so a second cascade that re-wrote the column would be
        // visible as a different timestamp rather than hidden behind equality.
        yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
        yield* driverA.interrupt(CascadeFlow, "cascade-idempotent")
        yield* driverB.interrupt(CascadeFlow, "cascade-idempotent")
        const second = yield* Effect.forEach(
          [family.childA, family.childB, family.grandchild],
          (runId) => store.get(runId).pipe(Effect.map((row) => row.cancelRequestedAtMs))
        )
        return { first, second }
      })))

      expect(result.first.every((value) => value !== null)).toBe(true)
      // First-writer-wins: three more cascades changed nothing.
      expect(result.second).toEqual(result.first)
    }))

  it.effect("a parent that completes normally ends its attached children and spares a detached one", () =>
    Effect.gen(function*() {
      // The difference between the two paths is who may opt out. A CANCELLED
      // parent cascades to every linked descendant: the operator asked for the
      // subtree to stop, and no child overrides that. A parent that ends on its
      // own terms applies each child's own `onParentExit`, so a fire-and-forget
      // spawn outlives it and an attached child does not.
      const result = yield* withCrypto(provide(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const engineState = yield* DurableEngineState.DurableEngineState
        const driver = yield* makeDriver("complete")
        const family = yield* seedFamily(store, engineState, "cascade-complete")
        yield* store.create(
          "cascade-complete-detached",
          JSON.stringify({
            version: 1,
            flowName: CascadeFlow._tag,
            payload: {},
            parentExecutionId: "cascade-complete",
            onParentExit: "detach"
          })
        )
        yield* engineState.recordRunParent("cascade-complete-detached", "cascade-complete")

        yield* driver.register(CascadeFlow, () => Effect.succeed("done"))
        yield* driver.execute(CascadeFlow, {
          executionId: "cascade-complete",
          payload: {},
          discard: true
        })

        const rows = yield* Effect.forEach(
          [
            "cascade-complete",
            family.childA,
            family.childB,
            family.grandchild,
            "cascade-complete-detached",
            family.unrelated
          ],
          (runId) => store.get(runId)
        )
        return rows
      })))

      const [parent, childA, childB, grandchild, detached, unrelated] = result
      expect(parent!.status).toBe("completed")
      // Attached, so they end with the run that was waiting for them —
      // transitively, over the same durable edge table the cascade walks.
      expect(childA!.cancelRequestedAtMs).not.toBeNull()
      expect(childB!.cancelRequestedAtMs).not.toBeNull()
      expect(grandchild!.cancelRequestedAtMs).not.toBeNull()
      expect(detached!.cancelRequestedAtMs).toBeNull()
      expect(unrelated!.cancelRequestedAtMs).toBeNull()
    }))
})

describe("cancelling a parked flow closes its retained scope", () => {
  /**
   * Parks the flow with a flow-scope finalizer registered, then cancels it.
   *
   * The body suspends through `Flow.suspend`, which is the settlement
   * `Flow.intoResult` keeps the scope open for. `Flow.addFinalizer` registers
   * on that same scope, so the finalizer is exactly the resource a parked
   * cancel has to release.
   */
  const parkThenCancel = (
    executionId: string,
    cancel: (
      driver: RunDriver.Service,
      store: RunStore.Service
    ) => Effect.Effect<unknown, unknown>
  ) =>
    provide(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const driver = yield* makeDriver(executionId)
      const finalized: Array<string> = []
      yield* driver.register(
        CascadeFlow,
        () =>
          Effect.gen(function*() {
            const instance = yield* FlowRuntime.FlowInstance
            yield* Flow.addFinalizer(() => Effect.sync(() => finalized.push(executionId)))
            return yield* Flow.suspend(instance)
          }) as never
      )
      yield* driver.execute(CascadeFlow, { executionId, payload: {}, discard: true })
      const parked = yield* store.get(executionId)
      const retainedWhileParked = yield* driver.retainedRuns
      const finalizedWhileParked = [...finalized]

      yield* cancel(driver, store)
      yield* TestDatabase.until(
        TestClock.adjust(Ownership.heartbeatInterval).pipe(
          Effect.andThen(
            store.get(executionId).pipe(Effect.map((row) => row.status === "cancelled" && finalized.length === 1))
          )
        )
      )
      yield* TestDatabase.until(driver.retainedRuns.pipe(Effect.map((runs) => runs.size === 0)))

      return {
        parkedStatus: parked.status,
        retainedWhileParked: [...retainedWhileParked],
        finalizedWhileParked,
        finalized,
        retainedAfterCancel: [...(yield* driver.retainedRuns)],
        row: yield* store.get(executionId)
      }
    }))

  it.effect("runs the parked finalizer exactly once and retains no scope afterwards", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(parkThenCancel("parked-finalizer", (driver) =>
        Effect.gen(function*() {
          yield* driver.interrupt(CascadeFlow, "parked-finalizer")
          // The parked-run sweep wakes the cancel-requested row; the
          // re-activation guard then closes it.
          for (let index = 0; index < 5; index++) {
            yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
            yield* Effect.yieldNow
          }
        })))

      expect(result.parkedStatus).toBe("suspended")
      // While parked the scope is held — that is the behaviour `intoResult`
      // asks for — but it is held by a named owner, not orphaned.
      expect(result.retainedWhileParked).toEqual(["parked-finalizer"])
      expect(result.finalizedWhileParked).toEqual([])
      expect(result.row.status).toBe("cancelled")
      // Exactly once, and nothing retained: no leak, no double-finalize.
      expect(result.finalized).toEqual(["parked-finalizer"])
      expect(result.retainedAfterCancel).toEqual([])
    }))

  it.effect("continues cancellation after a parked finalizer defects and releases its retained scope once", () =>
    Effect.gen(function*() {
      let finalizerCalls = 0
      const result = yield* withCrypto(provide(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver("parked-defective-finalizer")
        yield* driver.register(
          CascadeFlow,
          () =>
            Effect.gen(function*() {
              const instance = yield* FlowRuntime.FlowInstance
              yield* Flow.addFinalizer(() =>
                Effect.sync(() => finalizerCalls += 1).pipe(
                  Effect.andThen(Effect.die(new Error("finalizer failed")))
                )
              )
              return yield* Flow.suspend(instance)
            }) as never
        )
        yield* driver.execute(CascadeFlow, {
          executionId: "parked-defective-finalizer",
          payload: {},
          discard: true
        })

        yield* driver.interrupt(CascadeFlow, "parked-defective-finalizer")
        for (let index = 0; index < 5; index++) {
          yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
          yield* Effect.yieldNow
        }
        yield* TestDatabase.until(
          TestClock.adjust(Ownership.heartbeatInterval).pipe(
            Effect.andThen(
              store.get("parked-defective-finalizer").pipe(Effect.map((row) => row.status === "cancelled"))
            )
          )
        )
        yield* TestDatabase.until(driver.retainedRuns.pipe(Effect.map((runs) => runs.size === 0)))
        return {
          retained: [...(yield* driver.retainedRuns)],
          row: yield* store.get("parked-defective-finalizer")
        }
      })))

      expect(result.row.status).toBe("cancelled")
      expect(result.retained).toEqual([])
      expect(finalizerCalls).toBe(1)
    }))

  it.effect("releases the scope for a cancel that only ever existed in durable state", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(parkThenCancel("parked-cross-process", (_driver, store) =>
        Effect.gen(function*() {
          // No `driver.interrupt`: the request is written the way another
          // process writes it, and only the sweep + activation guard deliver it.
          const nowMs = yield* Clock.currentTimeMillis
          yield* store.requestCancel("parked-cross-process", nowMs)
          for (let index = 0; index < 5; index++) {
            yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
            yield* Effect.yieldNow
          }
        })))

      expect(result.row.status).toBe("cancelled")
      expect(result.finalized).toEqual(["parked-cross-process"])
      expect(result.retainedAfterCancel).toEqual([])
    }))

  it.effect("closes a superseded parked scope when the run is re-driven instead", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provide(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver("resume")
        const finalized: Array<string> = []
        let round = 0
        yield* driver.register(
          CascadeFlow,
          () =>
            Effect.gen(function*() {
              const instance = yield* FlowRuntime.FlowInstance
              round += 1
              const ordinal = round
              yield* Flow.addFinalizer(() => Effect.sync(() => finalized.push(`round-${ordinal}`)))
              if (ordinal === 1) return yield* Flow.suspend(instance)
              return "done"
            }) as never
        )
        yield* driver.execute(CascadeFlow, { executionId: "resume-supersede", payload: {}, discard: true })
        const retainedWhileParked = [...(yield* driver.retainedRuns)]
        yield* driver.resume(CascadeFlow, "resume-supersede")
        return {
          retainedWhileParked,
          finalized,
          retainedAfterResume: [...(yield* driver.retainedRuns)],
          row: yield* store.get("resume-supersede")
        }
      })))

      expect(result.retainedWhileParked).toEqual(["resume-supersede"])
      expect(result.row.status).toBe("completed")
      // Round 1's superseded scope is released, and round 2 closed its own the
      // ordinary way. Neither is finalized twice.
      expect(result.finalized.filter((entry) => entry === "round-1")).toHaveLength(1)
      expect(result.finalized.filter((entry) => entry === "round-2")).toHaveLength(1)
      expect(result.retainedAfterResume).toEqual([])
    }))

  it.effect("releases every still-parked scope when the driver scope closes", () =>
    Effect.gen(function*() {
      const finalized: Array<string> = []
      yield* withCrypto(provide(Effect.gen(function*() {
        const driver = yield* makeDriver("shutdown")
        yield* driver.register(
          CascadeFlow,
          () =>
            Effect.gen(function*() {
              const instance = yield* FlowRuntime.FlowInstance
              yield* Flow.addFinalizer(() => Effect.sync(() => finalized.push("shutdown")))
              return yield* Flow.suspend(instance)
            }) as never
        )
        yield* driver.execute(CascadeFlow, { executionId: "shutdown-park", payload: {}, discard: true })
        expect([...(yield* driver.retainedRuns)]).toEqual(["shutdown-park"])
      })))

      // The driver's own scope closed with the test's `Effect.scoped`, so the
      // parked scope was released rather than stranded for the process lifetime.
      expect(finalized).toEqual(["shutdown"])
    }))
})

describe("interrupt reports a cancellation it could not record", () => {
  it.effect("fails with CancelRequestFailed and cascades to nothing", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provide(Effect.gen(function*() {
        const base = yield* RunStore.RunStore
        const engineState = yield* DurableEngineState.DurableEngineState
        const broken = RunStore.makeNoop({
          ...base,
          requestCancel: (runId) =>
            runId === "cancel-write-fails"
              ? Effect.fail(
                new RunStore.RunStoreError({
                  code: "persistence_failed",
                  method: "requestCancel",
                  message: "disk is on fire",
                  cause: undefined
                })
              )
              : base.requestCancel(runId, 0)
        })
        const driver = yield* makeDriver("broken").pipe(Effect.provideService(RunStore.RunStore, broken))
        const family = yield* seedFamily(base, engineState, "cancel-write-fails")
        yield* base.create("cancel-write-fails", state("cancel-write-fails"))

        const reported = yield* Effect.exit(driver.interrupt(CascadeFlow, "cancel-write-fails"))
        return {
          reported,
          children: yield* Effect.forEach(
            [family.childA, family.childB, family.grandchild],
            (runId) => base.get(runId).pipe(Effect.map((row) => row.cancelRequestedAtMs))
          )
        }
      })))

      expect(Exit.isFailure(result.reported)).toBe(true)
      const failure = Cause.squash((result.reported as Exit.Failure<void, never>).cause)
      expect(failure).toBeInstanceOf(FlowRuntime.CancelRequestFailed)
      expect((failure as FlowRuntime.CancelRequestFailed).reason).toContain("disk is on fire")
      // The parent was never cancelled, so cancelling its children would be a
      // lie in the other direction.
      expect(result.children).toEqual([null, null, null])
    }))
})
