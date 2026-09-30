/**
 * Refreshes a registry after editing only a helper, under real Node.
 *
 * Run by `ExecutableNativeRefresh.test.ts` as `node helper-refresh.ts <root>
 * <helper>`: Vitest's module runner would answer the loader's `import()`
 * itself, so only a child process exercises the host's own module cache.
 * `<root>/flows/entry/flow.ts` takes its priority from a relative import; the
 * run loads it, rewrites `<helper>` to export priority 9, refreshes, loads the
 * refreshed descriptor, and prints both priorities and execution digests.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Descriptor from "../../../src/Descriptor.ts"
import * as Executable from "../../../src/Executable.ts"
import * as Registry from "../../../src/Registry.ts"

const [root, helper] = process.argv.slice(2) as [string, string]
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const load = Effect.gen(function*() {
  const registry = yield* Registry.Registry
  const descriptor = yield* registry.get("entry")
  const executable = yield* Executable.fromDescriptor(descriptor, { delegates: [] })
  return { priority: executable.lowered.priority, digest: Descriptor.executionDigest(descriptor) }
})

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const registry = yield* Registry.Registry
  const before = yield* load
  yield* fs.writeFileString(helper, "export const priority: number = 9\n")
  yield* registry.refresh()
  const after = yield* load
  return { before, after }
})

const result = await Effect.runPromise(
  program.pipe(
    Effect.provide(Registry.layerProject({ root }).pipe(Layer.provideMerge(platform)))
  )
)
process.stdout.write(JSON.stringify(result))
