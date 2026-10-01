import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { Child, Land } from "../burndown/flow.ts"
export { layer } from "../burndown/flow.ts"
export default Flow.make("live", {
  description: "Launch later durable children after a live edit.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { root: Schema.String, seconds: Schema.Number, count: Schema.Number },
  success: Schema.String,
  error: Schema.Unknown,
  body: Node.capture({}, ({ root, seconds, count }) => {
    let children = Child.child({ root, seconds, count, index: 1 })
    for (let index = 2; index <= count; index++) {
      children = children.pipe(Node.andThen(Child.child({ root, seconds, count, index })))
    }
    let plan = children.pipe(Node.andThen(Land.call({ root, count, index: 1 })))
    for (let index = 2; index <= count; index++) plan = plan.pipe(Node.andThen(Land.call({ root, count, index })))
    return plan
  })
})
