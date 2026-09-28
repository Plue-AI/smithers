import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

const ComposedAction = Flow.make("composed/action", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("composed action")
})

export default Flow.make("composed", {
  description: "Composed",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  payload: {},
  success: Schema.String,
  body: Node.capture(
    { action: ComposedAction._tag },
    () =>
      Node.map(
        ComposedAction.call({}),
        Node.capture({ suffix: " callback output" }, function(value: string) {
          return value + this.suffix
        })
      )
  )
})
