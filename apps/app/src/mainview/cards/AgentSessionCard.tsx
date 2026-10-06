import type { CardFamily } from "./CardFamily"

/*
 * #3730: an agent CLI started from this conversation. The card is the binding
 * of its session to the conversation; the session's own entries are what the
 * transcript shows (App.tsx), so the card renders no body of its own and the
 * transcript filter (ApprovalDeciders.shownInTranscript) leaves its frame out.
 */
export const agentSessionCardFamily: CardFamily<"agent-session"> = {
  "agent-session": { render: () => null, pill: () => "" }
}
