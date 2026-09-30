/** Actual host loader identity/refusal boundary; no Vitest module interception. */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, FileSystem, Layer } from "effect"
import * as Descriptor from "../../../src/Descriptor.ts"
import * as Executable from "../../../src/Executable.ts"
import * as Registry from "../../../src/Registry.ts"

const [root, helper] = process.argv.slice(2) as [string, string]
const load = (descriptor: Descriptor.FlowDescriptor) =>
  Effect.result(Executable.fromDescriptor(descriptor, { delegates: [] })).pipe(
    Effect.map((result) =>
      result._tag === "Failure"
        ? { code: result.failure.code, message: result.failure.message }
        : { priority: result.success.lowered.priority }
    )
  )
const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const registry = yield* Registry.Registry
  const previous = yield* registry.get("entry")
  const before = yield* load(previous)
  yield* fs.writeFileString(
    helper,
    "globalThis.__identityHelperEvaluations = (globalThis.__identityHelperEvaluations ?? 0) + 1; export const priority = 9\n"
  )
  const stale = yield* load(previous)
  yield* registry.refresh()
  const fresh = yield* registry.get("entry")
  const after = yield* load(fresh)
  return {
    before,
    after,
    stale,
    previousDigest: Descriptor.executionDigest(previous),
    freshDigest: Descriptor.executionDigest(fresh),
    helperEvaluations: Reflect.get(globalThis, "__identityHelperEvaluations") ?? 0,
    entryEvaluations: Reflect.get(globalThis, "__identityEntryEvaluations") ?? 0,
    leftovers: (yield* fs.readDirectory(`${root}/flows/entry`)).filter((name) => name.startsWith(".smithers-"))
  }
})
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const result = await Effect.runPromise(program.pipe(
  Effect.provide(Registry.layerProject({ root }).pipe(Layer.provideMerge(platform)))
))
process.stdout.write(JSON.stringify(result))
