import type { Subagent } from "@smthrs/rpc/SubagentCard"
import { live } from "@smthrs/rpc/WorkerControls"
import type { Card, Message } from "./AppState"
import type { InitMessage } from "../Onboarding"
import { agentSubagent } from "./Subagents"

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

type AgentCard = Extract<Card, { kind: "agent" }>

/** One subagent of the conversation: its card, its lane color and what its card draws. */
export interface ChatSubagent {
  readonly id: string
  readonly card: AgentCard
  readonly color: number
  readonly subagent: Subagent
}

export type TimelineEntry =
  | MainEntry
  /** Adjacent subagents share one header and one grid. */
  | { readonly kind: "subagents"; readonly id: string; readonly subagents: ReadonlyArray<ChatSubagent> }
  /** `◉ {title} finished`, under the grid the subagent settled in. */
  | { readonly kind: "finished"; readonly id: string; readonly subagent: ChatSubagent }

/** Lane colors in creation order, so the first six subagents never share one. */
export const LANE_COLORS = 6

/** The conversation's subagents, colored by creation order so a filter never recolors one. */
export const subagentsFromCards = (cards: ReadonlyArray<Card>): ReadonlyArray<ChatSubagent> =>
  cards.filter((card): card is AgentCard => card.kind === "agent")
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((card, index) => ({ id: card.id, card, color: index % LANE_COLORS, subagent: agentSubagent(card) }))

const subagentText = (subagent: Subagent): string =>
  [subagent.title, ...subagent.entries.map(entry => entry.kind === "text" ? entry.text : `${entry.tool} ${entry.target}`)].join("\n")

export const text = (entry: TimelineEntry): string =>
  entry.kind === "subagents" ? entry.subagents.map(each => subagentText(each.subagent)).join("\n")
    : entry.kind === "finished" ? entry.subagent.subagent.title
    : entry.kind === "card" ? `${entry.card.title}\n${entry.card.body ?? ""}` : entry.message.text ?? ""

/** The id a transcript row scrolls and reads by. */
export const entryId = (entry: TimelineEntry): string =>
  entry.kind === "subagents" || entry.kind === "finished" ? entry.id : entry.kind === "card" ? entry.card.id : entry.message.id

/**
 * The transcript in order, with each run of adjacent subagent cards folded
 * into one grid and a finished row under it for every settled member. The
 * source, kind and text filters apply to each card before it joins a grid.
 */
export const merge = (main: ReadonlyArray<MainEntry>, subagents: ReadonlyArray<ChatSubagent>, filter: ChatFilter = all): ReadonlyArray<TimelineEntry> => {
  const byId = new Map(subagents.map(each => [each.id, each]))
  const query = filter.query.toLowerCase()
  const out: Array<TimelineEntry> = []
  let batch: Array<ChatSubagent> = []
  const flush = (): void => {
    if (batch.length === 0) return
    out.push({ kind: "subagents", id: `subagents:${batch[0]!.id}`, subagents: batch })
    for (const each of batch) if (!live(each.subagent.status)) out.push({ kind: "finished", id: `finished:${each.id}`, subagent: each })
    batch = []
  }
  for (const entry of main) {
    const subagent = entry.kind === "card" ? byId.get(entry.card.id) : undefined
    if (filter.sources.includes(subagent?.id ?? "chat") || filter.kinds.includes(entry.kind === "card" ? "cards" : "messages")) continue
    if (query !== "" && !(subagent === undefined ? text(entry) : subagentText(subagent.subagent)).toLowerCase().includes(query)) continue
    if (subagent !== undefined) {
      batch.push(subagent)
      continue
    }
    flush()
    out.push(entry)
  }
  flush()
  return out
}
