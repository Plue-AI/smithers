/** Regression for detached admission (issue #2932). */
import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import type * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import type * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

// These flows perform no filesystem effects; deterministic Jj only supplies
// the unused host port. Durable recovery and sweep tests use real SQLite.
const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "detached-snapshot" as never, changeId: "detached-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

type Services =
  | Layer.Success<ReturnType<typeof TestStores.layer>>
  | StepBoundary.Service
  | Jj.Jj
  | Crypto.Crypto
  | Scope.Scope

const withEngine = <A, E>(
  body: (
    engine: FlowRuntime.FlowRuntime["Service"]
  ) => Effect.Effect<A, E, Services>
) => {
  return withCrypto(
    Effect.scoped(
      Effect.gen(function*() {
        const engine = (yield* EngineStore.make({
          owner: { hostId: "detached-host" },
          journalSource: "detached-test",
          isAlive: () => Effect.succeed(false)
        })) as FlowRuntime.FlowRuntime["Service"]
        return yield* body(engine)
      }).pipe(
        Effect.provideService(Jj.Jj, jj)
      )
    ).pipe(
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layerAt(":memory:"))
    )
  )
}

const runtimes = ["durable", "memory"] as const
for (const runtime of runtimes) {
  const run = <A, E>(
    body: (
      engine: FlowRuntime.FlowRuntime["Service"]
    ) => Effect.Effect<A, E, Crypto.Crypto | Scope.Scope | FlowRuntime.FlowRuntime>
  ) =>
    runtime === "durable"
      ? withEngine((engine) => body(engine).pipe(Effect.provideService(FlowRuntime.FlowRuntime, engine)))
      : withCrypto(
        Effect.scoped(Effect.gen(function*() {
          return yield* body(yield* FlowRuntime.FlowRuntime)
        })).pipe(Effect.provide(FlowEngine.layerMemory))
      )

  describe(`${runtime} detached public flow admission`, () => {
    it.effect("start returns while its child remains blocked, then poll observes completion", () =>
      run((engine) =>
        Effect.gen(function*() {
          const release = yield* Deferred.make<string>()
          const child = Flow.make(`DetachedStart/${runtime}`, {
            payload: {},
            success: Schema.String,
            body: () => Node.succeed("unused")
          })
          yield* engine.register(child, () => Deferred.await(release))
          const admission = yield* child.start({}).pipe(Effect.forkChild)
          for (let turn = 0; turn < 2_000 && admission.pollUnsafe() === undefined; turn++) yield* Effect.yieldNow
          expect(admission.pollUnsafe() !== undefined).toBe(true)
          const id = yield* Fiber.join(admission)
          expect(Option.isNone(yield* child.poll(id))).toBe(true)
          yield* Deferred.succeed(release, "finished")
          let observed = yield* child.poll(id)
          for (let turn = 0; turn < 2_000 && Option.isNone(observed); turn++) {
            yield* Effect.yieldNow
            observed = yield* child.poll(id)
          }
          expect(Option.getOrThrow(observed)._tag).toBe("Complete")
          expect(yield* child.execute({}, { executionId: id })).toBe("finished")
        })
      ))

    it.effect("ensure inside an action returns, detaches after parent completion, and joins one child", () =>
      run((engine) =>
        Effect.gen(function*() {
          const release = yield* Deferred.make<string>()
          let childRuns = 0
          const child = Flow.make(`DetachedEnsure/Child/${runtime}`, {
            payload: {},
            success: Schema.String,
            body: () => Node.succeed("unused")
          })
          const launch = Action.make(`DetachedEnsure/Launch/${runtime}`, {
            payload: {},
            success: Schema.String,
            error: Schema.Unknown
          })
          const parent = Flow.make(`DetachedEnsure/Parent/${runtime}`, {
            payload: {},
            success: Schema.String,
            error: Schema.Unknown,
            body: Node.capture({ action: launch.name }, () => launch.call({}))
          })
          yield* engine.register(child, () =>
            Effect.gen(function*() {
              childRuns++
              return yield* Deferred.await(release)
            }))
          const caller = yield* parent.execute({}).pipe(
            Effect.provide(Interpreter.layerWithImplementations(
              parent,
              launch.toLayer(() => child.ensure({}, { key: "worker" }))
            )),
            Effect.forkChild
          )
          for (let turn = 0; turn < 2_000 && caller.pollUnsafe() === undefined; turn++) yield* Effect.yieldNow
          expect(caller.pollUnsafe() !== undefined).toBe(true)
          const id = yield* Fiber.join(caller)
          expect(Option.isNone(yield* child.poll(id))).toBe(true)
          expect(yield* child.ensure({}, { key: "worker" })).toBe(id)
          yield* Deferred.succeed(release, "detached-finished")
          let observed = yield* child.poll(id)
          for (let turn = 0; turn < 2_000 && Option.isNone(observed); turn++) {
            yield* Effect.yieldNow
            observed = yield* child.poll(id)
          }
          expect(Option.getOrThrow(observed)._tag).toBe("Complete")
          expect(yield* child.execute({}, { executionId: id })).toBe("detached-finished")
          expect(childRuns).toBe(1)
        })
      ))
  })
}

it.effect("caller interruption cannot split durable admission from scheduling", () =>
  withCrypto(
    Effect.scoped(Effect.gen(function*() {
      const runs = yield* RunStore.RunStore
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let admittedId: string | undefined
      let calls = 0
      const wrapped: RunStore.Service = {
        ...runs,
        create: (id, state, options) =>
          Effect.gen(function*() {
            admittedId = id
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            yield* runs.create(id, state, options)
          })
      }
      const engine = yield* EngineStore.make({ owner: { hostId: "admit-interrupt" }, journalSource: "admit-interrupt" })
        .pipe(
          Effect.provideService(RunStore.RunStore, wrapped)
        )
      const child = Flow.make("DetachedStart/InterruptedAdmission", {
        payload: {},
        success: Schema.String,
        body: () => Node.succeed("done")
      })
      yield* engine.register(child, () =>
        Effect.sync(() => {
          calls++
          return "done"
        }))
      const caller = yield* child.start({}).pipe(
        Effect.provideService(FlowRuntime.FlowRuntime, engine),
        Effect.forkChild
      )
      yield* Deferred.await(entered)
      const interrupting = yield* Fiber.interrupt(caller).pipe(Effect.forkChild)
      for (let turn = 0; turn < 100; turn++) yield* Effect.yieldNow
      expect(interrupting.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interrupting)
      expect(admittedId).toBeDefined()
      const id = admittedId!
      let result = yield* engine.poll(child, id)
      for (let turn = 0; turn < 2_000 && Option.isNone(result); turn++) {
        yield* Effect.yieldNow
        result = yield* engine.poll(child, id)
      }
      expect(Option.getOrThrow(result)._tag).toBe("Complete")
      expect((yield* runs.get(id)).status).toBe("completed")
      expect(calls).toBe(1)
    })).pipe(
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layerAt(":memory:")),
      Effect.provideService(Jj.Jj, jj)
    )
  ))
