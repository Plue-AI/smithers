import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

const Answer = AgentAction.make("fixture/Answer", {
  payload: { question: Schema.String },
  output: Schema.Struct({ accepted: Schema.Boolean }),
  seat: "test:host-seat",
  prompt: ({ question }) => question,
  corrections: 0
})

export const layer = Answer.layer
export default Flow.make("agent", {
  description: "Answer with the host's configured seat.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { question: Schema.String },
  success: Schema.Struct({ accepted: Schema.Boolean }),
  error: AgentAction.AgentFailure,
  body: Node.capture({ action: Answer.name }, ({ question }) => Answer.call({ question }))
})
