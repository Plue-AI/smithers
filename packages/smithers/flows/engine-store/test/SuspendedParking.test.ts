import { executeUntilParked } from "./ExecuteUntilParked.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Pins issue #12: a run that actually suspends through the execution path
 * must park — populating `waiting_reason`/`waiting_wake_at_ms` so
 * `waitingRuns` sweepers can find it — and a resume must wake it.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableClock, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "parking-snapshot" as never, changeId: "parking-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

type Services =
  | Layer.Success<ReturnType<typeof TestStores.layer>>
  | StepBoundary.Service
  | DurableEngineState.DurableEngineState
  | Jj.Jj
  | Crypto.Crypto
  | Scope.Scope

const withEngine = <A, E>(
  state: DurableEngineState.Service,
  body: (
    makeEngine: Effect.Effect<unknown, never, Services>,
    store: RunStore.Service
  ) => Effect.Effect<A, E, Services>
) =>
  withCrypto(
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const makeEngine = EngineStore.make({
          owner: { hostId: "parking-host" },
          journalSource: "parking-test",
          isAlive: () => Effect.succeed(false)
        })
        return yield* body(makeEngine, store)
      }).pipe(
        Effect.provideService(DurableEngineState.DurableEngineState, state),
        Effect.provideService(Jj.Jj, jj)
      )
    ).pipe(
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layer())
    )
  )

describe("suspended runs park with a waiting reason", () => {
  it.effect("a flow suspending on a deferred parks with reason 'event' and wakes on resume", () =>
    Effect.gen(function*() {
      const EventFlow = Flow.make("Parking/Event", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const gate = DurableDeferred.make("parking-gate", { success: Schema.String })
      const handler = () => Effect.map(DurableDeferred.await(gate), (value) => `gated:${value}`)
      const state = DurableEngineState.makeMemory()

      const result = yield* withEngine(state, (makeEngine, store) =>
        Effect.gen(function*() {
          const engine = (yield* makeEngine) as FlowRuntime.FlowRuntime["Service"]
          yield* engine.register(EventFlow, handler)
          yield* executeUntilParked(engine, EventFlow, {
            executionId: "parking-event",
            payload: {},
            discard: true
          })
          const suspendedRow = yield* store.get("parking-event")
          const parked = yield* state.waiting("parking-event")
          const sweep = yield* state.waitingRuns({ reason: "event" })

          yield* engine.deferredDone(gate, {
            flowName: EventFlow._tag,
            executionId: "parking-event",
            deferredName: gate.name,
            exit: Exit.succeed("open")
          })
          yield* executeUntilParked(engine, EventFlow, {
            executionId: "parking-event",
            payload: {},
            discard: true
          }, ["completed"])
          const completedRow = yield* store.get("parking-event")
          const afterResume = yield* state.waiting("parking-event")
          return { suspendedRow, parked, sweep, completedRow, afterResume }
        }))

      expect(result.suspendedRow.status).toBe("suspended")
      expect(Option.getOrThrow(result.parked).reason).toBe("event")
      expect(result.sweep.map((row) => row.runId)).toContain("parking-event")
      expect(result.completedRow.status).toBe("completed")
      expect(Option.isNone(result.afterResume)).toBe(true)
    }))

  it.effect("a flow suspending on a durable clock parks with reason 'timer' and its wake deadline", () =>
    Effect.gen(function*() {
      const TimerFlow = Flow.make("Parking/Timer", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const handler = () =>
        DurableClock.sleep({ name: "parking-timer", duration: "5 minutes" }).pipe(
          Effect.as("slept")
        )
      const state = DurableEngineState.makeMemory()

      const result = yield* withEngine(state, (makeEngine, store) =>
        Effect.gen(function*() {
          const engine = (yield* makeEngine) as FlowRuntime.FlowRuntime["Service"]
          yield* engine.register(TimerFlow, handler)
          yield* executeUntilParked(engine, TimerFlow, {
            executionId: "parking-timer",
            payload: {},
            discard: true
          })
          const suspendedRow = yield* store.get("parking-timer")
          const parked = yield* state.waiting("parking-timer")
          const clocks = yield* state.dueClocks(Number.MAX_SAFE_INTEGER)
          return { suspendedRow, parked, clocks }
        }))

      expect(result.suspendedRow.status).toBe("suspended")
      const row = Option.getOrThrow(result.parked)
      expect(row.reason).toBe("timer")
      expect(row.wakeAt).toBe(
        result.clocks.find((clock) => clock.executionId === "parking-timer")!.dueAtMs
      )
    }))
})
