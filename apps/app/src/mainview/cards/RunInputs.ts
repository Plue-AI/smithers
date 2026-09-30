/*
 * What went INTO a run (UX pass 2026-09-28, the drawer's In tab): the memory
 * it was handed and what Jev withheld, the box it ran on, and the names of
 * the secrets that box can reach. Pure reads of the journal the card holds
 * and of cards already in the conversation; nothing here fetches.
 *
 * - Memory: `runMemoryOf` (@smthrs/gateway/RunTrace), the fold `smthrs status`
 *   shares, over the `control.agent.relevance-settled` rows.
 * - Where: the run's box (`workspaceId`), by name when a workspace card for it
 *   is open.
 * - Secrets: the names and egress hosts the box can reach today, from the
 *   repository's secrets card when the conversation holds one. They are the
 *   box's, listed under it; no run journals which secret a call used. Values
 *   never reach the client (SecretsSeam).
 */
import type { Card } from "../state/AppState"
import { runMemoryOf, type RunMemory } from "./RunTrace"

type RunCard = Extract<Card, { kind: "run-trace" }>

export interface RunInputs {
  readonly memory?: RunMemory
  /** The box the run ran on: its name when known, else its id. */
  readonly runsOn?: string
  readonly secrets: ReadonlyArray<{ readonly name: string; readonly hosts: ReadonlyArray<string> }>
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
