import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Pins issue #44: the parked-run cancel sweeper (the issue #27 delivery
 * mechanism) must survive a transient defect from `waitingRuns()` — e.g. a
 * `SQLITE_BUSY` escaping the SQL implementation's `orDie` — instead of dying
 * silently for the rest of the process lifetime. The sweep gets the same
 * sandbox-and-log hardening `armClock` received.
 */
import { describe, expect, it } from "@effect/vitest"
// The mocks API has to come straight from vitest; re-exported it does not
// resolve against vitest's hoisting plugin.
import { DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { vi } from "vitest"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

/**
 * Arms the coordinator-wake failure injection for issue #70: while positive,
 * every `RunCoordinator.wake` dies with a defect (decrementing the budget).
 * Zero (the default) leaves the real coordinator untouched, so the existing
 * `waitingRuns`-defect test is unaffected.
 */
const wakeFailures = vi.hoisted(() => ({ budget: 0 }))

vi.mock("../src/internal/RunCoordinator.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/internal/RunCoordinator.ts")>()
  return {
    ...actual,
    make: (options: never) =>
      (actual.make(options) as unknown as Effect.Effect<
        { wake: (key: unknown) => Effect.Effect<void> },
        never,
        Scope.Scope
      >).pipe(
        Effect.map((coordinator) => ({
          ...coordinator,
          wake: (key: unknown) =>
            Effect.suspend(() =>
              wakeFailures.budget-- > 0
                ? Effect.die(new Error("injected coordinator.wake defect"))
                : coordinator.wake(key)
            )
        }))
      )
  }
})
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({
      commitId: "sweeper-resilience-snapshot" as never,
      changeId: "sweeper-resilience-snapshot" as never
    }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

describe("the cancel sweeper survives transient defects (issue #44)", () => {
  it.effect("delivers a parked cancel after waitingRuns defects once with SQLITE_BUSY", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      // A transiently busy database: the first sweep poll escapes as a defect,
      // exactly like the SQL implementation's `orDie` on a `SQLITE_BUSY`.
      let busyPolls = 1
      const flakyState: DurableEngineState.Service = {
        ...state,
        waitingRuns: (options) =>
          busyPolls-- > 0
            ? Effect.die(new Error("SQLITE_BUSY: database is locked"))
            : state.waitingRuns(options)
      }

      const EventFlow = Flow.make("SweeperResilience/Cancel", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const gate = DurableDeferred.make("sweeper-resilience-gate", { success: Schema.String })

      const result = yield* withCrypto(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* RunStore.RunStore
            const engine = (yield* EngineStore.make({
              owner: { hostId: "sweeper-resilience-host" },
              journalSource: "sweeper-resilience-test",
              isAlive: () => Effect.succeed(false)
            })) as FlowRuntime.FlowRuntime["Service"]

            yield* engine.register(
              EventFlow,
              () => Effect.map(DurableDeferred.await(gate), (value) => `gated:${value}`)
            )
            const caller = yield* engine.execute(EventFlow, {
              executionId: "sweeper-resilience-cancel",
              payload: {},
              discard: false
            }).pipe(Effect.forkChild)
            for (let attempt = 0; attempt < 1_000; attempt++) {
              const observed = yield* store.get("sweeper-resilience-cancel").pipe(Effect.option)
              if (Option.isSome(observed) && observed.value.status === "suspended") break
              yield* Effect.yieldNow
            }
            expect((yield* store.get("sweeper-resilience-cancel")).status).toBe("suspended")
            // Stop the caller's automatic follow loop so only the recovery
            // sweeper can deliver cancellation to this parked run.
            yield* Fiber.interrupt(caller)
            const nowMs = yield* Clock.currentTimeMillis
            yield* store.requestCancel("sweeper-resilience-cancel", nowMs)

            // First tick hits the busy database and must not kill the sweeper.
            yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
            const afterBusy = yield* store.get("sweeper-resilience-cancel")

            let row = afterBusy
            for (let i = 0; i < 2000 && row.status !== "cancelled"; i++) {
              yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
              yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
              row = yield* store.get("sweeper-resilience-cancel")
            }
            return { afterBusy, row, remainingBusyPolls: busyPolls }
          }).pipe(
            Effect.provideService(DurableEngineState.DurableEngineState, flakyState),
            Effect.provideService(Jj.Jj, jj)
          )
        ).pipe(
          Effect.provide(StepBoundary.layerTest()),
          Effect.provide(TestStores.layer()),
          Effect.provide(TestClock.layer())
        )
      )

      // The defect was actually exercised…
      expect(result.remainingBusyPolls).toBeLessThanOrEqual(0)
      expect(result.afterBusy.status).toBe("suspended")
      // …and the sweeper survived it to deliver the cancel on a later tick.
      expect(result.row.status).toBe("cancelled")
      expect(result.row.owner).toBeNull()
    }))

  it.effect("delivers a parked cancel after coordinator.wake dies once with a defect (issue #70)", () =>
    Effect.gen(function*() {
      // The other defect source the #44 sandbox exists to absorb: `wake` is
      // typed `E = never`, so any failure inside it surfaces as a defect. A
      // sandbox narrowed to only the `waitingRuns` poll would let this kill
      // the sweeper for the process lifetime with the suite green.
      const EventFlow = Flow.make("SweeperResilience/WakeDefect", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const gate = DurableDeferred.make("sweeper-wake-defect-gate", { success: Schema.String })

      const result = yield* withCrypto(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* RunStore.RunStore
            const engine = (yield* EngineStore.make({
              owner: { hostId: "sweeper-wake-defect-host" },
              journalSource: "sweeper-wake-defect-test",
              isAlive: () => Effect.succeed(false)
            })) as FlowRuntime.FlowRuntime["Service"]

            yield* engine.register(
              EventFlow,
              () => Effect.map(DurableDeferred.await(gate), (value) => `gated:${value}`)
            )
            const caller = yield* engine.execute(EventFlow, {
              executionId: "sweeper-wake-defect-cancel",
              payload: {},
              discard: false
            }).pipe(Effect.forkChild)
            for (let attempt = 0; attempt < 1_000; attempt++) {
              const observed = yield* store.get("sweeper-wake-defect-cancel").pipe(Effect.option)
              if (Option.isSome(observed) && observed.value.status === "suspended") break
              yield* Effect.yieldNow
            }
            expect((yield* store.get("sweeper-wake-defect-cancel")).status).toBe("suspended")
            // Stop the caller's automatic follow loop so only the recovery
            // sweeper can deliver cancellation to this parked run.
            yield* Fiber.interrupt(caller)
            const nowMs = yield* Clock.currentTimeMillis
            yield* store.requestCancel("sweeper-wake-defect-cancel", nowMs)

            // The first sweep wake dies with a defect and must not kill the
            // sweeper.
            wakeFailures.budget = 1
            yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
            const afterDefect = yield* store.get("sweeper-wake-defect-cancel")

            let row = afterDefect
            for (let i = 0; i < 2000 && row.status !== "cancelled"; i++) {
              yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
              yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
              row = yield* store.get("sweeper-wake-defect-cancel")
            }
            return { afterDefect, row, remainingWakeFailures: wakeFailures.budget }
          }).pipe(
            Effect.provide(DurableEngineState.layerMemory),
            Effect.provideService(Jj.Jj, jj)
          )
        ).pipe(
          Effect.provide(StepBoundary.layerTest()),
          Effect.provide(TestStores.layer()),
          Effect.provide(TestClock.layer())
        )
      )

      // The wake defect was actually exercised…
      expect(result.remainingWakeFailures).toBeLessThanOrEqual(0)
      expect(result.afterDefect.status).toBe("suspended")
      // …and the sweeper survived it to deliver the cancel on a later tick.
      expect(result.row.status).toBe("cancelled")
      expect(result.row.owner).toBeNull()
    }))
})
