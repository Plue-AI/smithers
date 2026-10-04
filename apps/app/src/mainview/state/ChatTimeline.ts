import type { Card, Message } from "./AppState"
import type { InitMessage } from "../Onboarding"

/** Decode-only: persisted sessions still carry the retired chat filter's kinds (AppState `chatFilter`). */
export const CHAT_KINDS = ["messages", "cards"] as const

export type TimelineEntry =
  | { readonly kind: "message"; readonly message: Message }
  | { readonly kind: "init"; readonly message: InitMessage }
  | { readonly kind: "card"; readonly card: Card }

/** The id a transcript row scrolls and reads by. */
export const entryId = (entry: TimelineEntry): string => entry.kind === "card" ? entry.card.id : entry.message.id
