import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { type Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import type * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { executeUntilParked } from "./ExecuteUntilParked.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "test-snapshot" as never, changeId: "test-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

/**
 * Runs `body` against two independently constructed engines that share one
 * durable state and journal: the first suspends the flow, the second is the
 * post-restart engine.
 */
type Services =
  | Layer.Success<ReturnType<typeof TestStores.layer>>
  | StepBoundary.Service
  | DurableEngineState.DurableEngineState
  | Jj.Jj
  | Crypto.Crypto
  | Scope.Scope

const withRestart = <A, E>(
  body: (
    makeEngine: Effect.Effect<FlowRuntime.FlowRuntime["Service"], never, Services>,
    store: RunStore.RunStore["Service"]
  ) => Effect.Effect<A, E, Services>
) =>
  withCrypto(
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        let previous: Scope.Closeable | undefined
        const makeEngine = Effect.gen(function*() {
          if (previous !== undefined) yield* Scope.close(previous, Exit.void)
          const scope = yield* Scope.make()
          previous = scope
          yield* Effect.addFinalizer((exit) => Scope.close(scope, exit))
          return yield* Scope.provide(
            EngineStore.make({
              owner: { hostId: "deferred-restart-host" },
              journalSource: "deferred-restart-test",
              isAlive: () => Effect.succeed(false)
            }),
            previous
          )
        })
        return yield* body(makeEngine, store)
      }).pipe(
        Effect.provideService(
          DurableEngineState.DurableEngineState,
          DurableEngineState.makeMemory()
        ),
        Effect.provideService(Jj.Jj, jj)
      )
    ).pipe(
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layer())
    )
  )

describe("durable deferred outcomes across a restart", () => {
  /**
   * Parity: Skyframe `StateMachineTest.java:335` — a dependency that fails,
   * dies, or is recovered from must behave identically after the evaluator is
   * rebuilt from persisted state.
   */
  const gate = DurableDeferred.make("restart-gate", {
    success: Schema.String,
    error: Schema.String
  })

  const scenario = (
    name: string,
    options: {
      readonly handler: (
        prefix: string
      ) => Effect.Effect<string, string, FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>
      readonly exit: Exit.Exit<string, string>
      readonly assert: (exit: Exit.Exit<string, unknown>) => void
    }
  ) =>
    it.effect(name, () =>
      Effect.gen(function*() {
        let prefixDispatches = 0
        const flow = Flow.make(`DeferredRestart/${name}`, {
          payload: {},
          success: Schema.String,
          error: Schema.String,
          body: opaqueHandlerBody
        })
        const prefix = Action.make({
          name: "prefix",
          success: Schema.String,
          tier: "sealed",
          idempotencyKey: `deferred-restart-${name}-v1`,
          execute: Effect.sync(() => {
            prefixDispatches++
            return "prefix-result"
          })
        })
        const handler = () =>
          Effect.gen(function*() {
            const value = yield* prefix
            return yield* options.handler(value)
          })

        const result = yield* withRestart((makeEngine, store) =>
          Effect.gen(function*() {
            const first = yield* makeEngine
            yield* first.register(flow, handler)
            yield* executeUntilParked(first, flow, {
              executionId: "restart-run",
              payload: {},
              discard: true
            })
            const suspended = yield* store.get("restart-run")

            const restarted = yield* makeEngine
            yield* restarted.register(flow, handler)
            yield* restarted.deferredDone(gate, {
              flowName: flow._tag,
              executionId: "restart-run",
              deferredName: gate.name,
              exit: options.exit as any
            })
            yield* TestDatabase.until(
              store.get("restart-run").pipe(
                Effect.map((row) => ["completed", "failed", "cancelled"].includes(row.status))
              )
            )
            const exit = yield* Effect.exit(
              restarted.execute(flow, {
                executionId: "restart-run",
                payload: {},
                discard: false
              })
            )
            const final = yield* store.get("restart-run")
            return { suspended, exit, final }
          })
        )

        expect(result.suspended.status).toBe("suspended")
        // the sealed prefix runs once, before the suspension, and is replayed
        // from persisted evidence by the restarted engine
        expect(prefixDispatches).toBe(1)
        options.assert(result.exit as Exit.Exit<string, unknown>)
      }))

  scenario("propagates an unhandled typed failure recorded while suspended", {
    handler: (value) => Effect.map(DurableDeferred.await(gate), (gated) => `${value}/${gated}`),
    exit: Exit.fail("gate-failed"),
    assert: (exit) => {
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBe("gate-failed")
      }
    }
  })

  scenario("lets the restarted handler recover from a typed failure", {
    handler: (value) =>
      DurableDeferred.await(gate).pipe(
        Effect.catch((error) => Effect.succeed(`recovered:${error}`)),
        Effect.map((gated) => `${value}/${gated}`)
      ),
    exit: Exit.fail("gate-failed"),
    assert: (exit) => {
      expect(exit).toStrictEqual(Exit.succeed("prefix-result/recovered:gate-failed"))
    }
  })

  scenario("propagates a defect recorded while suspended as a die cause", {
    handler: (value) => Effect.map(DurableDeferred.await(gate), (gated) => `${value}/${gated}`),
    exit: Exit.die("gate-defect") as Exit.Exit<string, string>,
    assert: (exit) => {
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(true)
      }
    }
  })

  scenario("propagates a recorded interruption as an interrupt cause", {
    handler: (value) => Effect.map(DurableDeferred.await(gate), (gated) => `${value}/${gated}`),
    exit: Exit.failCause(Cause.interrupt()) as Exit.Exit<string, string>,
    assert: (exit) => {
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true)
        expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(false)
      }
    }
  })

  scenario("succeeds from the persisted success exit without redispatching the prefix", {
    handler: (value) => Effect.map(DurableDeferred.await(gate), (gated) => `${value}/${gated}`),
    exit: Exit.succeed("gate-value"),
    assert: (exit) => {
      expect(exit).toStrictEqual(Exit.succeed("prefix-result/gate-value"))
    }
  })
})

