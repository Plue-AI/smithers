/** Durable HumanTask producer for the composed TODO approval test. All work is
 * sealed human input: the example engine's unused JJ port performs no effects.
 * SQLite, waiting state, journal, HumanTask validation and restart are real. */
import * as AgentSession from "../../../../smithers/agent/src/AgentSession.ts"
import * as SqlControlRuntime from "../../../../smithers/control/src/SqlControlRuntime.ts"
import * as ApprovalAuthority from "../../../../smithers/control/src/ApprovalAuthority.ts"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Action, Flow, HumanTask, Interpreter } from "@smthrs/flow"
import { Effect, Layer, Option, Schedule, Schema } from "effect"
import { durableEngine } from "../../../../../examples/src/durable-layer.ts"

const Todo = Flow.make("todo", {
  description: "Approve a plan through the installed TODO answer door.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  payload: {}, success: Schema.Json, error: HumanTask.HumanTaskFailed,
  body: () => HumanTask.action.call({ name: "coding-plan-approval", kind: "confirm", prompt: "Proceed with this plan?", maxAttempts: 1 })
})
const [filename, mode, answer] = process.argv.slice(2)
const executionId = "run-1"
const layer = Layer.mergeAll(HumanTask.layer, Interpreter.layer(Todo)).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(SqlControlRuntime.layer({ approvalAuthority: ApprovalAuthority.local }).pipe(
    Layer.provideMerge(durableEngine(filename!, `approval-${mode}`))
  ))
)
const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const state = yield* DurableEngineState.DurableEngineState
  if (mode === "park") {
    yield* Todo.execute({}, { executionId, discard: true })
    const row = yield* state.waiting(executionId).pipe(
      Effect.repeat({ until: Option.isSome, schedule: Schedule.spaced(10) }),
      Effect.timeout(30_000)
    )
    if (Option.isNone(row)) return yield* Effect.die("HumanTask did not park")
    return { runId: executionId, ...row.value }
  }
  const row = yield* state.waiting(executionId)
  if (Option.isNone(row) || row.value.token === null) return yield* Effect.die("No retained approval")
  const signal = JSON.parse(answer!)
  const delivery = yield* AgentSession.deliverSignal({
    runId: executionId as never,
    signal: { name: signal.name, payload: signal.payload },
    principal: { id: "local", kind: "operator", stampedAt: Date.now() }
  })
  if (delivery !== "delivered") return yield* Effect.die(`Signal delivery: ${delivery}`)
  const completed = yield* Todo.execute({}, { executionId })
  return { completed }
}).pipe(Effect.provide(layer))))
process.stdout.write(JSON.stringify(result) + "\n")
