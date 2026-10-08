// Recorded Jev is the only extraction substitute. Read the real install's
// run-bound evidence and execute the production typed Learning flow.
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Layer, ManagedRuntime } from "effect"
import Learning, { layer, machineBinding } from "../../learning/flow.ts"

const [origin, host, run] = process.argv.slice(2)
if (!origin || !host || !run) throw new Error("Learning extraction requires its install binding")
const evaluator = Evaluator.layerScripted(() => ({ durable_0: { probability: 0 }, issue_0: { probability: 1 } }))
const runtime = ManagedRuntime.make(Layer.mergeAll(
  Interpreter.layer(Learning),
  layer.pipe(Layer.provide(Layer.merge(evaluator, machineBinding({ origin, host, credential: process.env.SMITHERS_LEARNING_TEST_CREDENTIAL }))))
).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer), Layer.provideMerge(NodeServices.layer)))
try {
  const output = await runtime.runPromise(Learning.execute({ todo: 7 }, { executionId: run }))
  process.stdout.write(JSON.stringify(output))
} finally { await runtime.dispose() }