describe("registration after a deferred was consumed", () => {
  for (const storage of ["sqlite", "memory"] as const) {
    it.effect(`does not re-drive a later approval on ${storage}`, () =>
      withCrypto(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* RunStore.RunStore
            const persisted = yield* DurableEngineState.DurableEngineState
            const state = storage === "memory" ? DurableEngineState.makeMemory() : persisted
            const journal = yield* Journal.Journal
            const gate = DurableDeferred.make("consumed-A", { success: Schema.String })
            const flow = Flow.make(`DeferredRestart/Consumed/${storage}`, {
              payload: {},
              success: Schema.String,
              body: opaqueHandlerBody
            })
            const drives: Array<string> = []
            const handler = () =>
              Effect.gen(function*() {
                const instance = yield* FlowRuntime.FlowInstance
                drives.push(instance.executionId)
                yield* DurableDeferred.await(gate)
                instance.waiting = { reason: "approval", token: "approval-B" }
                return yield* Flow.suspend(instance)
              })
            const makeEngine = EngineStore.make({
              owner: { hostId: "consumed-restart-host" },
              journalSource: "consumed-restart-test",
              isAlive: () => Effect.succeed(false)
            }).pipe(Effect.provideService(DurableEngineState.DurableEngineState, state))
            const complete = (executionId: string) =>
              state.completeDeferred({
                flowName: flow._tag,
                executionId,
                deferredName: gate.name,
                exit: Exit.succeed("ready"),
                completedAtMs: 0
              })
            yield* Effect.scoped(Effect.gen(function*() {
              const engine = yield* makeEngine
              yield* engine.register(flow, handler)
              for (const executionId of ["consumed", "unobserved"]) {
                yield* executeUntilParked(engine, flow, { executionId, payload: {}, discard: true })
              }
              yield* complete("consumed")
              // Direct state completion does not send a wake. execute can join
              // a sweep's drain that read the deferred before completion; resume
              // queues a successor and awaits it before this engine shuts down.
              yield* engine.resume(flow, "consumed")
            }))
            expect(Option.getOrThrow(yield* state.waiting("consumed")).reason).toBe("approval")
            expect(Option.getOrThrow(yield* state.waiting("unobserved")).reason).toBe("event")
            // The second completion lands with no engine listening to its wake.
            yield* complete("unobserved")
            const consumedBefore = yield* store.get("consumed")
            yield* journal.flush
            const entriesBefore = yield* journal.entries({ runId: "consumed" as never, limit: 500 })
            drives.length = 0

            const restarted = yield* makeEngine
            yield* restarted.register(flow, handler)
            // Wait for the control's wake to finish without explicitly executing
            // either run. Registration alone must recover its unobserved result.
            for (let count = 0; count < 400; count++) {
              const waiting = yield* state.waiting("unobserved")
              if (
                Option.isSome(waiting) && waiting.value.reason === "approval" &&
                (yield* store.get("unobserved")).status === "suspended"
              ) break
              yield* Effect.yieldNow
            }
            expect(Option.getOrThrow(yield* state.waiting("unobserved")).reason).toBe("approval")
            // A further registration cannot re-deliver either observed completion.
            yield* restarted.register(flow, handler)
            yield* Effect.yieldNow
            yield* journal.flush
            expect(drives).toEqual(["unobserved"])
            expect(yield* store.get("consumed")).toEqual(consumedBefore)
            expect(yield* journal.entries({ runId: "consumed" as never, limit: 500 })).toEqual(entriesBefore)
            expect(yield* state.completedDeferreds(flow._tag)).toEqual([])
            // Consumption only changes sweep eligibility, never replay evidence.
            expect(
              Option.getOrThrow(
                yield* state.deferred({
                  flowName: flow._tag,
                  executionId: "consumed",
                  deferredName: gate.name
                })
              ).exit
            ).toEqual(Exit.succeed("ready"))
          }).pipe(
            Effect.provide(StepBoundary.layerTest()),
            Effect.provideService(Jj.Jj, jj)
          )
        ).pipe(Effect.provide(TestStores.layerAt(":memory:")))
      ))
  }
})

