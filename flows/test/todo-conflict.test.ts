import { HarnessError } from "@smthrs/harness/HarnessError"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Node } from "@smthrs/plan"
import { deliverSignal } from "@smthrs/agent/AgentSession"
import { Control } from "@smthrs/control/Control"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlLive from "@smthrs/control/ControlLive"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import * as NotificationQueue from "../../packages/smithers/notifications/src/NotificationQueue.ts"
import { Registry } from "@smthrs/registry"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { DurableEngineState } from "@smthrs/engine-store"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as Migrations from "@smthrs/engine-store/Migrations"
import * as OwnerIdentity from "@smthrs/engine-store/OwnerIdentity"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as Jj from "../../packages/smithers/flows/jj/src/index.ts"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "../../packages/smithers/flows/step-cache/src/CacheStore.ts"
import { NodeCrypto } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, WaitFor } from "@smthrs/flow"
import { Effect, Layer, ManagedRuntime, Schema, Scope } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { ConflictInput, Done, Repair, Resolved, TodoConflict, todoConflictDoneLayer } from "../coding/todo-conflict.ts"

// Agent and native observations are substituted only to exercise the durable
// repair budget. The composed Go/native tests cover actual conflict inspection.
for (const [limit, resolvedAt, expected, remaining] of [[0, 9, 0, 0], [1, 9, 1, 1], [8, 9, 8, 8], [8, 1, 1, 8], [8, 3, 3, 8], [1, 9, 1, 8], [0, 9, 0, 8]] as const) {
 test(`conflict budget ${limit}, remaining ${remaining}, resolves at ${resolvedAt}: same execution replays without spending twice`, async (t) => {
  let turns = 0, inspections = 0, done = 0
  const runtime = ManagedRuntime.make(Layer.mergeAll(
   Interpreter.layer(TodoConflict),
   Repair.toLayer(() => Effect.sync(() => { turns++; return { summary: "edited", reads: ["a.txt"], writes: ["a.txt"] } })),
   Resolved.toLayer(() => Effect.sync(() => { inspections++; return turns >= resolvedAt })),
   Done.toLayer(() => Effect.sync(() => { done++ }))
  ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(NodeCrypto.layer)))
  t.after(() => runtime.dispose())
  const input = { kind: "rebase-conflict" as const, change: "retained", onto: "main", paths: ["a.txt"], limit, name: "conflict#retained" }
  for (let i=0;i<2;i++) await runtime.runPromise(TodoConflict.execute({ input, remaining }, { executionId: "same-attempt" }))
  assert.equal(turns, expected)
  assert.equal(inspections, expected)
  assert.equal(done, 1)
 })
}
test("conflict input refuses unbounded and fractional repair limits", () => {
 const input = { kind: "rebase-conflict", change: "retained", onto: "main", paths: ["a.txt"], name: "conflict#retained" }
 for (const limit of [-1, 9, 0.5, Infinity, NaN]) assert.throws(() => Schema.decodeUnknownSync(ConflictInput)({ ...input, limit }))
 for (const limit of [0, 1, 8]) assert.equal(Schema.decodeUnknownSync(ConflictInput)({ ...input, limit }).limit, limit)
})

