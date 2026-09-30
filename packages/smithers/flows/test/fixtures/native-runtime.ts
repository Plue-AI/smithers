import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Jj from "@smthrs/jj/Jj"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Action, DurableDeferred, EngineStore, Flow, FlowRuntime, Interpreter, RunStore } from "../../src/index.ts"

const [runtime, directory, phase] = process.argv.slice(2)
if ((runtime !== "node" && runtime !== "bun") || !directory || !phase) {
  throw new Error("runtime, directory and phase required")
}
const Native = runtime === "bun" ? await import("../../src/BunRuntime.ts") : await import("../../src/NodeRuntime.ts")
const marker = join(directory, "dispatches.txt")
const gate = DurableDeferred.make("portability/approval", { success: Schema.String })
const once = Action.make({
  name: "portability/once",
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: "portability/once/v1",
  execute: Effect.sync(() => {
    appendFileSync(marker, "executed\n")
    return "original result"
  })
})
const step = Action.make("portability/step", { payload: {}, success: Schema.String })
const flow = Flow.make("portability/flow", { payload: {}, success: Schema.String, body: () => step.call({}) })
const register = Interpreter.layer(flow).pipe(
  Layer.provideMerge(step.toLayer(() =>
    Effect.gen(function*() {
      const value = yield* once
      return `${value}:${yield* DurableDeferred.await(gate)}`
    })
  )),
  Layer.provideMerge(Action.layerImplementations)
)
const host = Layer.mergeAll(
  AtomicFileSystem.layer,
  NodeCrypto.layer,
  Jj.layerNoop({})
)
const incarnation = Native.layer(
  {
    filename: join(directory, "state", "engine.sqlite"),
    workspaceRoot: directory,
    owner: { hostId: `${runtime}-${phase}` },
    // The parent test joins the previous child before starting the next one.
    isAlive: () => Effect.succeed(false)
  },
  EngineStore.StepBoundary.layer,
  EngineStore.WorkspaceSandbox.layerFileSystem(),
  register
).pipe(Layer.provide(host))

const result = await Effect.runPromise(
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore.RunStore
    if (phase === "park") {
      yield* flow.execute({}, { executionId: "portable-run", discard: true })
      // Discard schedules the drive; the receipt must wait for its released claim.
      for (let attempt = 0;; attempt++) {
        const run = yield* runs.get("portable-run")
        if (run.status === "suspended" && run.owner === null) break
        if (RunStore.RunStore.isTerminalRunStatus(run.status) || attempt === 200) {
          throw new Error(`portable run did not park: ${run.status}, owner ${JSON.stringify(run.owner)}`)
        }
        yield* Effect.sleep("25 millis")
      }
    } else {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.deferredDone(gate, {
        flowName: flow._tag,
        executionId: "portable-run",
        deferredName: gate.name,
        exit: Exit.succeed("approved")
      })
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((yield* runs.get("portable-run")).status === "completed") break
        yield* Effect.sleep("25 millis")
      }
    }
    const output = phase === "park" ? Option.none() : yield* flow.poll("portable-run")
    const run = yield* runs.get("portable-run")
    return {
      runtime,
      phase,
      status: run.status,
      owner: run.owner,
      dispatches: readFileSync(marker, "utf8").trim().split("\n").length,
      result: Option.isSome(output) && output.value._tag === "Complete" && Exit.isSuccess(output.value.exit)
        ? output.value.exit.value
        : null
    }
  }).pipe(Effect.provide(incarnation), Effect.provide(NodeCrypto.layer), Effect.scoped)
)
console.log(JSON.stringify(result))
