import { executeUntilParked } from "./ExecuteUntilParked.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Pins issue #27: a durable cancel request against a suspended (parked) run
 * must actually be delivered. The driver's cancel poll only exists while an
 * owner drives the flow, so a parked run needs (a) a sweeper that observes
 * `cancel_requested_at_ms` and wakes the run, and (b) a cancel guard on the
 * re-activation transition so a resumed cancel-requested run cancels instead
 * of re-executing flow side effects.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({ commitId: "cancel-parked-snapshot" as never, changeId: "cancel-parked-snapshot" as never }),
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
  | TestClock.TestClock
  | Crypto.Crypto
  | Scope.Scope

const withEngine = <A, E>(
  body: (
    engine: FlowRuntime.FlowRuntime["Service"],
    store: RunStore.Service,
    state: DurableEngineState.Service
  ) => Effect.Effect<A, E, Services>
) => {
  const state = DurableEngineState.makeMemory()
  return withCrypto(
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const engine = (yield* EngineStore.make({
          owner: { hostId: "cancel-parked-host" },
          journalSource: "cancel-parked-test",
          isAlive: () => Effect.succeed(false)
        })) as FlowRuntime.FlowRuntime["Service"]
        return yield* body(engine, store, state)
      }).pipe(
        Effect.provideService(DurableEngineState.DurableEngineState, state),
        Effect.provideService(Jj.Jj, jj)
      )
    ).pipe(
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layer()),
      Effect.provide(TestClock.layer())
    )
  )
}

describe("cancel requests reach parked runs (issue #27)", () => {
  it.effect("the sweeper cancels a run parked on a deferred that never completes", () =>
    Effect.gen(function*() {
      const EventFlow = Flow.make("CancelParked/Sweep", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const gate = DurableDeferred.make("cancel-parked-gate", { success: Schema.String })

      const result = yield* withEngine((engine, store, state) =>
        Effect.gen(function*() {
          yield* engine.register(
            EventFlow,
            () => Effect.map(DurableDeferred.await(gate), (value) => `gated:${value}`)
          )
          yield* executeUntilParked(engine, EventFlow, {
            executionId: "cancel-parked-sweep",
            payload: {},
            discard: true
          })
          const suspended = yield* store.get("cancel-parked-sweep")

          // A second process (the CLI) durably requests cancellation. Nothing
          // owns the run and its deferred never completes.
          const nowMs = yield* Clock.currentTimeMillis
          yield* store.requestCancel("cancel-parked-sweep", nowMs)

          let row = yield* store.get("cancel-parked-sweep")
          for (let i = 0; i < 2000 && row.status !== "cancelled"; i++) {
            yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
            yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
            row = yield* store.get("cancel-parked-sweep")
          }
          // Issue #28: a terminally cancelled run must not keep a live-looking
          // waiting row a sweeper would perpetually re-poke.
          const waitingAfterCancel = yield* state.waiting("cancel-parked-sweep")
          const sweepAfterCancel = yield* state.waitingRuns()
          return { suspendedStatus: suspended.status, row, waitingAfterCancel, sweepAfterCancel }
        })
      )

      expect(result.suspendedStatus).toBe("suspended")
      expect(result.row.status).toBe("cancelled")
      expect(result.row.owner).toBeNull()
      expect(result.waitingAfterCancel._tag).toBe("None")
      expect(result.sweepAfterCancel).toEqual([])
    }))

  it.effect("a resumed cancel-requested run cancels without re-executing flow side effects", () =>
    Effect.gen(function*() {
      const EventFlow = Flow.make("CancelParked/Resume", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const gate = DurableDeferred.make("cancel-resume-gate", { success: Schema.String })
      let bodyRuns = 0

      const result = yield* withEngine((engine, store) =>
        Effect.gen(function*() {
          yield* engine.register(
            EventFlow,
            () =>
              Effect.sync(() => {
                bodyRuns += 1
              }).pipe(
                Effect.andThen(Effect.map(DurableDeferred.await(gate), (value) => `gated:${value}`))
              )
          )
          yield* executeUntilParked(engine, EventFlow, {
            executionId: "cancel-parked-resume",
            payload: {},
            discard: true
          })
          const runsAfterSuspend = bodyRuns

          const nowMs = yield* Clock.currentTimeMillis
          yield* store.requestCancel("cancel-parked-resume", nowMs)

          // An unrelated resume arrives (operator poke). The activation guard
          // must observe the pending cancel before the flow body re-runs.
          yield* executeUntilParked(engine, EventFlow, {
            executionId: "cancel-parked-resume",
            payload: {},
            discard: true
          }, ["cancelled"])
          const row = yield* store.get("cancel-parked-resume")
          return { runsAfterSuspend, bodyRuns, row }
        })
      )

      expect(result.runsAfterSuspend).toBe(1)
      expect(result.bodyRuns).toBe(1)
      expect(result.row.status).toBe("cancelled")
    }))
})
