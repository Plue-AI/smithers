// Real durable Control/engine/gateway stack; only analysis is omitted from this
// fixture so the test reaches registration's existing HumanTask without a model.
import { NodeControl, Serve } from "@smthrs/cli"
import { HumanTask } from "@smthrs/flow"
import * as Executable from "../../../../smithers/agent/registry/src/Executable.ts"
import { Effect, Layer } from "effect"
import * as ScriptedJudge from "../../../../smithers/agent/src/ScriptedJudge.ts"

const root = process.argv[2]
const port = Number(process.argv[3])
const credential = "registration-integration-only"
const registry = NodeControl.layerRegistry(root)
const engine = NodeControl.engineDurable(root, registry, { credential })
const modules = Executable.layer({ delegates: [] }).pipe(Layer.provideMerge(HumanTask.layer), Layer.orDie)
const config = { root, credential, evaluator: ScriptedJudge.layer, approvalChannel: true }
const control = NodeControl.layerControl(config, registry, engine, modules)
const server = NodeControl.layerGateway(Serve.health(root), { host: "127.0.0.1", port, credential }, root, engine)
await Effect.runPromise(Layer.launch(server.pipe(Layer.provide(control))))
