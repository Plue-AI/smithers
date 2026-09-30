/** Measures and loads a template closure with the actual Node module loader. */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, FileSystem, Layer } from "effect"
import * as Descriptor from "../../../src/Descriptor.ts"
import * as Executable from "../../../src/Executable.ts"
import * as Registry from "../../../src/Registry.ts"

const root = process.argv[2]!
const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const registry = yield* Registry.Registry
  const before = yield* registry.get("entry")
  const loaded = yield* Effect.result(Executable.fromDescriptor(before, { delegates: [] }))
  if (loaded._tag === "Failure") return { code: loaded.failure.code, message: loaded.failure.message }
  yield* fs.writeFileString(`${root}/flows/entry/helper.ts`, "export const priority = 9\n")
  const stale = yield* Effect.flip(Executable.fromDescriptor(before, { delegates: [] }))
  yield* registry.refresh()
  const after = yield* registry.get("entry")
  return {
    priority: loaded.success.lowered.priority,
    imports: (before.body as Descriptor.BodyRefModule).imports?.map((entry) => entry.path),
    stale: stale.code,
    before: Descriptor.executionDigest(before),
    after: Descriptor.executionDigest(after),
    leftovers: (yield* fs.readDirectory(`${root}/flows/entry`)).filter((name) => name.startsWith(".smithers-"))
  }
})
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const result = await Effect.runPromise(program.pipe(
  Effect.provide(Registry.layerProject({ root }).pipe(Layer.provideMerge(platform)))
))
process.stdout.write(JSON.stringify(result))
