import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import { Node } from "@smthrs/plan"
import { InputRef } from "@smthrs/plan/KeyMaterial"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deliverSignal, drainRecordedSignals } from "@smthrs/agent/AgentSession"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
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
import { Action, DurableDeferred, Flow, FlowRuntime, Graph, Interpreter, WaitFor } from "@smthrs/flow"
import * as Jj from "../../packages/smithers/flows/jj/src/index.ts"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "../../packages/smithers/flows/step-cache/src/CacheStore.ts"
import { Effect, Layer, ManagedRuntime, Option, Schema, Scope } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { TodoBoundary, TodoPauseRequested, todoResumeLayer, todoPauseLayer } from "../coding/todo-pause.ts"

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
  const engine = Layer.mergeAll(Interpreter.layer(TodoBoundary), WaitFor.layer, todoResumeLayer,
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
        if (name.startsWith("resume")) {
          const summary = yield* (yield* ControlRuntime).getRun(run)
          assert.equal(summary.status, "waiting-approval")
          assert.equal(summary.pendingWaits?.[0]?.reason, "approval")
          assert.equal(summary.pendingWaits?.[0]?.name, "resume")
          assert.equal(summary.pendingWaits?.[0]?.attempt, generation)
        }
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

// Pause observations must wait for their preceding planned producer. A
// bindPlanned builder alone permits independent descendants to run early.
// A real root composition observes the admitted inbox, then survives a complete
// host shutdown while parked. The second host must replay completed work and
// settle the same durable wait rather than starting another attempt.
test("TODO pause survives a cold SQLite host restart without repeating finished work", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "todo-pause-cold-"))
  let release!: () => void
  const running = new Promise<void>(resolve => { release = resolve })
  let entered = 0, secondStarted = 0, finished = 0
  let releaseSecond!: () => void
  const secondRunning = new Promise<void>(resolve => { releaseSecond = resolve })
  const Before = Action.make("test/todo-before", { payload: {}, success: Schema.Void })
  const After = Action.make("test/todo-after", { payload: {}, success: Schema.Void })
  const Done = Action.make("test/todo-done", { payload: {}, success: Schema.Void })
  const Planning = Flow.make("test/todo-planning", { payload: {}, success: Schema.Void, body: () => Before.call({}) })
  const Todo = Flow.make("todo", { payload: {}, success: Schema.Void,
    error: TodoBoundary.errorSchema,
    body: () => TodoBoundary.call({}).pipe(Node.andThen(Planning.child({})), Node.bindPlanned((planned) => Node.succeed(planned).pipe(Node.andThen(TodoBoundary.call({})))), Node.andThen(After.call({})), Node.bindPlanned((after) => Node.succeed(after).pipe(Node.andThen(TodoBoundary.call({})))), Node.andThen(Done.call({}))) })
  const open = () => {
    const sqlite = DurableWriter.layer().pipe(Layer.provideMerge(NodeDatabase.layer({ filename: join(directory, "engine.db") })))
    const persistence = Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
      RunStore.layer, AttemptStore.layer, CacheStore.layer, DurableEngineState.layer).pipe(
      Layer.provideMerge(Layer.effectDiscard(Migrations.run)), Layer.provideMerge(Layer.merge(sqlite, NodeCrypto.layer)))
    const engine = Layer.mergeAll(Interpreter.layer(Todo), Interpreter.layer(Planning), Interpreter.layer(TodoBoundary), WaitFor.layer, todoPauseLayer,
      Before.toLayer(() => Effect.promise(async () => { entered++; await running })),
      After.toLayer(() => Effect.promise(async () => { secondStarted++; await secondRunning })),
      Done.toLayer(() => Effect.sync(() => { finished++ }))).pipe(
      Layer.provideMerge(Layer.succeed(ModuleOwner, { rootId: "cold-todo", flowId: "todo" })),
      Layer.provideMerge(SqlControlRuntime.layer({}).pipe(Layer.orDie)),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(EngineStore.layer({ owner: { hostId: "cold-host" }, journalSource: "cold-host", isAlive: () => Effect.succeed(false) })),
      Layer.provideMerge(Layer.mergeAll(StepBoundary.layerTest(), Layer.succeed(Jj.Jj, jj), OwnerIdentity.layer)),
      Layer.provideMerge(persistence))
    return ManagedRuntime.make(Layer.merge(engine, plane).pipe(Layer.provideMerge(engine), Layer.provide(Layer.effect(Scope.Scope)(Effect.scope))))
  }
  const parked = (cycle: number) => Effect.gen(function*() {
    const summary = yield* (yield* ControlRuntime).getRun("cold-todo")
    return summary.pendingWaits?.some(wait => wait.name === "resume" && wait.attempt === cycle) === true
  })
  let host = open()
  try {
    await host.runPromise(Todo.execute({}, { executionId: "cold-todo", discard: true }))
    await host.runPromise(TestDatabase.until(Effect.sync(() => entered === 1)))
    await host.runPromise(Effect.gen(function*() {
      yield* (yield* Control).signal({ runId: "cold-todo", signal: { name: "pause", payload: 1 }, idempotencyKey: "stop-cold" })
    }))
    release()
    // The host inbox poll normally reconciles the admitted rendezvous.
    await host.runPromise(TestDatabase.until(Effect.gen(function*() {
      const control = yield* Control
      yield* control.signal({ runId: "cold-todo", signal: { name: "pause", payload: 1 }, idempotencyKey: "stop-cold" })
      return yield* parked(1)
    })))
    assert.equal(finished, 0)
    await host.dispose()
    host = open()
    assert.equal(await host.runPromise(parked(1)), true)
    await host.runPromise(Todo.resume("cold-todo"))
    assert.equal(entered, 1)
    assert.equal(finished, 0)
    await host.runPromise(Effect.gen(function*() {
      yield* (yield* Control).signal({ runId: "cold-todo", signal: { name: "resume#1", payload: 1 }, idempotencyKey: "resume-cold" })
      yield* TestDatabase.until(Effect.sync(() => secondStarted === 1))
      yield* (yield* Control).signal({ runId: "cold-todo", signal: { name: "pause", payload: 2 }, idempotencyKey: "stop-second" })
    }))
    releaseSecond()
    await host.runPromise(TestDatabase.until(Effect.gen(function*() {
      yield* (yield* Control).signal({ runId: "cold-todo", signal: { name: "pause", payload: 2 }, idempotencyKey: "stop-second" })
      return yield* parked(2)
    })))
    assert.equal(finished, 0, "the old resume must not settle the second boundary")
    await host.runPromise(Effect.gen(function*() {
      yield* (yield* Control).signal({ runId: "cold-todo", signal: { name: "resume#2", payload: 2 }, idempotencyKey: "resume-second" })
      yield* TestDatabase.until(Effect.gen(function*() { return (yield* (yield* RunStore.RunStore).get("cold-todo")).status === "completed" }))
    }))
    assert.equal(secondStarted, 1)
    assert.equal(entered, 1)
    assert.equal(finished, 1)
  } finally { release(); releaseSecond(); await host.dispose(); await rm(directory, { recursive: true, force: true }) }
})

