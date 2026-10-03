
import type { Card, Message } from "./AppState"
import type { InitMessage } from "../Onboarding"

export const CHAT_KINDS = ["messages", "cards"] as const
export type ChatKind = typeof CHAT_KINDS[number]
export interface ChatFilter {
  readonly sources: ReadonlyArray<string>
  readonly kinds: ReadonlyArray<ChatKind>
  readonly query: string
}
export const all: ChatFilter = { sources: [], kinds: [], query: "" }
export const active = (filter: ChatFilter): boolean => filter.sources.length > 0 || filter.kinds.length > 0 || filter.query !== ""
const flip = (values: ReadonlyArray<string>, value: string): ReadonlyArray<string> =>
  values.includes(value) ? values.filter(each => each !== value) : [...values, value]
export const toggle = (filter: ChatFilter, target: string): ChatFilter =>
  CHAT_KINDS.includes(target as ChatKind)
    ? { ...filter, kinds: flip(filter.kinds, target) as ReadonlyArray<ChatKind> }
    : { ...filter, sources: flip(filter.sources, target) }

export type MainEntry =
  | { readonly kind: "message"; readonly message: Message }
  | { readonly kind: "init"; readonly message: InitMessage }
  | { readonly kind: "card"; readonly card: Card }

export type TimelineEntry = MainEntry

export const text = (entry: TimelineEntry): string =>
  entry.kind === "card" ? `${entry.card.title}\n${entry.card.body ?? ""}` : entry.message.text ?? ""

/** The id a transcript row scrolls and reads by. */
export const entryId = (entry: TimelineEntry): string => entry.kind === "card" ? entry.card.id : entry.message.id

/** Preserve conversation order and its message, card and text filters. */
export const merge = (main: ReadonlyArray<MainEntry>, filter: ChatFilter = all): ReadonlyArray<TimelineEntry> => {
  const query = filter.query.toLowerCase()
  return main.filter(entry => !filter.sources.includes("chat") &&
    !filter.kinds.includes(entry.kind === "card" ? "cards" : "messages") &&
    (query === "" || text(entry).toLowerCase().includes(query)))
}
