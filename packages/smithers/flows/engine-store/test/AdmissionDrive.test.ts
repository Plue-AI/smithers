/** Admission joins an active drive; only new work requests another drive. */
import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Scope } from "effect"
import type * as Crypto from "effect/Crypto"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WakeBus from "../src/WakeBus.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const Child = Flow.make("AdmissionDrive/Child", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})
const Parent = Flow.make("AdmissionDrive/Parent", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})
type Services = Layer.Success<ReturnType<typeof TestStores.layerAt>> | Scope.Scope | Crypto.Crypto
const run = <A, E>(body: Effect.Effect<A, E, Services>) =>
  withCrypto(body.pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:"))))
const makeDriver = () =>
  RunDriver.make({
    owner: { hostId: "admission-drive", pid: process.pid, nonce: "admission-drive" },
    journalSource: "admission-drive",
    engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"])
  })

const makePublicEngine = () =>
  EngineStore.make({ owner: { hostId: "admission-public" }, journalSource: "admission-public" })
    .pipe(
      Effect.provide(StepBoundary.layerTest()),
      // Handlers perform no filesystem effects, so Jj only satisfies the host port.
      // Journal, run state, parent edges and cancellation use production SQLite stores.
      Effect.provideService(
        Jj.Jj,
        Jj.make({
          snapshot: () => Effect.succeed({ commitId: "admission" as never, changeId: "admission" as never }),
          restore: () => Effect.void,
          diff: () => Effect.succeed(""),
          workspaceAdd: () => Effect.void,
          workspaceForget: () => Effect.void,
          status: () => Effect.succeed("")
        })
      )
    )

describe("durable admission drive", () => {
  for (const caller of ["root", "nested"] as const) {
    it.effect(`${caller}: a replacement follower drives a pending handoff without spending a retry`, () =>
      run(Effect.gen(function*() {
        const policy = RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 1 })
        const first = Flow.make(`AdmissionDrive/RecoveryFirst/${caller}`, {
          suspendedRetryPolicy: policy,
          payload: {},
          success: Schema.String,
          body: opaqueHandlerBody
        })
        const next = Flow.make(`AdmissionDrive/RecoveryNext/${caller}`, {
          payload: {},
          success: Schema.String,
          body: opaqueHandlerBody
        })
        const outer = Flow.make(`AdmissionDrive/RecoveryParent/${caller}`, {
          suspendedRetryPolicy: policy,
          payload: {},
          success: Schema.String,
          body: opaqueHandlerBody
        })
        const rootId = `recover-${caller}`
        const advanced = yield* FlowEngine.Round.next(FlowEngine.Round.initial(rootId), {
          flowName: first._tag,
          maxRounds: 3
        })
        // The first driver commits a real handoff but cannot execute its successor.
        yield* Effect.scoped(Effect.gen(function*() {
          const driver = yield* RunDriver.make({
            owner: { hostId: "admission-first", pid: process.pid, nonce: caller },
            journalSource: "admission-first",
            canExecute: (row) => Effect.succeed(row.runId === rootId),
            engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"])
          })
          yield* driver.register(first, () =>
            Effect.gen(function*() {
              const instance = yield* FlowRuntime.FlowInstance
              instance.handoff = new Flow.Handoff({ flow: next._tag, payload: {} })
              return "handed off"
            }))
          yield* driver.register(next, () => Effect.die("the first host must not run the successor"))
          expect((yield* driver.execute(first, { executionId: rootId, payload: {}, discard: false }))._tag).toBe(
            "Handoff"
          )
          yield* driver.active.pipe(
            Effect.tap(() => Effect.yieldNow),
            Effect.repeat({ until: (active) => active.size === 0 })
          )
        }))
        const store = yield* RunStore.RunStore
        expect((yield* store.get(rootId)).status).toBe("completed")
        expect((yield* store.get(advanced.executionId)).status).toBe("pending")
        const engine = yield* makePublicEngine()
        let calls = 0
        yield* engine.register(first, () => Effect.die("completed predecessor must replay its stored handoff"))
        yield* engine.register(next, () =>
          Effect.sync(() => {
            calls++
            return "recovered once"
          }))
        const resume = first.execute({}, { executionId: rootId })
        yield* engine.register(outer, () => resume.pipe(Effect.orDie))
        const result = yield* (caller === "root"
          ? resume
          : outer.execute({}, { executionId: `outer-${caller}` })).pipe(
            Effect.provideService(FlowRuntime.FlowRuntime, engine),
            Effect.exit
          )
        expect(result).toEqual(Exit.succeed("recovered once"))
        expect(calls).toBe(1)
        expect((yield* store.get(advanced.executionId)).status).toBe("completed")
      })))
  }

  for (const runtime of ["durable", "memory"] as const) {
    it.effect(`${runtime}: a discarded handoff follows its already parked successor without replay`, () =>
      run(
        Effect.gen(function*() {
          const rootId = `handoff-${runtime}`
          const round = yield* FlowEngine.Round.next(FlowEngine.Round.initial(rootId), {
            flowName: "AdmissionDrive/Handoff",
            maxRounds: 3
          })
          const store = yield* RunStore.RunStore
          const bus = WakeBus.makeUnsafe()
          const followerWaiting = yield* Deferred.make<void>()
          const orderedBus = {
            ...bus,
            awaitWake: (id: string) =>
              Effect.gen(function*() {
                const waiter = yield* bus.awaitWake(id).pipe(Effect.forkChild({ startImmediately: true }))
                if (id === round.executionId) {
                  expect(yield* bus.waiters(id)).toBeGreaterThan(0)
                  yield* Deferred.succeed(followerWaiting, undefined)
                }
                return yield* Fiber.join(waiter)
              }),
            wake: (id: string) =>
              Effect.gen(function*() {
                if (id === rootId) {
                  // Delay root notification until the actual successor is durably parked.
                  // This orders the race without replacing any stored state or drive.
                  const row = yield* store.get(round.executionId).pipe(
                    Effect.tap(() => Effect.yieldNow),
                    Effect.repeat({ until: (row) => row.status === "suspended" })
                  )
                  expect(row.status).toBe("suspended")
                }
                yield* bus.wake(id)
              })
          }
          const engine = runtime === "durable" ?
            yield* makePublicEngine().pipe(Effect.provideService(WakeBus.WakeBus, orderedBus)) :
            yield* FlowRuntime.FlowRuntime
          const first = Flow.make(`AdmissionDrive/Handoff/${runtime}`, {
            payload: {},
            success: Schema.String,
            body: opaqueHandlerBody
          })
          const next = Flow.make(`AdmissionDrive/HandoffNext/${runtime}`, {
            payload: {},
            success: Schema.String,
            body: opaqueHandlerBody
          })
          let successorCalls = 0
          yield* engine.register(first, () =>
            Effect.gen(function*() {
              const instance = yield* FlowRuntime.FlowInstance
              instance.handoff = new Flow.Handoff({ flow: next._tag, payload: {} })
              return "handed off"
            }))
          yield* engine.register(next, () =>
            Effect.gen(function*() {
              successorCalls++
              const instance = yield* FlowRuntime.FlowInstance
              instance.waiting = { reason: "approval" }
              return yield* Flow.suspend(instance)
            }))
          yield* first.execute({}, { executionId: rootId, discard: true }).pipe(
            Effect.provideService(FlowRuntime.FlowRuntime, engine)
          )
          if (runtime === "durable") yield* Deferred.await(followerWaiting)
          const observed = yield* next.poll(round.executionId).pipe(
            Effect.provideService(FlowRuntime.FlowRuntime, engine),
            Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeedNone),
            Effect.tap(() => Effect.yieldNow),
            Effect.repeat({ until: Option.isSome })
          )
          expect(Option.getOrThrow(observed)._tag).toBe("Suspended")
          expect(successorCalls).toBe(1)
          yield* first.interrupt(rootId).pipe(Effect.provideService(FlowRuntime.FlowRuntime, engine))
          // Re-drive the parked round to apply its persisted cancellation request.
          yield* next.resume(round.executionId).pipe(Effect.provideService(FlowRuntime.FlowRuntime, engine))
          const cancellation = yield* first.execute({}, { executionId: rootId }).pipe(
            Effect.provideService(FlowRuntime.FlowRuntime, engine),
            Effect.exit
          )
          expect(Exit.isFailure(cancellation)).toBe(true)
          if (runtime === "durable") expect((yield* store.get(round.executionId)).status).toBe("cancelled")
          expect(successorCalls).toBe(1)
        }).pipe(Effect.provide(FlowEngine.layerMemory))
      ))
  }

  it.effect("root ensure remains detached when an action later joins the same key", () =>
    run(Effect.gen(function*() {
      const engine = yield* makePublicEngine()
      const release = yield* Deferred.make<string>()
      const started = yield* Deferred.make<void>()
      const child = Flow.make("AdmissionDrive/RootEnsure", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const launch = Action.make("AdmissionDrive/JoinRoot", {
        payload: {},
        success: Schema.String,
        error: Schema.Unknown
      })
      const parent = Flow.make("AdmissionDrive/JoinRootParent", {
        payload: {},
        success: Schema.String,
        error: Schema.Unknown,
        body: Node.capture({ action: launch.name }, () => launch.call({}))
      })
      yield* engine.register(child, () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))))
      const observations = yield* Effect.gen(function*() {
        const root = yield* child.ensure({}, { key: "root-worker" })
        yield* Deferred.await(started)
        const joined = yield* parent.execute({}, { executionId: "joining-parent" }).pipe(
          Effect.provide(Interpreter.layerWithImplementations(
            parent,
            launch.toLayer(() =>
              child.ensure({}, { key: "root-worker" })
            )
          ))
        )
        expect(joined).toBe(root)
        const store = yield* RunStore.RunStore
        expect((yield* store.get("joining-parent")).status).toBe("completed")
        const admitted = yield* store.get(root)
        yield* Deferred.succeed(release, "root child finished")
        const result = yield* child.execute({}, { executionId: root }).pipe(Effect.exit)
        return { admitted, result }
      }).pipe(Effect.provideService(FlowRuntime.FlowRuntime, engine))
      expect(JSON.parse(observations.admitted.stateJson).onParentExit).toBe("detach")
      expect(observations.admitted.cancelRequestedAtMs).toBeNull()
      expect(observations.result).toEqual(Exit.succeed("root child finished"))
    })))

  it.effect("duplicate discarded admissions of an active child do not replay it after it parks", () =>
    run(Effect.gen(function*() {
      const driver = yield* makeDriver()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let drives = 0
      yield* driver.register(Child, () =>
        Effect.gen(function*() {
          drives++
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
          const instance = yield* FlowRuntime.FlowInstance
          instance.waiting = { reason: "approval" }
          return yield* Flow.suspend(instance)
        }))
      const options = { executionId: "duplicate", payload: {}, discard: true } as const
      yield* driver.execute(Child, options)
      yield* Deferred.await(started)
      yield* driver.execute(Child, options)
      yield* driver.execute(Child, options)
      yield* Deferred.succeed(release, undefined)
      yield* driver.active.pipe(
        Effect.tap(() => Effect.yieldNow),
        Effect.repeat({ until: (active) => active.size === 0 })
      )
      expect((yield* driver.active).size).toBe(0)
      expect(drives).toBe(1)
      expect((yield* (yield* RunStore.RunStore).get("duplicate")).status).toBe("suspended")
      expect(Option.getOrThrow(yield* (yield* DurableEngineState.DurableEngineState).waiting("duplicate")).reason).toBe(
        "approval"
      )
      // Existing execute behavior: admitting an idle parked execution re-drives it.
      // Only duplicates that join an active drive are coalesced by admission.
      yield* driver.execute(Child, options)
      yield* driver.active.pipe(
        Effect.tap(() => Effect.yieldNow),
        Effect.repeat({ until: (active) => active.size === 0 })
      )
      expect(drives).toBe(2)
    })))

  it.effect("a follower joins recorded detach after its parent has completed", () =>
    run(Effect.gen(function*() {
      const driver = yield* makeDriver()
      const parentStarted = yield* Deferred.make<FlowRuntime.FlowInstance["Service"]>()
      const parentRelease = yield* Deferred.make<void>()
      const childStarted = yield* Deferred.make<void>()
      const childRelease = yield* Deferred.make<void>()
      yield* driver.register(Parent, () =>
        Effect.gen(function*() {
          yield* Deferred.succeed(parentStarted, yield* FlowRuntime.FlowInstance)
          yield* Deferred.await(parentRelease)
          return "parent finished"
        }))
      yield* driver.register(Child, () =>
        Deferred.succeed(childStarted, undefined).pipe(
          Effect.andThen(Deferred.await(childRelease)),
          Effect.as("child finished")
        ))
      const parentDrive = yield* driver.execute(Parent, {
        executionId: "parent",
        payload: {},
        discard: false
      }).pipe(Effect.forkChild)
      const parent = yield* Deferred.await(parentStarted)
      yield* driver.execute(Child, { executionId: "child", payload: {}, discard: true, parent })
      yield* Deferred.await(childStarted)
      yield* Deferred.succeed(parentRelease, undefined)
      yield* Fiber.join(parentDrive)
      const store = yield* RunStore.RunStore
      expect((yield* store.get("parent")).status).toBe("completed")
      expect(JSON.parse((yield* store.get("child")).stateJson).onParentExit).toBe("detach")
      // Invoke only after the parent's terminal receipt: this ordering is deterministic.
      const follower = yield* driver.execute(Child, {
        executionId: "child",
        payload: {},
        discard: false,
        follow: true,
        parent
      }).pipe(Effect.forkChild)
      yield* Deferred.succeed(childRelease, undefined)
      const followed = yield* Fiber.join(follower)
      expect(followed._tag).toBe("Complete")
      if (followed._tag === "Complete") expect(followed.exit).toEqual(Exit.succeed("child finished"))
      const row = yield* store.get("child")
      expect(row.cancelRequestedAtMs).toBeNull()
      expect(JSON.parse(row.stateJson).onParentExit).toBe("detach")
      expect(row.status).toBe("completed")
    })))
})
