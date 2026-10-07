import { deliverSignal } from "@smthrs/agent/AgentSession"
import { Control } from "@smthrs/control/Control"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlLive from "@smthrs/control/ControlLive"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import * as NotificationQueue from "../../packages/smithers/notifications/src/NotificationQueue.ts"
import { Registry } from "@smthrs/registry"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { DurableEngineState } from "@smthrs/engine-store"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as Migrations from "@smthrs/engine-store/Migrations"
import * as OwnerIdentity from "@smthrs/engine-store/OwnerIdentity"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import { Action, DurableDeferred, FlowRuntime, Interpreter, WaitFor } from "@smthrs/flow"
import * as Jj from "../../packages/smithers/flows/jj/src/index.ts"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "../../packages/smithers/flows/step-cache/src/CacheStore.ts"
import { Effect, Layer, Option } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { TodoBoundary, TodoPauseRequested } from "../coding/todo-pause.ts"

const database = Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer, AttemptStore.layer, CacheStore.layer, DurableEngineState.layer).pipe(
  Layer.provideMerge(Layer.effectDiscard(Migrations.run)),
  Layer.provideMerge(Layer.merge(TestDatabase.layer, NodeCrypto.layer)))
const bridge = Layer.effect(ControlExecutor.ControlExecutor)(Effect.gen(function*() {
  const services = yield* Effect.context<DurableEngineState.DurableEngineState | FlowRuntime.FlowRuntime>()
  return ControlExecutor.makeNoop({ deliverSignal: (input) => Effect.provide(deliverSignal(input), services) })
}))
const plane = ControlLive.layer.pipe(Layer.provideMerge(Layer.mergeAll(
  SqlControlRuntime.layer({}).pipe(Layer.orDie), NotificationQueue.layer, Registry.layerNoop(), bridge)))
const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "pause" as never, changeId: "pause" as never }),
  restore: () => Effect.void, diff: () => Effect.succeed(""), workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void, status: () => Effect.succeed("")
})

for (const generation of [null, 1, 2]) test(`TODO boundary journals pause cycle ${generation}`, async () => {
  let observations = 0
  const engine = Layer.mergeAll(Interpreter.layer(TodoBoundary), WaitFor.layer,
    TodoPauseRequested.toLayer(() => Effect.sync(() => { observations++; return { requested: generation !== null, pause: `pause#${generation}`, resume: `resume#${generation}` } }))).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(EngineStore.layer({ owner: { hostId: "todo-pause-test" }, journalSource: "todo-pause-test",
      isAlive: () => Effect.succeed(false) })),
    Layer.provideMerge(Layer.mergeAll(StepBoundary.layerTest(), Layer.succeed(Jj.Jj, jj), OwnerIdentity.layer)),
    Layer.provideMerge(database))
  const layer = Layer.merge(engine, plane).pipe(Layer.provideMerge(engine))
  await Effect.runPromise(Effect.gen(function*() {
    const run = `pause-${generation}`
    const state = yield* DurableEngineState.DurableEngineState
    const store = yield* RunStore.RunStore
    yield* TodoBoundary.execute({}, { executionId: run, discard: true })
    if (generation !== null) {
      for (const name of [`pause#${generation}`, `resume#${generation}`]) {
        yield* TestDatabase.until(Effect.gen(function*() {
          const row = yield* state.waiting(run)
          return Option.isSome(row) && row.value.token !== null &&
            (yield* DurableDeferred.TokenParsed.parse(row.value.token)).deferredName === `WaitFor/${name}`
        }))
        const waiting = yield* state.waiting(run)
        assert.ok(Option.isSome(waiting) && waiting.value.token)
        // An engine re-drive cannot release the park or repeat the observation.
        yield* TodoBoundary.resume(run)
        assert.equal(observations, 1)
        const control = yield* Control
        const receipt: { readonly _tag: string } = yield* control.signal({ runId: run, signal: { name, payload: generation }, idempotencyKey: `${run}/${name}` })
        assert.equal(receipt._tag, "Accepted")
      }
    }
    yield* TestDatabase.until(Effect.gen(function*() { return (yield* store.get(run)).status === "completed" }))
    yield* TodoBoundary.execute({}, { executionId: run })
    assert.equal(observations, 1)
  }).pipe(Effect.provide(layer), Effect.scoped))
})
