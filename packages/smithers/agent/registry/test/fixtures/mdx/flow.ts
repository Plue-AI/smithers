import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import Instructions from "./prompt.mdx"

const Render = Action.make("mdx/Render", {
  implementationVersion: "mdx-render/v1",
  payload: { name: Schema.String },
  success: Schema.String
})

export const layer = Render.toLayer(
  (props) => Effect.sync(() => Instructions(props)),
  { implementationVersion: "mdx-render/v1" }
)

export default Flow.make("mdx", {
  description: "Render an imported typed MDX prompt.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  payload: { name: Schema.String },
  success: Schema.String,
  body: Node.capture({ action: Render.name, implementationVersion: "mdx-render/v1" }, (props) => Render.call(props))
})
