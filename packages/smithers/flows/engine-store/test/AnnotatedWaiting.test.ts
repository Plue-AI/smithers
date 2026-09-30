import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Pins issue #31: the production park path must be able to record `approval`
 * and `quota` waits (and the wake token), not only the derived
 * `timer`/`event` reasons. A flow declares its wait with
 * `FlowRuntime.annotateWaiting` immediately before suspending, and the driver
 * parks the run with exactly that payload so reason-specific sweeps
 * (`WHERE waiting_reason = 'approval'`) see it.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, DurableClock, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import type * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
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
  snapshot: () => Effect.succeed({ commitId: "annotated-snapshot" as never, changeId: "annotated-snapshot" as never }),
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
          owner: { hostId: "annotated-host" },
          journalSource: "annotated-test",
          isAlive: () => Effect.succeed(false)
        })) as FlowRuntime.FlowRuntime["Service"]
        return yield* body(engine, store, state)
      }).pipe(
        Effect.provideService(DurableEngineState.DurableEngineState, state),
        Effect.provideService(Jj.Jj, jj)
      )
    ).pipe(
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layer())
    )
  )
}

describe("annotated waiting reasons reach the parked row (issue #31)", () => {
  it.effect("a concurrent finishing dispatch cannot clobber a newer waiting declaration", () =>
    Effect.gen(function*() {
      const RaceFlow = Flow.make("Annotated/WaitingRace", {
        payload: {},
        success: Schema.Unknown,
        body: opaqueHandlerBody
      })
      const result = yield* withEngine((engine) =>
        Effect.gen(function*() {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const slow = Action.make({
            name: "annotated-waiting-race-slow",
            success: Schema.Void,
            execute: Effect.gen(function*() {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            })
          })
          const parked = Action.make({
            name: "annotated-waiting-race-parked",
            success: Schema.Void,
            execute: FlowRuntime.annotateWaiting({ reason: "approval", token: "winner" })
          })
          yield* engine.register(
            RaceFlow,
            () =>
              Effect.gen(function*() {
                const instance = yield* FlowRuntime.FlowInstance
                const slowFiber = yield* slow.pipe(Effect.forkChild)
                yield* Deferred.await(entered)
                yield* parked
                yield* Deferred.succeed(release, undefined)
                yield* Fiber.join(slowFiber)
                return instance.waiting
              })
          )
          return yield* engine.execute(RaceFlow, {
            executionId: "annotated-waiting-race",
            payload: {}
          })
        })
      )

      expect(result).toEqual({ reason: "approval", token: "winner" })
    }))

  it.effect("a flow awaiting an approval parks as reason 'approval' with its token", () =>
    Effect.gen(function*() {
      const ApprovalFlow = Flow.make("Annotated/Approval", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const gate = DurableDeferred.make("annotated-approval-gate", { success: Schema.String })

      const result = yield* withEngine((engine, store, state) =>
        Effect.gen(function*() {
          yield* engine.register(
            ApprovalFlow,
            () =>
              Effect.gen(function*() {
                yield* FlowRuntime.annotateWaiting({ reason: "approval", token: "request-42" })
                return yield* Effect.map(DurableDeferred.await(gate), (value) => `approved:${value}`)
              })
          )
          yield* engine.execute(ApprovalFlow, {
            executionId: "annotated-approval",
            payload: {},
            discard: true
          })
          yield* TestDatabase.until(
            store.get("annotated-approval").pipe(Effect.map((row) => row.status === "suspended"))
          )
          const parked = yield* state.waiting("annotated-approval")
          const approvalSweep = yield* state.waitingRuns({ reason: "approval" })

          // Resolving the approval wakes the run and completes it normally.
          yield* engine.deferredDone(gate, {
            flowName: ApprovalFlow._tag,
            executionId: "annotated-approval",
            deferredName: gate.name,
            exit: Exit.succeed("yes")
          })
          yield* engine.execute(ApprovalFlow, {
            executionId: "annotated-approval",
            payload: {},
            discard: true
          })
          yield* TestDatabase.until(
            store.get("annotated-approval").pipe(Effect.map((row) => row.status === "completed"))
          )
          const finished = yield* store.get("annotated-approval")
          const afterWake = yield* state.waiting("annotated-approval")
          return { parked, approvalSweep, finished, afterWake }
        })
      )

      expect(Option.isSome(result.parked)).toBe(true)
      if (Option.isSome(result.parked)) {
        expect(result.parked.value.reason).toBe("approval")
        expect(result.parked.value.token).toBe("request-42")
      }
      expect(result.approvalSweep.map((row) => row.runId)).toEqual(["annotated-approval"])
      expect(result.finished.status).toBe("completed")
      expect(Option.isNone(result.afterWake)).toBe(true)
    }))

  it.effect("an action's own declaration reaches the parked row, not the derived default", () =>
    Effect.gen(function*() {
      const GatedFlow = Flow.make("Annotated/ActionGate", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const gate = DurableDeferred.make("annotated-action-gate", { success: Schema.String })
      // The shape `WaitFor` ships: the wait is inside an ACTION, so the
      // declaration is written on the dispatch's own instance. A driver that did
      // not thread it back would park this run on the derived `event` default and
      // drop the wake token the resolver is matched against.
      const waitPoint = Action.make({
        name: "annotated-action-wait",
        success: Schema.String,
        tier: "sealed",
        idempotencyKey: "annotated-action-wait-v1",
        execute: Effect.gen(function*() {
          yield* FlowRuntime.annotateWaiting({ reason: "approval", token: "action-token-7" })
          return yield* DurableDeferred.await(gate)
        })
      })

      const result = yield* withEngine((engine, store, state) =>
        Effect.gen(function*() {
          yield* engine.register(
            GatedFlow,
            () => Effect.map(waitPoint, (value) => `approved:${value}`)
          )
          const running = yield* engine.execute(GatedFlow, {
            executionId: "annotated-action",
            payload: {},
            discard: false
          }).pipe(Effect.forkChild)
          for (let attempt = 0; attempt < 1_000; attempt++) {
            if (
              (yield* store.get("annotated-action").pipe(Effect.option)).pipe(
                Option.map((row) => row.status),
                Option.getOrUndefined
              ) === "suspended"
            ) break
            yield* Effect.yieldNow
          }
          expect((yield* store.get("annotated-action")).status).toBe("suspended")
          yield* Fiber.interrupt(running)
          const parked = yield* state.waiting("annotated-action")
          const approvalSweep = yield* state.waitingRuns({ reason: "approval" })

          yield* engine.deferredDone(gate, {
            flowName: GatedFlow._tag,
            executionId: "annotated-action",
            deferredName: gate.name,
            exit: Exit.succeed("yes")
          })
          for (let attempt = 0; attempt < 1_000; attempt++) {
            if ((yield* store.get("annotated-action")).status === "completed") break
            yield* Effect.yieldNow
          }
          yield* engine.execute(GatedFlow, { executionId: "annotated-action", payload: {}, discard: false })
          const finished = yield* store.get("annotated-action")
          const afterWake = yield* state.waiting("annotated-action")
          return { parked, approvalSweep, finished, afterWake }
        })
      )

      const parked = Option.getOrThrow(result.parked)
      expect(parked.reason).toBe("approval")
      expect(parked.token).toBe("action-token-7")
      expect(result.approvalSweep.map((row) => row.runId)).toEqual(["annotated-action"])
      expect(result.finished.status).toBe("completed")
      // The resolved wait consumes the declaration on the way out, so nothing
      // stale survives the wake.
      expect(Option.isNone(result.afterWake)).toBe(true)
    }))

  it.effect("a quota wait parks with its wake deadline", () =>
    Effect.gen(function*() {
      const QuotaFlow = Flow.make("Annotated/Quota", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const gate = DurableDeferred.make("annotated-quota-gate", { success: Schema.String })

      const result = yield* withEngine((engine, _store, state) =>
        Effect.gen(function*() {
          yield* engine.register(
            QuotaFlow,
            () =>
              Effect.gen(function*() {
                yield* FlowRuntime.annotateWaiting({ reason: "quota", wakeAt: 60_000 })
                return yield* Effect.map(DurableDeferred.await(gate), (value) => value)
              })
          )
          yield* engine.execute(QuotaFlow, {
            executionId: "annotated-quota",
            payload: {},
            discard: true
          })
          yield* TestDatabase.until(state.waiting("annotated-quota").pipe(Effect.map(Option.isSome)))
          return {
            due: yield* state.waitingRuns({ reason: "quota", dueBeforeMs: 100_000 })
          }
        })
      )

      expect(result.due).toEqual([
        { runId: "annotated-quota", reason: "quota", wakeAt: 60_000, token: null }
      ])
    }))

  it.effect("an annotation consumed by its resolved gate does not leak onto a later timer park (issue #42)", () =>
    Effect.gen(function*() {
      const TwoStageFlow = Flow.make("Annotated/TwoStage", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const gate = DurableDeferred.make("annotated-two-stage-gate", { success: Schema.String })

      const result = yield* withEngine((engine, store, state) =>
        Effect.gen(function*() {
          yield* engine.register(
            TwoStageFlow,
            () =>
              Effect.gen(function*() {
                yield* FlowRuntime.annotateWaiting({ reason: "approval", token: "request-42" })
                const approved = yield* DurableDeferred.await(gate)
                // The second suspension is timer-backed: the replayed approval
                // annotation must not classify this park.
                yield* DurableClock.sleep({
                  name: "annotated-two-stage-timer",
                  duration: "5 minutes",
                  inMemoryThreshold: "1 second"
                })
                return `approved:${approved}`
              })
          )
          yield* engine.execute(TwoStageFlow, {
            executionId: "annotated-two-stage",
            payload: {},
            discard: true
          })
          yield* TestDatabase.until(state.waiting("annotated-two-stage").pipe(Effect.map(Option.isSome)))
          const firstPark = yield* state.waiting("annotated-two-stage")

          // Resolve the approval gate; the next drive replays the annotation,
          // passes through the resolved gate, and parks on the durable timer.
          yield* engine.deferredDone(gate, {
            flowName: TwoStageFlow._tag,
            executionId: "annotated-two-stage",
            deferredName: gate.name,
            exit: Exit.succeed("yes")
          })
          yield* engine.execute(TwoStageFlow, {
            executionId: "annotated-two-stage",
            payload: {},
            discard: true
          })
          yield* TestDatabase.until(
            state.waiting("annotated-two-stage").pipe(
              Effect.map((waiting) => Option.isSome(waiting) && waiting.value.reason === "timer")
            )
          )
          const row = yield* store.get("annotated-two-stage")
          const secondPark = yield* state.waiting("annotated-two-stage")
          const timerSweep = yield* state.waitingRuns({ reason: "timer" })
          const approvalSweep = yield* state.waitingRuns({ reason: "approval" })
          return { firstPark, row, secondPark, timerSweep, approvalSweep }
        })
      )

      expect(Option.getOrThrow(result.firstPark).reason).toBe("approval")
      expect(result.row.status).toBe("suspended")
      const parked = Option.getOrThrow(result.secondPark)
      expect(parked.reason).toBe("timer")
      expect(typeof parked.wakeAt).toBe("number")
      expect(result.timerSweep.map((waiting) => waiting.runId)).toContain("annotated-two-stage")
      expect(result.approvalSweep).toEqual([])
    }))
})