describe("partial dependency readiness across a restart", () => {
  const first = DurableDeferred.make("partial-first", { success: Schema.String })
  const second = DurableDeferred.make("partial-second", { success: Schema.String })

  /**
   * Parity: Skyframe `ParallelEvaluatorTest.java:3442` — when only one of the
   * requested dependencies becomes available, the machine makes partial
   * progress and re-suspends on the still-outstanding one rather than
   * completing or restarting from scratch.
   */
  it.effect("resumes past the ready dependency and re-suspends on the outstanding one", () =>
    Effect.gen(function*() {
      const observed: Array<string> = []
      let prefixDispatches = 0
      const flow = Flow.make("DeferredRestart/partial", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const prefix = Action.make({
        name: "prefix",
        success: Schema.String,
        tier: "sealed",
        idempotencyKey: "deferred-partial-prefix-v1",
        execute: Effect.sync(() => {
          prefixDispatches++
          return "prefix-result"
        })
      })
      const handler = () =>
        Effect.gen(function*() {
          const base = yield* prefix
          const a = yield* DurableDeferred.await(first)
          observed.push(`first:${a}`)
          const b = yield* DurableDeferred.await(second)
          observed.push(`second:${b}`)
          return `${base}/${a}/${b}`
        })

      const result = yield* withRestart((makeEngine, store) =>
        Effect.gen(function*() {
          const engine = yield* makeEngine
          yield* engine.register(flow, handler)
          yield* executeUntilParked(engine, flow, {
            executionId: "partial-run",
            payload: {},
            discard: true
          })
          const beforeAny = yield* store.get("partial-run")

          // only the first dependency becomes ready
          const afterFirstEngine = yield* makeEngine
          yield* afterFirstEngine.register(flow, handler)
          yield* afterFirstEngine.deferredDone(first, {
            flowName: flow._tag,
            executionId: "partial-run",
            deferredName: first.name,
            exit: Exit.succeed("a")
          })
          yield* executeUntilParked(afterFirstEngine, flow, {
            executionId: "partial-run",
            payload: {},
            discard: true
          })
          yield* TestDatabase.until(Effect.gen(function*() {
            return observed.includes("first:a") && (yield* store.get("partial-run")).status === "suspended"
          }))
          const afterFirst = yield* store.get("partial-run")

          // and only then the second one
          const finalEngine = yield* makeEngine
          yield* finalEngine.register(flow, handler)
          yield* finalEngine.deferredDone(second, {
            flowName: flow._tag,
            executionId: "partial-run",
            deferredName: second.name,
            exit: Exit.succeed("b")
          })
          const value = yield* finalEngine.execute(flow, {
            executionId: "partial-run",
            payload: {},
            discard: false
          })
          const final = yield* store.get("partial-run")

          const journal = yield* Journal.Journal
          yield* journal.flush
          const entries = yield* journal.entries({
            runId: "partial-run" as never,
            limit: 200
          })
          return { beforeAny, afterFirst, final, value, entries }
        })
      )

      expect(result.beforeAny.status).toBe("suspended")
      // partial progress: the run advanced past `first` but is still waiting on `second`
      expect(result.afterFirst.status).toBe("suspended")
      expect(result.final.status).toBe("completed")
      expect(result.value).toBe("prefix-result/a/b")
      // the ready dependency is observed exactly once per replay pass and never
      // observed before it was recorded
      expect(observed.filter((entry) => entry === "first:a").length).toBeGreaterThanOrEqual(1)
      expect(observed.filter((entry) => entry === "second:b")).toEqual(["second:b"])
      expect(prefixDispatches).toBe(1)
      expect(
        result.entries.entries.filter((entry) => entry.eventType === "flows.engine.deferred-completed")
      ).toHaveLength(2)
    }))

  /**
   * Parity: Skyframe `StateMachineTest.java:283` — several independently
   * suspended branches must be satisfiable in any order; resolving them out of
   * request order must not deadlock or lose the earlier resolution.
   */
  it.effect("accepts out-of-order resolution of concurrently awaited dependencies", () =>
    Effect.gen(function*() {
      const flow = Flow.make("DeferredRestart/out-of-order", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const handler = () =>
        Effect.gen(function*() {
          const a = yield* DurableDeferred.await(first)
          const b = yield* DurableDeferred.await(second)
          return `${a}+${b}`
        })

      const result = yield* withRestart((makeEngine, store) =>
        Effect.gen(function*() {
          const engine = yield* makeEngine
          yield* engine.register(flow, handler)
          yield* executeUntilParked(engine, flow, {
            executionId: "ooo-run",
            payload: {},
            discard: true
          })

          // resolve the *later* dependency first
          const restarted = yield* makeEngine
          yield* restarted.register(flow, handler)
          yield* restarted.deferredDone(second, {
            flowName: flow._tag,
            executionId: "ooo-run",
            deferredName: second.name,
            exit: Exit.succeed("b") as any
          })
          yield* executeUntilParked(restarted, flow, {
            executionId: "ooo-run",
            payload: {},
            discard: true
          })
          const stillSuspended = yield* store.get("ooo-run")

          const finalEngine = yield* makeEngine
          yield* finalEngine.register(flow, handler)
          yield* finalEngine.deferredDone(first, {
            flowName: flow._tag,
            executionId: "ooo-run",
            deferredName: first.name,
            exit: Exit.succeed("a") as any
          })
          const value = yield* finalEngine.execute(flow, {
            executionId: "ooo-run",
            payload: {},
            discard: false
          })
          return { stillSuspended, value }
        })
      )

      // the out-of-order completion is retained, not dropped
      expect(result.stillSuspended.status).toBe("suspended")
      expect(result.value).toBe("a+b")
    }))

  /**
   * Parity: Skyframe `ParallelEvaluatorTest.java`
   * `partialReevaluationOneDuringAReevaluation` — a dependency that becomes
   * ready *while a partial reevaluation is already in flight* must be
   * consumed by that reevaluation (or the coalesced follow-up drive), not
   * lost and not require an external re-drive.
   */
  it.effect("consumes a second deferred completion that lands during an in-flight partial resume", () =>
    Effect.gen(function*() {
      const flow = Flow.make("DeferredRestart/mid-resume", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })

      const result = yield* withRestart((makeEngine, store) =>
        Effect.gen(function*() {
          // in-memory latches: `reachedGate` is signalled by the resume pass
          // after it consumed `first`; `gate` holds that pass open so the test
          // can land `second`'s completion while the resume is still live
          const reachedGate = yield* Deferred.make<void>()
          const gate = yield* Deferred.make<void>()
          const handler = () =>
            Effect.gen(function*() {
              const a = yield* DurableDeferred.await(first)
              yield* Deferred.succeed(reachedGate, void 0)
              yield* Deferred.await(gate)
              const b = yield* DurableDeferred.await(second)
              return `${a}*${b}`
            })

          const engine = yield* makeEngine
          yield* engine.register(flow, handler)
          yield* executeUntilParked(engine, flow, {
            executionId: "mid-resume-run",
            payload: {},
            discard: true
          })
          const suspendedRow = yield* store.get("mid-resume-run")

          yield* engine.deferredDone(first, {
            flowName: flow._tag,
            executionId: "mid-resume-run",
            deferredName: first.name,
            exit: Exit.succeed("a")
          })
          yield* Deferred.await(reachedGate)
          const inFlight = yield* store.get("mid-resume-run")

          // lands during the in-flight resume: the run is past `first` but the
          // resume pass has not yet requested `second`
          yield* engine.deferredDone(second, {
            flowName: flow._tag,
            executionId: "mid-resume-run",
            deferredName: second.name,
            exit: Exit.succeed("b")
          })
          yield* Deferred.succeed(gate, void 0)

          // no further execute/wake calls: the in-flight pass (or the wake
          // coalesced by the coordinator) must finish the run on its own
          let final = yield* store.get("mid-resume-run")
          for (let count = 0; count < 400 && final.status !== "completed"; count++) {
            yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
            final = yield* store.get("mid-resume-run")
          }
          return { suspendedRow, inFlight, final }
        })
      )

      expect(result.suspendedRow.status).toBe("suspended")
      // the second completion landed while the resume pass was live, not parked
      expect(result.inFlight.status).toBe("running")
      expect(result.final.status).toBe("completed")
      expect((JSON.parse(result.final.stateJson) as { result?: unknown }).result).toEqual({
        _tag: "Complete",
        exit: { _tag: "Success", value: "a*b" }
      })
    }))
})

/**
 * B-03: what a registration costs, and what it re-arms.
 *
 * `completedDeferreds` selected every completion row for the flow with no
 * run-status join, and `pendingClocks` selected every uncompleted clock row
 * the same way, so `register` — which sweeps both — paid O(history) and then
 * scheduled one resume per completion and armed one timer per clock row for
 * runs that had settled months ago. `waitingRuns` already carries the status
 * predicate at all four of its sites; these two did not.
 *
 * The armed-timer count is read off the `clock-scheduled` records because
 * `sweepDue` emits exactly one immediately before each `armClock`, in the same
 * iteration: the record IS the arming, seen from outside the driver.
 */
describe("registration does not re-arm a settled run (B-03)", () => {
  const B03Flow = Flow.make("DeferredRestart/Settled", {
    payload: {},
    success: Schema.String,
    body: opaqueHandlerBody
  })
  const gate = DurableDeferred.make("b03-gate", { success: Schema.String })
  const seeder: Ownership.OwnerId = { hostId: "b03-seed-host", pid: 4242, nonce: "b03-seed" }

  /**
   * One run with a completed deferred and a pending clock, left in `status`.
   *
   * Written through the public store and state contracts, which is how the
   * rows a real restart finds were written: the clock is owner-fenced, so the
   * run is claimed and owned first, and the terminal transition happens last.
   */
  const seed = (
    store: RunStore.Service,
    state: DurableEngineState.Service,
    runId: string,
    status: RunStore.RunStatus
  ) =>
    Effect.gen(function*() {
      yield* store.create(
        runId,
        JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: B03Flow._tag, payload: {} })
      )
      yield* store.claimAndOwn(runId, { status: "pending", owner: null, heartbeatAtMs: null }, seeder, 0)
      yield* state.scheduleClock({
        flowName: B03Flow._tag,
        executionId: runId,
        clockName: "b03-clock",
        deferredName: gate.name,
        dueAtMs: 600_000,
        completedAtMs: null
      }, seeder)
      yield* state.completeDeferred({
        flowName: B03Flow._tag,
        executionId: runId,
        deferredName: gate.name,
        exit: Exit.void,
        completedAtMs: 0
      })
      if (status === "suspended") {
        yield* state.park(runId, { reason: "event" }, seeder)
      }
      yield* store.transitionOwned(runId, seeder, status, undefined)
    })

  it.effect("schedules no wake and arms no timer for completed, failed, or cancelled runs", () =>
    Effect.gen(function*() {
      const settled = ["b03-completed-a", "b03-completed-b", "b03-failed", "b03-cancelled"]
      const result = yield* withCrypto(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* RunStore.RunStore
            const state = yield* DurableEngineState.DurableEngineState
            const journal = yield* Journal.Journal
            yield* seed(store, state, "b03-completed-a", "completed")
            yield* seed(store, state, "b03-completed-b", "completed")
            yield* seed(store, state, "b03-failed", "failed")
            yield* seed(store, state, "b03-cancelled", "cancelled")
            // The live run is the control: it is parked on the same deferred
            // and the same clock, and it must still be woken and re-armed.
            yield* seed(store, state, "b03-live", "suspended")

            // What a registration sweep will read. Both queries are the
            // change: five runs wrote a completion and a clock row, and only
            // the one that can still make progress is offered to the sweep.
            const pendingBefore = yield* state.pendingClocks({ flowName: B03Flow._tag })
            const completionsBefore = yield* state.completedDeferreds(B03Flow._tag)
            const changes = yield* journal.changes

            // The restart: a fresh engine over the same storage, registering
            // the flow for the first time in this incarnation.
            const engine = yield* EngineStore.make({
              owner: { hostId: "b03-host" },
              journalSource: "b03-test",
              isAlive: () => Effect.succeed(false)
            })
            yield* engine.register(B03Flow, () => Effect.succeed("ok"))
            // Registration schedules the drive; flushing today's queue is not
            // a receipt for the drive's future writes. Wait for the actual
            // post-commit terminal event without starting another drive.
            yield* Stream.fromSubscription(changes).pipe(
              Stream.filter((entry) =>
                entry.runId === "b03-live" &&
                entry.eventType === "flows.engine.run-decision" &&
                (entry.payload as { readonly status?: string }).status === "completed"
              ),
              Stream.take(1),
              Stream.runDrain
            )
            yield* journal.flush

            const recordsOf = (runId: string) =>
              journal.entries({ runId: runId as never, limit: 500 }).pipe(
                Effect.map((page) => ({
                  wakes: page.entries.filter((entry) =>
                    entry.eventType === "flows.engine.run-decision" &&
                    (entry.payload as { readonly decision?: string }).decision === "wake-scheduled"
                  ).length,
                  armed: page.entries.filter((entry) => entry.eventType === "flows.engine.clock-scheduled").length
                }))
              )

            return {
              settled: yield* Effect.forEach(settled, recordsOf),
              live: yield* recordsOf("b03-live"),
              pendingBefore: pendingBefore.map((row) => row.executionId),
              completionsBefore: completionsBefore.map((row) => row.executionId),
              liveRow: yield* store.get("b03-live")
            }
          }).pipe(
            Effect.provide(StepBoundary.layerTest()),
            Effect.provideService(Jj.Jj, jj)
          )
        ).pipe(
          Effect.provide(TestStores.layerAt(":memory:")),
          Effect.provide(TestClock.layer()),
          Effect.orDie
        )
      )

      // Not one resume scheduled and not one timer armed for history.
      expect(result.settled).toEqual([
        { wakes: 0, armed: 0 },
        { wakes: 0, armed: 0 },
        { wakes: 0, armed: 0 },
        { wakes: 0, armed: 0 }
      ])
      // The run that can still make progress is untouched by the fix.
      expect(result.live).toEqual({ wakes: 1, armed: 1 })
      // The queries are the guard: a settled run's rows are simply never
      // offered to the sweep, whatever the sweep would have done with them.
      expect(result.pendingBefore).toEqual(["b03-live"])
      expect(result.completionsBefore).toEqual(["b03-live"])
      // And the wake the live run did get was a real one: it re-entered the
      // handler and settled.
      expect(result.liveRow.status).toBe("completed")
    }))
})

