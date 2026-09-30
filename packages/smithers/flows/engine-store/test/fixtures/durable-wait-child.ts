import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { DurableEngineState, EngineStore, StepBoundary } from "@smthrs/engine-store"
import { DurableClock, DurableDeferred, Flow } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../../src/Migrations.ts"
import * as OwnerIdentity from "../../src/OwnerIdentity.ts"
import { executeUntilParked } from "../ExecuteUntilParked.ts"
import { withCrypto } from "../Sha256.ts"
import { opaqueHandlerBody } from "./OpaqueHandlerBody.ts"

const mode = process.argv[2]
const filename = process.argv[3]
const executionId = process.argv[4]

if (mode === undefined || filename === undefined || executionId === undefined) {
  throw new Error("usage: durable-wait-child.ts <mode> <filename> <execution-id> [value]")
}

const WaitFlow = Flow.make("DurableWaiting/HardKill", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const TimerFlow = Flow.make("DurableWaiting/FutureTimer", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const deferred = DurableDeferred.make("answer", {
  success: Schema.String
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "durable-wait-child" as never, changeId: "durable-wait-child" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
const migratedDatabase = Layer.provideMerge(Migrations.layer, database)
const sqlServices = Layer.provideMerge(
  Layer.mergeAll(
    AttemptStore.layer,
    CacheStore.layer,
    RunStore.layer,
    DurableEngineState.layer,
    SqlJournal.layer({ capacity: 64, overflow: "reject" })
  ),
  migratedDatabase
)
const requirements = Layer.mergeAll(
  sqlServices,
  StepBoundary.layerTest(),
  OwnerIdentity.layer,
  Layer.succeed(Jj.Jj, jj)
)

const line = (value: unknown): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(value)}\n`)
  })

const waitUntilTerminal = Effect.fn("waitUntilTerminal")((runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    for (let count = 0; count < 400; count++) {
      const row = yield* runs.get(runId)
      if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
        return row
      }
      yield* Effect.sleep("25 millis")
    }
    return yield* Effect.die(new Error(`run ${runId} did not become terminal`))
  })
)

const stateCompletion = Effect.gen(function*() {
  const state = yield* DurableEngineState.make
  const outcome = yield* state.completeDeferred({
    flowName: "DurableState/ProcessRace",
    executionId,
    deferredName: "answer",
    exit: Exit.succeed(process.argv[5] ?? ""),
    completedAtMs: Date.now()
  })
  yield* line({ tag: outcome._tag, row: outcome.row })
}).pipe(Effect.provide(database))

const stateInitialization = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  yield* sql`
    INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
    VALUES (${executionId}, 'suspended', 0, '{}')
  `
  yield* line({ status: "initialized" })
}).pipe(Effect.provide(migratedDatabase))

const engineProgram = Effect.scoped(
  Effect.gen(function*() {
    const engine = yield* EngineStore.make({
      owner: { hostId: `durable-wait-${mode}` },
      journalSource: "durable-wait-test",
      isAlive: () => Effect.succeed(false)
    })

    if (mode === "wait-start") {
      yield* engine.register(
        WaitFlow,
        () => DurableDeferred.await(deferred)
      )
      yield* executeUntilParked(engine, WaitFlow, {
        executionId,
        payload: {},
        discard: true
      })
      yield* line({ status: "suspended" })
      return yield* Effect.never
    }

    if (mode === "wait-complete-unregistered") {
      yield* engine.deferredDone(deferred, {
        flowName: WaitFlow._tag,
        executionId,
        deferredName: deferred.name,
        exit: Exit.succeed("resumed-after-kill")
      })
      return yield* line({ status: "completion-recorded" })
    }

    if (mode === "wait-restart") {
      yield* engine.register(
        WaitFlow,
        () => DurableDeferred.await(deferred)
      )
      const row = yield* waitUntilTerminal(executionId)
      return yield* line({ status: row.status, state: JSON.parse(row.stateJson) as unknown })
    }

    if (mode === "timer-start") {
      yield* engine.register(
        TimerFlow,
        () =>
          DurableClock.sleep({
            name: "wake",
            duration: "3 seconds",
            inMemoryThreshold: "1 millis"
          }).pipe(Effect.as("timer-fired"))
      )
      yield* executeUntilParked(engine, TimerFlow, {
        executionId,
        payload: {},
        discard: true
      })
      yield* line({ status: "suspended" })
      return yield* Effect.never
    }

    if (mode === "timer-restart") {
      yield* engine.register(
        TimerFlow,
        () =>
          DurableClock.sleep({
            name: "wake",
            duration: "3 seconds",
            inMemoryThreshold: "1 millis"
          }).pipe(Effect.as("timer-fired"))
      )
      const state = yield* DurableEngineState.DurableEngineState
      const clock = yield* state.clock({
        flowName: TimerFlow._tag,
        executionId,
        clockName: "wake"
      })
      yield* line({
        status: "restarted",
        completedAtMs: Option.getOrThrow(clock).completedAtMs
      })
      const row = yield* waitUntilTerminal(executionId)
      return yield* line({ status: row.status, state: JSON.parse(row.stateJson) as unknown })
    }

    return yield* Effect.die(new Error(`unknown mode ${mode}`))
  }).pipe(Effect.provide(requirements))
)

// A process entrypoint: running the Effect here is the intended boundary.
await Effect.runPromise(
  withCrypto(
    mode === "state-complete"
      ? stateCompletion
      : mode === "state-init"
      ? stateInitialization
      : engineProgram
  )
)
