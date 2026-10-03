/** Bounded conversation context shared by kept command selection. */
import type {   Message } from "./AppState"

export const TAIL_MAX_MESSAGES = 12

export const TAIL_MAX_CHARS = 4000

export interface RecommendTailEntry {
  readonly role: "user" | "assistant" | "system"
  readonly text: string
}

export const recommendTail = (
  messages: ReadonlyArray<Pick<Message, "role" | "text" | "act">>
): ReadonlyArray<RecommendTailEntry> => {
  const entries = messages
    .filter((message) => message.act === undefined && message.text.trim() !== "")
    .slice(-TAIL_MAX_MESSAGES)
    .map((message): RecommendTailEntry => ({
      role: message.role === "user" ? "user" : "assistant",
      text: message.text.trim()
    }))
  const total = (rows: ReadonlyArray<RecommendTailEntry>): number => rows.reduce((sum, row) => sum + row.text.length, 0)
  let tail = entries
  while (tail.length > 1 && total(tail) > TAIL_MAX_CHARS) tail = tail.slice(1)
  const only = tail[0]
  if (tail.length === 1 && only !== undefined && only.text.length > TAIL_MAX_CHARS) {
    tail = [{ role: only.role, text: only.text.slice(-TAIL_MAX_CHARS) }]
  }
  return tail
}
