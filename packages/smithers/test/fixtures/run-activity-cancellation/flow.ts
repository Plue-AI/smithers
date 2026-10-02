import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, FileSystem, Layer, Schema } from "effect"

const Hold = Action.make("cancel-activity/Hold", {
  payload: { marker: Schema.String },
  success: Schema.String,
  error: Schema.Unknown,
  implementationVersion: "cancel-activity/v1",
  nondeterministic: true,
  tier: "irreversible"
})
export const Child = Flow.make("cancel-activity/child", {
  payload: { marker: Schema.String },
  success: Schema.String,
  error: Schema.Unknown,
  body: Node.capture({}, ({ marker }) => Hold.call({ marker }))
})
const Spawn = Action.make("cancel-activity/Spawn", {
  payload: { marker: Schema.String },
  success: Schema.String,
  error: Schema.Unknown,
  implementationVersion: "cancel-activity/v1",
  nondeterministic: true,
  tier: "irreversible"
})

export const layer = Layer.mergeAll(
  Interpreter.layer(Child),
  Spawn.toLayer(({ marker }) =>
    Effect.gen(function*() {
      const instance = yield* FlowRuntime.FlowInstance
      return yield* Child.execute({ marker }, { executionId: `${instance.executionId}/child` })
    }), { implementationVersion: "cancel-activity/v1" })
).pipe(Layer.provideMerge(Hold.toLayer(({ marker }) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    // An owner-controlled readiness boundary; repeated execution is visible.
    yield* fs.writeFileString(marker, `${process.pid}\n`, { flag: "a" })
    return yield* Effect.never
  }), { implementationVersion: "cancel-activity/v1" })))

export default Flow.make("cancel-activity", {
  description: "Hold a native child until public cancellation.",
  capabilities: ["fs:write:**"],
  effects: { reads: [], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { marker: Schema.String },
  success: Schema.String,
  error: Schema.Unknown,
  body: Node.capture({}, ({ marker }) => Spawn.call({ marker }))
})
