/*
 * What went INTO a run (UX pass 2026-09-28, the drawer's In tab): the memory
 * it was handed and what Jev withheld, the box it ran on, and the names of
 * the secrets that box can reach. Pure reads of the journal the card holds
 * and of cards already in the conversation; nothing here fetches.
 *
 * - Memory: `control.agent.relevance-settled` journals each relevance reading
 *   as ids, digests and probabilities, never text (AgentEvent.RelevanceSettled).
 *   An item any reading kept is in; one only ever withheld is withheld.
 * - Where: the run's box (`workspaceId`), by name when a workspace card for it
 *   is open.
 * - Secrets: the names and egress hosts the box can reach today, from the
 *   repository's secrets card when the conversation holds one. They are the
 *   box's, listed under it; no run journals which secret a call used. Values
 *   never reach the client (SecretsSeam).
 */
import type { Card } from "../state/AppState"
import type { JournalRecord } from "./RunTrace"

type RunCard = Extract<Card, { kind: "run-trace" }>

export interface MemoryItem {
  readonly id: string
  readonly kind: string
  /** How likely the item is needed: 1 − Jev's probability that it is not. */
  readonly relevance: number
}

export interface RunMemory {
  readonly kept: ReadonlyArray<MemoryItem>
  readonly withheld: ReadonlyArray<MemoryItem>
}

export interface RunInputs {
  readonly memory?: RunMemory
  /** The box the run ran on: its name when known, else its id. */
  readonly runsOn?: string
  readonly secrets: ReadonlyArray<{ readonly name: string; readonly hosts: ReadonlyArray<string> }>
}

const object = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined

const itemsOf = (value: unknown): ReadonlyArray<MemoryItem> =>
  Array.isArray(value) ? value.flatMap((raw) => {
    const item = object(raw)
    return typeof item?.id === "string" && typeof item.p === "number"
      ? [{ id: item.id, kind: typeof item.kind === "string" ? item.kind : "", relevance: 1 - item.p }]
      : []
  }) : []

/** Every relevance reading folded to the items kept and the items only ever withheld; absent when Jev never read. */
export const runMemoryOf = (journal: ReadonlyArray<JournalRecord>): RunMemory | undefined => {
  const kept = new Map<string, MemoryItem>()
  const withheld = new Map<string, MemoryItem>()
  let read = false
  for (const row of journal) {
    if (row.kind !== "control.agent.relevance-settled") continue
    read = true
    const payload = object(row.payload)
    /* A reading also weighs flows, skills and instructions; the memory row counts memory. */
    for (const item of itemsOf(payload?.kept)) if (item.kind === "memory") kept.set(item.id, item)
    for (const item of itemsOf(payload?.withheld)) if (item.kind === "memory") withheld.set(item.id, item)
  }
  if (!read) return undefined
  const byRelevance = (a: MemoryItem, b: MemoryItem) => b.relevance - a.relevance || a.id.localeCompare(b.id)
  return {
    kept: [...kept.values()].sort(byRelevance),
    withheld: [...withheld.values()].filter((item) => !kept.has(item.id)).sort(byRelevance)
  }
}

/** The memory row's words: `memory · 7 in · 4 withheld`. */
export const memoryWords = (memory: RunMemory): string =>
  memory.withheld.length === 0 ? `memory · ${memory.kept.length} in`
    : `memory · ${memory.kept.length} in · ${memory.withheld.length} withheld`

export const runInputsOf = (card: RunCard, cards: ReadonlyArray<Card>): RunInputs => {
  const memory = runMemoryOf(card.payload.events ?? [])
  const { workspaceId, repo } = card.payload
  const box = workspaceId === undefined ? undefined
    : cards.find((held): held is Extract<Card, { kind: "workspace" }> => held.kind === "workspace" && held.payload.workspaceId === workspaceId)
  const secrets = cards.find((held): held is Extract<Card, { kind: "secrets" }> => held.kind === "secrets" && held.payload.repo === repo)
  return {
    ...(memory === undefined ? {} : { memory }),
    ...(workspaceId === undefined ? {} : { runsOn: box?.payload.name ?? workspaceId.slice(0, 8) }),
    secrets: (secrets?.payload.secrets ?? []).filter((secret) => secret.reconnect !== true)
      .map((secret) => ({ name: secret.name, hosts: secret.hosts }))
  }
}
