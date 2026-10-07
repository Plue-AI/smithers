// Invoked by the composed PostgreSQL rehearsal with a process-owned credential.
// This uses the production Action and native transport; provisioning and guest
// execution remain reference-host evidence.
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { NativeCodingError, nativeLayer, NativeTransport, StackProposal } from "../coding/native.ts"
import { CodingError } from "../coding/schema.ts"
import { Propose, stackBaseLayer } from "../coding/stack.ts"

const token = process.env.SMITHERS_NATIVE_REPOSITORY_TOKEN
if (!token) throw new Error("Missing rehearsal credential")
delete process.env.SMITHERS_NATIVE_REPOSITORY_TOKEN
const Publish = Flow.make("test/installed-stack-proposal", {
  payload: {},
  success: StackProposal,
  error: Schema.Union([CodingError, NativeCodingError]),
  body: () => Propose.call({ generation: 7 })
})
const native = nativeLayer({
  repositoryPath: process.env.SMITHERS_STK12_REPOSITORY_PATH,
  helperPath: process.env.SMITHERS_STK12_NATIVE_HELPER,
  sourcePublication: "cloud",
  nativeRepositoryToken: Redacted.make(token)
}).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NativeTransport.layerFrom(NodeServices.layer))))
const runtime = ManagedRuntime.make(
  Layer.mergeAll(Interpreter.layer(Publish), stackBaseLayer.pipe(Layer.provide(native))).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )
)
try {
  console.log(JSON.stringify(await runtime.runPromise(Publish.execute({}, { executionId: "installed-proposal" }))))
} finally {
  await runtime.dispose()
}
