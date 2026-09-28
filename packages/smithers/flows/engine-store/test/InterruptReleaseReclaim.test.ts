import type { DurableWriter } from "@smthrs/database/DurableWriter"
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
import * as RunDriver from "../src/internal/RunDriver.ts"
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
  ) as Effect.Effect<
    A,
    E,
    Exclude<
      R,
      DurableWriter | Journal.Journal | RunStore.RunStore | DurableEngineState.DurableEngineState | Scope.Scope
    >
  >

/** Interrupts a run mid-action via driver-scope close and returns the row. */
const releaseMidAction = (executionId: string) =>
  Effect.gen(function*() {
    const driverScope = yield* Scope.make()
    const driver = yield* makeDriver("owner-1").pipe(Scope.provide(driverScope))
    const started = yield* Latch.make(false)
    yield* driver.register(TestFlow, () => Latch.open(started).pipe(Effect.andThen(Effect.never)))
    yield* driver.execute(TestFlow, {
      executionId,
      payload: {},
      discard: true
    }).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Latch.await(started)
    // Process shutdown: the scope closes and interrupts the drive fiber.
    yield* Scope.close(driverScope, Exit.void)
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
        yield* driver.execute(TestFlow, {
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