// Real SQLite journals and control delivery qualify the same-run rendezvous;
// only the model turn and native inspection are substituted in this unit test.
test("conflict Done survives a cold host restart without repeating the spent repair", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "todo-conflict-cold-"))
  let repairs = 0, completed = 0
  const input = { kind: "rebase-conflict" as const, change: "retained", onto: "main", paths: ["a.txt"], limit: 1, name: "conflict#retained" }
  const Finished = Action.make("test/conflict-finished", { payload: {}, success: Schema.Void })
  const Todo = Flow.make("todo", { payload: {}, success: Schema.Void, error: TodoConflict.errorSchema,
    body: () => TodoConflict.child({ input, remaining: 1 }).pipe(Node.andThen(Finished.call({}))) })
  const open = () => {
    const persistence = Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), RunStore.layer,
      AttemptStore.layer, CacheStore.layer, DurableEngineState.layer).pipe(
      Layer.provideMerge(Layer.effectDiscard(Migrations.run)),
      Layer.provideMerge(Layer.merge(DurableWriter.layer().pipe(Layer.provideMerge(NodeDatabase.layer({ filename: join(directory, "engine.db") }))), NodeCrypto.layer)))
    const jj = Jj.make({ snapshot: () => Effect.succeed({ commitId: "retained" as never, changeId: "retained" as never }),
      restore: () => Effect.void, diff: () => Effect.succeed(""), workspaceAdd: () => Effect.void,
      workspaceForget: () => Effect.void, status: () => Effect.succeed("") })
    const engine = Layer.mergeAll(Interpreter.layer(Todo), Interpreter.layer(TodoConflict), WaitFor.layer, todoConflictDoneLayer,
      Repair.toLayer(() => Effect.sync(() => { repairs++; return { summary: "still conflicted", reads: ["a.txt"], writes: [] } })),
      Resolved.toLayer(() => Effect.succeed(false)), Finished.toLayer(() => Effect.sync(() => { completed++ }))).pipe(
      Layer.provideMerge(SqlControlRuntime.layer({}).pipe(Layer.orDie)), Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(EngineStore.layer({ owner: { hostId: "conflict-host" }, journalSource: "conflict-host", isAlive: () => Effect.succeed(false) })),
      Layer.provideMerge(Layer.mergeAll(StepBoundary.layerTest(), Layer.succeed(Jj.Jj, jj), OwnerIdentity.layer)),
      Layer.provideMerge(persistence))
    const bridge = Layer.effect(ControlExecutor.ControlExecutor)(Effect.gen(function*() {
      const services = yield* Effect.context<DurableEngineState.DurableEngineState | FlowRuntime.FlowRuntime>()
      return ControlExecutor.makeNoop({ deliverSignal: (signal) => Effect.provide(deliverSignal(signal), services) })
    }))
    const plane = ControlLive.layer.pipe(Layer.provideMerge(Layer.mergeAll(SqlControlRuntime.layer({}).pipe(Layer.orDie),
      NotificationQueue.layer, Registry.layerNoop(), bridge)))
    return ManagedRuntime.make(Layer.merge(engine, plane).pipe(Layer.provideMerge(engine), Layer.provide(Layer.effect(Scope.Scope)(Effect.scope))))
  }
  const parked = Effect.gen(function*() {
    const summary = yield* (yield* ControlRuntime).getRun("conflict-todo")
    return summary.pendingWaits?.some(wait => wait.name === input.name) === true
  })
  let host = open()
  try {
    await host.runPromise(Todo.execute({}, { executionId: "conflict-todo", discard: true }))
    await host.runPromise(TestDatabase.until(parked))
    assert.equal(repairs, 1)
    assert.equal(completed, 0)
    await host.dispose()
    host = open()
    assert.equal(await host.runPromise(parked), true)
    await host.runPromise(Todo.resume("conflict-todo"))
    assert.equal(repairs, 1)
    assert.equal(completed, 0)
    await host.runPromise(Effect.gen(function*() {
      yield* (yield* Control).signal({ runId: "conflict-todo", signal: { name: input.name, payload: "done" }, idempotencyKey: "conflict-done" })
      yield* TestDatabase.until(Effect.gen(function*() { return (yield* (yield* RunStore.RunStore).get("conflict-todo")).status === "completed" }))
    }))
    assert.equal(repairs, 1)
    assert.equal(completed, 1)
  } finally { await host.dispose(); await rm(directory, { recursive: true, force: true }) }
})

// A refused model turn must expose the retained conflict, never launch again.
test("a failed repair parks for Done without repeating the turn", async () => {
 let turns = 0, done = 0
 const input = { kind: "rebase-conflict" as const, change: "retained", onto: "main", paths: ["a.txt"], limit: 1, name: "conflict#failure" }
 const layer = Layer.mergeAll(Interpreter.layer(TodoConflict),
  Repair.toLayer(() => Effect.suspend(() => { turns++; return Effect.fail(new HarnessError({ code: "model_failed", message: "provider unavailable" })) })),
  Resolved.toLayer(() => Effect.die("failed turn must not inspect")),
  Done.toLayer(() => Effect.sync(() => { done++ })))
 const runtime = ManagedRuntime.make(layer.pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(NodeCrypto.layer)))
 for (let i=0;i<2;i++) await runtime.runPromise(TodoConflict.execute({ input, remaining: 1 }, { executionId: "failed-attempt" }))
 assert.equal(turns, 1)
 assert.equal(done, 1)
 await runtime.dispose()
})
