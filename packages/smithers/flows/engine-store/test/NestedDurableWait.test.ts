import { executeUntilParked } from "./ExecuteUntilParked.ts"
/**
 * A durable wait taken from inside an action, on the run's own instance.
 *
 * `SuspendedParking` proves the flow-body case: a handler that calls
 * `DurableClock.sleep` or awaits a `DurableDeferred` directly parks and wakes.
 * The nested case is the one every harness cell call takes — each `ctx.call` is
 * an action, and the flow binding it dispatches is handed the *run's* context,
 * so the wait it arms runs one dispatch below the flow body under the same
 * `FlowInstance`.
 *
 * Both waiting vocabularies land on one strand: `DurableClock.sleep`,
 * `DurableQueue.take` and `WaitFor` — the wait an approval or a signal parks on
 * — all await a `DurableDeferred`, which is the only place a flow suspension is
 * raised. These cases take the strand under all three wake sources — the timer,
 * the delivered signal, and the approval an operator answers — so a fix that
 * only closed the clock path would fail here. The approval case also proves the
 * waiting declaration reaches the row: a park a reason sweep cannot find is a
 * park nobody can answer.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, DurableClock, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { RunStore } from "@smthrs/run-store"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({ commitId: "nested-wait-snapshot" as never, changeId: "nested-wait-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

// Delivery acknowledges a durable signal and schedules a resume. Completion
// is observed separately, so this also detects a signal that never wakes its run.
const completed = (store: RunStore.Service, runId: string) =>
  Effect.gen(function*() {
    let row = yield* store.get(runId)
    for (let attempt = 0; attempt < 2000 && row.status !== "completed"; attempt++) {
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
      yield* TestClock.adjust("10 millis")
      row = yield* store.get(runId)
    }
    expect(row.status).toBe("completed")
    return row
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
          owner: { hostId: "nested-wait-host" },
          journalSource: "nested-wait-test",
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

describe("a durable wait taken inside an action, under the run's own instance", () => {
  it.effect("parks under the timer the nested action armed", () =>
    Effect.gen(function*() {
      const NestedFlow = Flow.make("Parking/NestedTimer", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      // The context a flow binding captures and hands back to its handler: the
      // run's own instance, which is what makes the wait's action region nest
      // inside the dispatch's rather than sit beside it.
      const handler = () =>
        Effect.gen(function*() {
          const services = yield* Effect.context<FlowRuntime.FlowInstance>()
          return yield* Action.make({
            name: "nested/wait",
            success: Schema.String,
            tier: "irreversible",
            idempotencyKey: "nested-wait-key",
            execute: Effect.as(
              Effect.provide(
                DurableClock.sleep({ name: "nested-timer", duration: "5 minutes" }),
                services
              ),
              "slept"
            )
          })
        })
      const state = DurableEngineState.makeMemory()

      const result = yield* withEngine(state, (makeEngine, store) =>
        Effect.gen(function*() {
          const engine = (yield* makeEngine) as FlowRuntime.FlowRuntime["Service"]
          yield* engine.register(NestedFlow, handler)
          yield* executeUntilParked(engine, NestedFlow, {
            executionId: "parking-nested",
            payload: {},
            discard: true
          })
          const suspendedRow = yield* store.get("parking-nested")
          const parked = yield* state.waiting("parking-nested")
          return { suspendedRow, parked }
        }))

      expect(result.suspendedRow.status).toBe("suspended")
      expect(Option.getOrThrow(result.parked).reason).toBe("timer")
    }))

  it.effect.each([false, true])(
    "completes a nested signal after delivery (restart=%s)",
    (restart) =>
      Effect.gen(function*() {
        // The approval and signal shape: a `DurableDeferred` awaited from inside a
        // dispatch, resolved by whoever answers the question.
        const SignalFlow = Flow.make("Parking/NestedSignal", {
          payload: {},
          success: Schema.String,
          body: opaqueHandlerBody
        })
        const gate = DurableDeferred.make("nested-signal-gate", { success: Schema.String })
        const handler = () =>
          Effect.gen(function*() {
            const services = yield* Effect.context<FlowRuntime.FlowInstance>()
            return yield* Action.make({
              name: "nested/ask",
              success: Schema.String,
              tier: "irreversible",
              idempotencyKey: "nested-ask-key",
              execute: Effect.provide(DurableDeferred.await(gate), services)
            })
          })
        const state = DurableEngineState.makeMemory()

        const result = yield* withEngine(state, (makeEngine, store) =>
          Effect.gen(function*() {
            const firstScope = yield* Scope.make()
            let engine =
              (yield* makeEngine.pipe(Effect.provideService(Scope.Scope, firstScope))) as FlowRuntime.FlowRuntime[
                "Service"
              ]
            yield* engine.register(SignalFlow, handler)
            yield* executeUntilParked(engine, SignalFlow, {
              executionId: "parking-signal",
              payload: {},
              discard: true
            })
            const suspendedRow = yield* store.get("parking-signal")
            const parked = yield* state.waiting("parking-signal")

            if (restart) {
              yield* Scope.close(firstScope, Exit.void)
              engine = (yield* makeEngine) as FlowRuntime.FlowRuntime["Service"]
              yield* engine.register(SignalFlow, handler)
            }

            yield* engine.deferredDone(gate, {
              flowName: SignalFlow._tag,
              executionId: "parking-signal",
              deferredName: gate.name,
              exit: Exit.succeed("approved")
            })
            const completedRow = yield* completed(store, "parking-signal")
            const afterResume = yield* state.waiting("parking-signal")
            if (!restart) yield* Scope.close(firstScope, Exit.void)
            return { suspendedRow, parked, completedRow, afterResume }
          }))

        expect(result.suspendedRow.status).toBe("suspended")
        expect(Option.getOrThrow(result.parked).reason).toBe("event")
        expect(result.completedRow.status).toBe("completed")
        expect(Option.isNone(result.afterResume)).toBe(true)
      })
  )

  it.effect("parks a nested approval under the reason and token the wait declared", () =>
    Effect.gen(function*() {
      // The third wake source, and the one an operator sweeps for. `WaitFor`'s
      // implementation is exactly this — `annotateWaiting({ reason })` and then
      // a `DurableDeferred.await` — so a nested `WaitFor.action.call` is this
      // shape with the declaration written on the run's own instance. Without
      // the enclosing-region exemption the round never ends, so the row is
      // never parked and `waitingRuns({ reason: "approval" })` never sees it:
      // an approval that no sweep can find is an approval nobody can answer.
      const ApprovalFlow = Flow.make("Parking/NestedApproval", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const gate = DurableDeferred.make("nested-approval-gate", { success: Schema.String })
      const handler = () =>
        Effect.gen(function*() {
          const services = yield* Effect.context<FlowRuntime.FlowInstance>()
          return yield* Action.make({
            name: "nested/approve",
            success: Schema.String,
            tier: "irreversible",
            idempotencyKey: "nested-approve-key",
            execute: Effect.provide(
              Effect.gen(function*() {
                yield* FlowRuntime.annotateWaiting({ reason: "approval", token: "nested-request-7" })
                return yield* DurableDeferred.await(gate)
              }),
              services
            )
          })
        })
      const state = DurableEngineState.makeMemory()

      const result = yield* withEngine(state, (makeEngine, store) =>
        Effect.gen(function*() {
          const engine = (yield* makeEngine) as FlowRuntime.FlowRuntime["Service"]
          yield* engine.register(ApprovalFlow, handler)
          yield* executeUntilParked(engine, ApprovalFlow, {
            executionId: "parking-approval",
            payload: {},
            discard: true
          })
          const suspendedRow = yield* store.get("parking-approval")
          const parked = yield* state.waiting("parking-approval")
          const sweep = yield* state.waitingRuns({ reason: "approval" })

          yield* engine.deferredDone(gate, {
            flowName: ApprovalFlow._tag,
            executionId: "parking-approval",
            deferredName: gate.name,
            exit: Exit.succeed("granted")
          })
          const completedRow = yield* completed(store, "parking-approval")
          const afterResume = yield* state.waiting("parking-approval")
          return { suspendedRow, parked, sweep, completedRow, afterResume }
        }))

      expect(result.suspendedRow.status).toBe("suspended")
      expect(Option.getOrThrow(result.parked).reason).toBe("approval")
      expect(Option.getOrThrow(result.parked).token).toBe("nested-request-7")
      expect(result.sweep.map((row) => row.runId)).toEqual(["parking-approval"])
      expect(result.completedRow.status).toBe("completed")
      expect(Option.isNone(result.afterResume)).toBe(true)
    }))
})
