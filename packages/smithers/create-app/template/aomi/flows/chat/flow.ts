/**
 * The chat flow: chain questions in, an answer plus cards out.
 *
 * This is the Build page's conversation. `chat: true` is routing metadata: the
 * Worker offers this flow on `POST /api/agent/turn` and refuses it on
 * `POST /api/flows/run`. It does not carry the realm across turns by itself.
 * Each turn opens its own execution, so continuity is whatever the host
 * replays into the next turn's payload, and a follow-up question re-opens the
 * fork unless the session has already put that history back in front of the
 * model.
 *
 * The file's location is its name. `flows/chat/flow.ts` is the flow `chat`, its
 * seat and teaching come from the root AGENT.ts, and its tools come from the
 * root TOOLS.ts. Nothing here names a model.
 */
import { Flow } from "@smthrs/flow"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Schema from "effect/Schema"

export default Flow.make("chat", {
  description: "Answer a question about any EVM chain against an in-memory fork, rendering results as panes.",
  payload: { message: Schema.String },
  success: Schema.Struct({
    answer: Schema.String.annotate({ description: "The prose answer; cards carry the data, so keep it short" }),
    cards: Schema.Array(Schema.String).annotate({ description: "Card ids emitted this turn, in order" })
  }),
  chat: true,
  error: AgentAction.AgentFailure,
  prompt: ({ message }) => message,
  system: [
    "Open a fork with tevm/fork before the first chain read of a session. Later turns reuse it; do not fork again unless the user names a different block. The host configures the chain endpoint; tevm/fork cannot change chains.",
    "Read chain state with tevm/getBalance, tevm/readContract, tevm/call, tevm/getBlock, and tevm/simulate. Never answer a factual question about chain state from memory.",
    "Render every result you read with ui/pane. Put the numbers in the card and keep `answer` to a sentence or two that says what the card shows.",
    "Return the id of every card you emitted in `cards`, in emission order."
  ]
})