/**
 * The same rule inside the in-memory state, which is what most engine tests
 * and every embedded composition run on. It has no SQL to join, so it asks
 * the `runs` view the composition gives it, exactly as `waitingRuns` does,
 * and stays permissive when there is none.
 */
describe("the in-memory sweep queries skip settled runs (B-03)", () => {
  const flowName = "DeferredRestart/Memory"
  const memoryOwner: Ownership.OwnerId = { hostId: "memory-host", pid: 9, nonce: "memory" }

  /**
   * A run view and a state per case, never one shared by the describe block.
   * Both cases below assert on the same execution ids, so a shared map would
   * let the second read rows only the first wrote: it would pass in file
   * order and fail alone, reversed, or on a rerun.
   */
  const fixture = () => {
    const runs = new Map<string, DurableEngineState.MemoryRunView>()
    const state = DurableEngineState.makeMemory({
      runs: (runId) => Option.fromNullishOr(runs.get(runId)),
      listRuns: () => runs.entries()
    })

    /**
     * The rows a run leaves behind, written the way a run writes them — a
     * clock is owner-fenced, so it is scheduled while the run is still running
     * under its owner — and then left in `status`.
     */
    const seed = (runId: string, status: RunStore.RunStatus) =>
      Effect.gen(function*() {
        runs.set(runId, { status: "running", owner: memoryOwner, heartbeatAtMs: 0 })
        yield* state.completeDeferred({
          flowName,
          executionId: runId,
          deferredName: "gate",
          exit: Exit.void,
          completedAtMs: 0
        })
        yield* state.scheduleClock({
          flowName,
          executionId: runId,
          clockName: "clock",
          deferredName: "gate",
          dueAtMs: 1_000,
          completedAtMs: null
        }, memoryOwner)
        runs.set(runId, { status, owner: null })
      })

    return { runs, seed, state } as const
  }

  it.effect("lists an existing run that can still make progress and skips one that cannot", () =>
    Effect.gen(function*() {
      const { runs, seed, state } = fixture()

      // Every live status, every terminal one, and a row whose run was removed
      // from the supplied view. The removed run stays hidden just as it does
      // behind the SQL implementation's flows_runs join.
      yield* seed("memory-pending", "pending")
      yield* seed("memory-running", "running")
      yield* seed("memory-suspended", "suspended")
      yield* seed("memory-completed", "completed")
      yield* seed("memory-failed", "failed")
      yield* seed("memory-cancelled", "cancelled")
      yield* seed("memory-unknown", "running")
      runs.delete("memory-unknown")

      const live = ["memory-pending", "memory-running", "memory-suspended"]
      expect((yield* state.completedDeferreds(flowName)).map((row) => row.executionId).sort()).toEqual(live.sort())
      expect((yield* state.pendingClocks({ flowName })).map((row) => row.executionId).sort()).toEqual(live.sort())
    }))

  it.effect("completes only the named run's uncompleted clock rows", () =>
    Effect.gen(function*() {
      const { seed, state } = fixture()

      // Both rows this case reads are its own: a pending clock on the run it
      // closes, and one on a bystander it must leave alone.
      yield* seed("memory-running", "running")
      yield* seed("memory-pending", "pending")

      yield* state.completeRunClocks("memory-running", 42)
      // A second call finds nothing left to do and leaves the first
      // completion time alone.
      yield* state.completeRunClocks("memory-running", 99)
      const running = yield* state.clock({ flowName, executionId: "memory-running", clockName: "clock" })
      const other = yield* state.clock({ flowName, executionId: "memory-pending", clockName: "clock" })
      expect(Option.isSome(running) ? running.value.completedAtMs : undefined).toBe(42)
      // Another run's timer is untouched: this closes one run, not the table.
      expect(Option.isSome(other) ? other.value.completedAtMs : undefined).toBeNull()
    }))
})
