import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { DurableEngineState, EngineStore, StepBoundary } from "@smthrs/engine-store"
import { Action, ExternalJob, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import { Effect, Layer, Option, Schema } from "effect"
import { access, appendFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import * as Migrations from "../../src/Migrations.ts"
import * as OwnerIdentity from "../../src/OwnerIdentity.ts"
import { withCrypto } from "../Sha256.ts"

const directory = process.argv[2]!
const mode = process.argv[3]!
const Job = ExternalJob.make("ExternalJob/Restart", {
  payload: {},
  handle: Schema.String,
  success: Schema.String,
  probe: { every: "2 seconds", max: "2 seconds" },
  timeout: "30 seconds"
})
const Caller = Flow.make("ExternalJob/Caller", {
  payload: {},
  success: Schema.String,
  error: Job.errorSchema,
  body: () => Job.call({})
})
const Parent = Flow.make("ExternalJob/Parent", {
  payload: {},
  success: Schema.Struct({ first: Schema.String, second: Schema.String }),
  error: Job.errorSchema,
  body: () => Node.all({ first: Job.call({}), second: Job.call({}) })
})
const log = (kind: string, key: string) =>
  Effect.promise(() => appendFile(join(directory, "calls"), `${kind}:${key}\n`))
const implementations = Job.toLayer({
  start: (_payload, key) => log("start", key).pipe(Effect.as(key)),
  status: (_handle, key) =>
    Effect.gen(function*() {
      yield* log("status", key)
      const exited = mode.startsWith("compose") ||
        (yield* Effect.promise(() => access(join(directory, "exited")).then(() => true, () => false)))
      return exited ? { _tag: "Exited" as const, exitCode: 0 } : { _tag: "Running" as const }
    }),
  collect: (_handle, key) => log("collect", key).pipe(Effect.as("captured")),
  cancel: (_handle, key) => log("cancel", key)
})
const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "external-job-test" as never, changeId: "external-job-test" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})
const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: join(directory, "state.sqlite") })
)
const sqlServices = Layer.provideMerge(
  Layer.mergeAll(
    AttemptStore.layer,
    CacheStore.layer,
    RunStore.layer,
    DurableEngineState.layer,
    SqlJournal.layer({ capacity: 64, overflow: "reject" })
  ),
  Layer.provideMerge(Migrations.layer, database)
)
const requirements = Layer.mergeAll(
  sqlServices,
  StepBoundary.layerTest(),
  OwnerIdentity.layer,
  Layer.succeed(Jj.Jj, jj)
)

await Effect.runPromise(withCrypto(Effect.scoped(
  Effect.gen(function*() {
    const engine = yield* EngineStore.make({
      owner: { hostId: `external-job-${mode}` },
      journalSource: "external-job-test",
      isAlive: () => Effect.succeed(false)
    })
    const layerScope = yield* Effect.scope
    const layers = mode === "compose-before"
      ? Layer.mergeAll(Interpreter.layer(Parent), Interpreter.layer(Caller), implementations)
      : Layer.mergeAll(implementations, Interpreter.layer(Parent), Interpreter.layer(Caller))
    yield* Layer.buildWithScope(layers.pipe(Layer.provideMerge(Action.layerImplementations)), layerScope).pipe(
      Effect.provideService(FlowRuntime.FlowRuntime, engine)
    )
    if (mode === "start" || mode === "cancel") {
      yield* engine.execute(Caller, { executionId: "external-job-root", payload: {}, discard: true })
    }
    if (mode.startsWith("compose")) {
      yield* engine.execute(Parent, { executionId: "external-job-root", payload: {}, discard: true })
    }
    const runs = yield* RunStore.RunStore
    for (let count = 0; count < 600; count++) {
      const row = yield* runs.get("external-job-root")
      if (mode === "start" && row.status === "suspended") {
        process.stdout.write(`${JSON.stringify({ status: "parked" })}\n`)
        return yield* Effect.never
      }
      if (mode === "cancel" && row.status === "suspended") {
        yield* engine.interrupt(Caller, "external-job-root")
        for (let attempt = 0; attempt < 200; attempt++) {
          const calls = yield* Effect.promise(() => readFile(join(directory, "calls"), "utf8"))
          const cancelled = yield* runs.get("external-job-root")
          if (calls.includes("cancel:") && cancelled.status === "cancelled") {
            process.stdout.write(`${JSON.stringify({ status: "cancelled" })}\n`)
            return
          }
          yield* Effect.sleep("25 millis")
        }
        return yield* Effect.die("cancellation did not finish")
      }
      if ((mode === "restart" || mode.startsWith("compose")) && row.status === "completed") {
        const outcome = mode.startsWith("compose")
          ? Option.getOrThrow(yield* engine.poll(Parent, "external-job-root"))
          : Option.getOrThrow(yield* engine.poll(Caller, "external-job-root"))
        if (outcome._tag !== "Complete" || outcome.exit._tag !== "Success") {
          return yield* Effect.die("missing completion result")
        }
        process.stdout.write(`${JSON.stringify({ status: "completed", value: outcome.exit.value })}\n`)
        return
      }
      if (row.status === "failed" || row.status === "cancelled") {
        return yield* Effect.die(row.stateJson)
      }
      yield* Effect.sleep("25 millis")
    }
    return yield* Effect.die("external job did not settle")
  }).pipe(Effect.provide(requirements))
)))
