/** One bounded, cited block of project memory for every model step after planning.
 *
 * Planning gathers the evidence once: accepted notes (saved facts), the native
 * history's commit descriptions and the fresh wiki pages Jev selected. The
 * finalized Plan keeps this block, so the implementation, repair and
 * correction steps open with the same bytes, which keeps the provider's
 * prompt-cache prefix stable across every atom of a run. The rows reach a
 * model only as opening memory (`AgentAction` `memory`), so a judged step's
 * run-start relevance reading still withholds the rows Jev is confident a
 * step does not need, and journals what it kept.
 */
import * as MemorySource from "../../packages/smithers/agent/memory/src/Source.ts"
import { bank as factsBank } from "./learnings.ts"
import type { PlanningContext } from "./planning.ts"
import type { MemoryRow, ProjectMemory } from "./schema.ts"

/** The rendered block's UTF-8 budget: the size a native run's opening memory packs to. */
export const maxBytes = 16 * 1024
/** The newest commit descriptions the block carries. */
export const maxCommitNotes = 20
export const wikiBank = "wiki"
export const commitsBank = "commits"

const size = (rows: ReadonlyArray<MemoryRow>) => new TextEncoder().encode(MemorySource.render(rows)).length

/**
 * The block for a gathered planning context, in citation order: accepted
 * notes first (a person kept them), then the newest commit notes, then the
 * wiki pages. Each row is whole or absent: a row that does not fit the
 * remaining budget is left out and the next one is tried, so a truncated
 * lesson never reads as a complete one.
 */
export const projectMemory = (
  context: Pick<PlanningContext, "history" | "memory" | "learnings">,
  budget: number = maxBytes
): ProjectMemory => {
  const candidates: Array<MemoryRow> = [
    ...(context.learnings ?? []).map((learning) => ({
      origin: "recall" as const,
      bank: factsBank,
      key: learning.id,
      text: learning.text
    })),
    ...context.history.toReversed().filter((row) => row.description.trim() !== "").slice(0, maxCommitNotes).map((
      row
    ) => ({ origin: "recall" as const, bank: commitsBank, key: row.changeId, text: row.description.trim() })),
    ...context.memory.map((note) => ({
      origin: "recall" as const,
      bank: wikiBank,
      key: note.id,
      text: `${note.title} (source ${note.sourceRevision})\n${note.markdown}`
    }))
  ]
  const kept: Array<MemoryRow> = []
  for (const row of candidates) {
    if (kept.length < 64 && size([...kept, row]) <= budget) kept.push(row)
  }
  return kept
}

/** A step payload's block as its opening memory rows; none when the plan predates the block. */
export const stepMemory = (payload: { readonly memory?: ProjectMemory | undefined }) => payload.memory ?? []

/** The step's prompt JSON without its memory, which reaches the model only through the gate. */
export const withoutMemory = <A extends { readonly memory?: unknown }>(payload: A): Omit<A, "memory"> => {
  const { memory: _, ...rest } = payload
  return rest
}
