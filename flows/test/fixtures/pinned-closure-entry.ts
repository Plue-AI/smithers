// Process-runtime component fixture. No replacement loader or digest algorithm:
// the source root is the materialization contract supplied by the machine host.
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action } from "@smthrs/flow"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as Snapshot from "@smthrs/registry/ExecutionSnapshot"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer } from "effect"
import { bindRepositoryRegistry } from "../../repository/registry.ts"

const [root, expected] = process.argv.slice(2)
if (!root) throw new Error("Missing immutable source root")
const result = await Effect.runPromise(Effect.gen(function*() {
  const snapshots = yield* Snapshot.makeFileSystem({ root })
  const source = yield* Registry.make({
    sources: [{ root: `${root}/flows`, source: "project", naming: "path", lockfileRoot: root }],
    snapshots
  })
  const descriptor = yield* source.get("todo")
  const digest = expected ?? Descriptor.executionDigest(descriptor)!
  const registry = bindRepositoryRegistry(source, Registry.makeNoop(), "a".repeat(64), [], digest)
  yield* registry.loadBody("todo", digest)
  const retained = expected === undefined ? descriptor : (yield* snapshots.restore(digest)).descriptor
  const executable = yield* Executable.fromDescriptor(retained, { delegates: [], snapshots })
  yield* snapshots.pin(executable)
  const output = yield* executable.flow.execute({ input: {} }).pipe(
    Effect.provide(executable.layer),
    Effect.provide(Action.layerImplementations),
    Effect.provide(FlowEngine.layerMemory)
  )
  return { digest, output }
}).pipe(
  Effect.provide(Discovery.layer),
  Effect.provide(Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer)),
  Effect.scoped
) as Effect.Effect<{ digest: string; output: unknown }, unknown>)
process.stdout.write(JSON.stringify(result))
