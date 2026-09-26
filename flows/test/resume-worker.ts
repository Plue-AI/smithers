import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Action, HumanTask, Interpreter } from "@smthrs/flow"
import * as DurableDeferred from "@smthrs/flow/DurableDeferred"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Effect, Layer, Option, Schema } from "effect"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import ReleaseContent from "../release-content/flow.ts"
import { contentInput } from "../release-support/input.ts"
import { actionLayers } from "../release-support/operations.ts"
import { agentLayers } from "../release-support/runtime.ts"
import { scriptedSeats, scriptedTemplate } from "./fixtures.ts"

const root = process.argv[2]!
const phase = process.argv[3]!
const countsFile = join(root, ".flows", "counts.json")
const counts: Record<string, number> = phase === "start" ? {} : JSON.parse(await readFile(countsFile, "utf8"))
const input = contentInput({ dryRun: false, from: "v0.35.0", channels: { blog: false, thread: false } }, "1.0.0-rc.1")
const host = NodeRuntime.layerHost(
  {
    filename: join(root, ".flows", "engine.db"),
    workspaceRoot: root,
    owner: { hostId: "release-subprocess" },
    signals: []
  },
  Layer.mergeAll(
    actionLayers({ root, evaluator: scriptedTemplate }),
    agentLayers(scriptedSeats(counts), 250_000, scriptedTemplate),
    HumanTask.layer,
    Interpreter.layer(ReleaseContent)
  ).pipe(Layer.provideMerge(Action.layerImplementations))
)
const result = await Effect.runPromise(Effect.scoped(
  Effect.gen(function*() {
    if (phase === "resume") {
      const state = yield* DurableEngineState.DurableEngineState
      const row = yield* state.waiting("process-resume")
      if (Option.isNone(row)) return yield* Effect.die("Run did not remain parked")
      yield* HumanTask.answer({ token: Schema.decodeUnknownSync(DurableDeferred.Token)(row.value.token), value: true })
      return yield* ReleaseContent.execute(input, { executionId: "process-resume" })
    }
    yield* ReleaseContent.execute(input, { executionId: "process-resume", discard: true })
    const state = yield* DurableEngineState.DurableEngineState
    const row = yield* state.waiting("process-resume")
    if (Option.isNone(row)) return yield* Effect.die("Run did not park")
    return { status: "waiting", reason: row.value.reason }
  }).pipe(Effect.provide(host))
))
await writeFile(countsFile, JSON.stringify(counts))
process.stdout.write(JSON.stringify({ result, counts }) + "\n")
