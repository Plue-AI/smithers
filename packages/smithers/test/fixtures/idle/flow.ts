import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, FileSystem, Schema } from "effect"

const Hold = Action.make("idle/Hold", {
  implementationVersion: "cli-idle/v1",
  payload: { marker: Schema.String },
  success: Schema.String,
  error: Schema.Unknown,
  nondeterministic: true,
  tier: "irreversible"
})

export const layer = Hold.toLayer(({ marker }) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(marker, `${process.pid}\n`)
    return yield* Effect.never
  }), { implementationVersion: "cli-idle/v1" })

export default Flow.make("idle", {
  description: "Run a real module action until the operator cancels it.",
  capabilities: ["fs:write:**"],
  effects: { reads: [], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { marker: Schema.String },
  success: Schema.String,
  error: Schema.Unknown,
  body: Node.capture({}, ({ marker }) => Hold.call({ marker }))
})
