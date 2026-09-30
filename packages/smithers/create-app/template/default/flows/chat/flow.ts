/**
 * The chat flow: a question in, an answer plus cards out.
 *
 * The file's location is its name. `flows/chat/flow.ts` is the flow `chat`, its
 * seat and teaching come from the nearest ancestor AGENT.ts, and its tools come
 * from the nearest ancestor TOOLS.ts. Nothing here names a model.
 *
 * `chat: true` is routing metadata: it tells a host to offer this flow on its
 * turn endpoint rather than its flow-run endpoint. It does not carry a
 * conversation across turns by itself. Each turn opens its own execution from
 * its own payload, so a host that wants continuity replays the history it kept
 * into the next turn's payload.
 */
import { Flow } from "@smthrs/flow"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Schema from "effect/Schema"

export default Flow.make("chat", {
  description: "Answer a question, rendering anything worth showing as a pane.",
  payload: { message: Schema.String },
  success: Schema.Struct({
    answer: Schema.String.annotate({ description: "The prose answer; cards carry the data, so keep it short" }),
    cards: Schema.Array(Schema.String).annotate({ description: "Card ids emitted this turn, in order" })
  }),
  chat: true,
  error: AgentAction.AgentFailure,
  prompt: ({ message }) => message,
  system: [
    "Render every result worth showing with ui/pane, and keep `answer` to a sentence or two saying what the card shows.",
    "Return the id of every card you emitted in `cards`, in emission order."
  ]
})
