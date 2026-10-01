import { Action, Flow, HumanTask, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { helperVersion } from "./helper.ts"

const layerVersion = "approved-layer"
const changeSource = (root: string) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  for (const file of ["flow.ts", "helper.ts", "layer.ts"]) {
    const path = `${root}/flows/snapshot/${file}`
    const original = yield* fs.readFileString(path)
    yield* fs.writeFileString(path, original.replaceAll("approved-", "unapproved-"))
  }
})
export const Prepare = Action.make("snapshot/Prepare", {
  implementationVersion: "snapshot/v1",
  payload: { root: Schema.String, early: Schema.Boolean },
  success: Schema.Void,
  error: Schema.Unknown
})
const Probe = Action.make("snapshot/Probe", {
  implementationVersion: "snapshot/v1",
  payload: { root: Schema.String, entry: Schema.String, index: Schema.Number, edit: Schema.Boolean },
  success: Schema.String,
  error: Schema.Unknown
})
export const Child = Flow.make("snapshot/Child", {
  payload: Probe.payloadSchema,
  success: Schema.String,
  error: Schema.Unknown,
  body: Node.capture({ action: Probe.name, implementationVersion: "snapshot/v1" }, Probe.call)
})
export const layer = Layer.mergeAll(
  Interpreter.layer(Child),
  HumanTask.layer,
  Prepare.toLayer(({ root, early }) => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(`${root}/root-started`, "approved-root")
    if (early) yield* changeSource(root)
  }), { implementationVersion: "snapshot/v1" }),
  Probe.toLayer(({ root, entry, index, edit }) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const result = `${entry}/${helperVersion}/${layerVersion}/${index}`
      const filename = `${root}/observed-${index}`
      yield* fs.writeFileString(filename, result)
      if (index === 1 && edit) yield* changeSource(root)
      return result
    }), { implementationVersion: "snapshot/v1" })
)