// Linux qualification of the production SQLite engine/control boundary. Machine
// grant, guest attachment and reference-host timings remain separate proofs.
// Setup and fifty staggered grants have their own fixture budget. The cold
// restoration assertion below retains the 60-second bound.
test("fifty TODO waits survive cold restart and staggered Resume without replaying work", { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "todo-fifty-cold-"))
  const before = new Map<number, number>(), after = new Map<number, number>()
  const First = Action.make("test/fifty-first", { payload: { id: Schema.Number }, success: Schema.Void })
  const Second = Action.make("test/fifty-second", { payload: { id: Schema.Number }, success: Schema.Void })
  const Last = Action.make("test/fifty-last", { payload: { id: Schema.Number }, success: Schema.Void })
  const second = new Map<number, number>()
  const Todo = Flow.make("todo", { payload: { id: Schema.Number }, success: Schema.Void,
    error: TodoBoundary.errorSchema,
    body: (input) => First.call(input).pipe(Node.andThen(Second.call(input)),
      Node.andThen(TodoBoundary.call({})), Node.andThen(Last.call(input))) })
  const record = (counts: Map<number, number>, id: number) => Effect.sync(() => { counts.set(id, (counts.get(id) ?? 0) + 1) })
  const open = () => {
    const sqlite = DurableWriter.layer().pipe(Layer.provideMerge(NodeDatabase.layer({ filename: join(directory, "engine.db") })))
    const persistence = Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
      RunStore.layer, AttemptStore.layer, CacheStore.layer, DurableEngineState.layer).pipe(
      Layer.provideMerge(Layer.effectDiscard(Migrations.run)), Layer.provideMerge(Layer.merge(sqlite, NodeCrypto.layer)))
    const engine = Layer.mergeAll(Interpreter.layer(Todo), Interpreter.layer(TodoBoundary), WaitFor.layer, todoResumeLayer,
      TodoPauseRequested.toLayer(() => Effect.succeed({ requested: true, pause: "pause#1", resume: "resume#1" })),
      First.toLayer(({ id }) => record(before, id)), Second.toLayer(({ id }) => record(second, id)), Last.toLayer(({ id }) => record(after, id))).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(EngineStore.layer({ owner: { hostId: "fifty-host" }, journalSource: "fifty-host", isAlive: () => Effect.succeed(false) })),
      Layer.provideMerge(Layer.mergeAll(StepBoundary.layerTest(), Layer.succeed(Jj.Jj, jj), OwnerIdentity.layer)),
      Layer.provideMerge(persistence))
    return ManagedRuntime.make(Layer.merge(engine, plane).pipe(Layer.provideMerge(engine), Layer.provide(Layer.effect(Scope.Scope)(Effect.scope))))
  }
  const run = (id: number) => `fifty-todo-${id}`
  const parked = (id: number) => Effect.gen(function*() {
    const summary = yield* (yield* ControlRuntime).getRun(run(id))
    return summary.pendingWaits?.some(wait => wait.name === "resume" && wait.attempt === 1) === true
  })
  const signal = (id: number, name: string) => Effect.gen(function*() {
    return yield* (yield* Control).signal({ runId: run(id), signal: { name, payload: 1 }, idempotencyKey: `${run(id)}/${name}` })
  })
  let host = open()
  try {
    for (let id = 0; id < 50; id++) {
      await host.runPromise(Todo.execute({ id }, { executionId: run(id), discard: true }))
      await host.runPromise(TestDatabase.until(Effect.gen(function*() {
        const waiting = yield* (yield* DurableEngineState.DurableEngineState).waiting(run(id))
        return Option.isSome(waiting) && waiting.value.token !== null
      })))
      await host.runPromise(signal(id, "pause#1"))
      // Admission can win the engine's wait-publication CAS. Production
      // retries its durable inbox; this fixture must drive that same drain.
      await host.runPromise(TestDatabase.until(Effect.gen(function*() {
        yield* drainRecordedSignals
        return yield* parked(id)
      })))
    }
    assert.equal(before.size, 50); assert.equal(second.size, 50); assert.equal(after.size, 0)
    await host.dispose()
    const ready = performance.now()
    host = open()
    for (let id = 0; id < 50; id++) {
      assert.equal(await host.runPromise(parked(id)), true)
      await host.runPromise(Todo.resume(run(id)))
    }
    const restored = performance.now() - ready
    assert.ok(restored < 60_000)
    assert.equal(after.size, 0)
    // Ten grants at a time: no input may release another run's wait.
    for (let start = 0; start < 50; start += 10) {
      for (let id = start; id < start + 10; id++) {
        await host.runPromise(signal(id, "resume#1"))
        await host.runPromise(signal(id, "resume#1"))
        await host.runPromise(TestDatabase.until(Effect.gen(function*() {
          yield* drainRecordedSignals
          return (yield* (yield* RunStore.RunStore).get(run(id))).status === "completed"
        })))
      }
      assert.equal(after.size, start + 10)
      for (let id = start + 10; id < 50; id++) assert.equal(await host.runPromise(parked(id)), true)
    }
    for (let id = 0; id < 50; id++) {
      assert.equal(before.get(id), 1); assert.equal(second.get(id), 1); assert.equal(after.get(id), 1)
    }
    console.log(`fifty SQLite waits restored in ${restored.toFixed(1)}ms; no machine timing claimed`)
  } finally { await host.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test("the no-pause boundary survives the Control plan JSON round trip", () => {
  const drafts = Graph.drafts(Graph.build(TodoBoundary, {}))
  let emptyBranches = 0
  for (const draft of drafts) {
    for (const input of draft.material.inputs) {
      const encoded = JSON.parse(JSON.stringify(input))
      assert.doesNotThrow(() => Schema.decodeUnknownSync(InputRef)(encoded), draft.id)
      if (encoded._tag === "Literal" && encoded.value === null) emptyBranches++
    }
  }
  assert.equal(emptyBranches, 1)
})

// The ordinary TODO checkpoint acknowledges Bring in independently of its
// notification inbox. Wrong and old completions cannot release a later push.
test("Bring in parks the same TODO until its matching native completion", { timeout: 30_000 }, async () => {
  let release!: () => void
  const ready = new Promise<void>((resolve) => { release = resolve })
  let entered = 0, finished = 0
  const Before = Action.make("test/bring-before", { payload: {}, success: Schema.Void })
  const After = Action.make("test/bring-after", { payload: {}, success: Schema.Void })
  const Todo = Flow.make("todo", { payload: {}, success: Schema.Void, error: TodoBoundary.errorSchema,
    body: () => Before.call({}).pipe(Node.andThen(TodoBoundary.call({})), Node.andThen(After.call({}))) })
  const engine = Layer.mergeAll(Interpreter.layer(Todo), Interpreter.layer(TodoBoundary), WaitFor.layer, todoPauseLayer,
    Before.toLayer(() => Effect.promise(async () => { entered++; await ready })),
    After.toLayer(() => Effect.sync(() => { finished++ }))).pipe(
      Layer.provideMerge(Layer.succeed(ModuleOwner, { rootId: "bring-todo", flowId: "todo" })),
      Layer.provideMerge(SqlControlRuntime.layer({}).pipe(Layer.orDie)),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(EngineStore.layer({ owner: { hostId: "bring-host" }, journalSource: "bring-host", isAlive: () => Effect.succeed(false) })),
      Layer.provideMerge(Layer.mergeAll(StepBoundary.layerTest(), Layer.succeed(Jj.Jj, jj), OwnerIdentity.layer)),
      Layer.provideMerge(database))
  const layer = Layer.merge(engine, plane).pipe(Layer.provideMerge(engine))
  const sha = "a".repeat(40)
  await Effect.runPromise(Effect.gen(function*() {
    const control = yield* Control
    const state = yield* DurableEngineState.DurableEngineState
    const store = yield* RunStore.RunStore
    const signal = (name: string, payload: { sha: string; wait: string }) => control.signal({ runId: "bring-todo", signal: { name, payload }, idempotencyKey: `${name}/${payload.wait}` })
    yield* Todo.execute({}, { executionId: "bring-todo", discard: true })
    yield* TestDatabase.until(Effect.sync(() => entered === 1))
    // A background poll can be running between observing and rewriting the
    // retained root park. The durable signal must retain its wake in that gap.
    assert.equal((yield* state.waitingTree("bring-todo")).length, 0)
    assert.equal(yield* deliverSignal({ runId: "bring-todo", signal: { name: "bring_in", payload: { sha, wait: "push-1" } } }), "delivered")
    assert.ok((yield* (yield* ControlRuntime).pendingResumes).some((entry) => entry.runId === "bring-todo"))
    yield* signal("bring_in", { sha, wait: "push-1" })
    yield* signal("bring_in", { sha, wait: "push-1" })
    release()
    yield* TestDatabase.until(Effect.gen(function*() {
      yield* drainRecordedSignals
      const waiting = yield* state.waiting("bring-todo")
      return Option.isSome(waiting) && waiting.value.reason === "event" &&
        JSON.stringify(waiting.value.request) === JSON.stringify({ kind: "bring_in", sha, wait: "push-1" })
    }))
    assert.equal(finished, 0)
    const checkpoint = yield* (yield* ControlRuntime).getRun("bring-todo")
    assert.equal(checkpoint.status, "parked")
    assert.equal(checkpoint.pendingWaits?.[0]?.reason, "event")
    assert.deepEqual(checkpoint.pendingWaits?.[0]?.request, { kind: "bring_in", sha, wait: "push-1" })
    const runtime = yield* ControlRuntime
    for (const pending of yield* runtime.pendingResumes) {
      if (pending.runId === "bring-todo") yield* runtime.clearResume(pending.runId, pending.sequence)
    }
    // Another checkpoint request cannot answer the current named child wait.
    assert.equal(yield* deliverSignal({ runId: "bring-todo", signal: { name: "bring_in", payload: { sha, wait: "push-2" } } }), "delivered")
    assert.equal((yield* runtime.pendingResumes).some((entry) => entry.runId === "bring-todo"), false)
    assert.deepEqual(Option.getOrUndefined(yield* state.waiting("bring-todo"))?.request, { kind: "bring_in", sha, wait: "push-1" })
    yield* signal("bring_in_complete#push-0", { sha, wait: "push-0" }).pipe(Effect.catchTag("/control/NoMatchingWait", () => Effect.void))
    yield* Todo.resume("bring-todo")
    assert.equal(finished, 0)
    yield* signal("bring_in_complete#push-1", { sha, wait: "push-1" })
    yield* TestDatabase.until(Effect.gen(function*() {
      yield* drainRecordedSignals
      return (yield* store.get("bring-todo")).status === "completed"
    }))
    yield* Todo.execute({}, { executionId: "bring-todo" })
    assert.equal(entered, 1)
    assert.equal(finished, 1)
  }).pipe(Effect.provide(layer), Effect.scoped))
})
