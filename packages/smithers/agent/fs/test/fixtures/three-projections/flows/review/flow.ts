import { Flow, Node } from "@smthrs/flow"
import * as Schema from "effect/Schema"

export default Flow.make("review", {
  payload: Schema.Struct({
    number: Schema.Number
  }),
  success: Schema.Struct({
    accepted: Schema.Boolean,
    number: Schema.Number
  }),
  body: ({ number }) =>
    Node.succeed({
      accepted: true,
      number
    })
})
