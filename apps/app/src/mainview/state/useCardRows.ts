/*
 * The transcript's cards, read live from the store.
 *
 * Why this exists rather than a bare `useLiveQuery(collections.cards)`: the
 * hook's row type is INFERRED from the collection, and TanStack DB's
 * inference gives up once the `Card` union passes thirty members — TResult
 * falls back to its `object` constraint, so `data` types as `{}[]` and every
 * `card.id` / `<CardView card={card}>` downstream stops compiling. Measured
 * on this tree: 29 members infer, 30 do not; the five target-graph cards
 * (graph, run-timeline, run-history, affected, ci-matrix) took it over.
 *
 * Naming the type arguments skips that inference entirely. The collection's
 * own row type is the truth — `createCardCollection` keys `Card` records with
 * `CardSchema` — so this states it in ONE place instead of at every reader.
 */
import type { Collection, NonSingleResult } from "@tanstack/db"
import { eq, useLiveQuery } from "@tanstack/react-db"
import type { AppCollections } from "./AppStore"
import type { Card, FlowDurationsRow } from "./AppState"

/** The cards collection as a live array of `Card`, in store order. */
export const useCardRows = (cards: AppCollections["cards"]): ReadonlyArray<Card> => {
  const { data } = useLiveQuery<Card, string, Record<string, never>>(
    cards as unknown as Collection<Card, string, Record<string, never>> & NonSingleResult
  )
  return data.filter(card => card.kind !== "retired" || card.title !== "")
}


/** Filter at the collection query so unrelated streamed cards do not repaint every catalog consumer. */
export const useWorkflowCatalogRows = (cards: AppCollections["cards"]): ReadonlyArray<Extract<Card, { kind: "workflow-list" }>> => {
  const { data } = useLiveQuery(q => q.from({ card: cards as unknown as Collection<Card, string, Record<string, never>> })
    .where(({ card }) => eq(card.kind, "workflow-list")), [cards])
  // The collection owns CardSchema; the exact predicate above narrows its union.
  return data as ReadonlyArray<Extract<Card, { kind: "workflow-list" }>>
}

/** The dispatcher listings, filtered at the collection: a plan card reads its schedules from these. */
export const useTriggerListRows = (cards: AppCollections["cards"]): ReadonlyArray<Extract<Card, { kind: "trigger-list" }>> => {
  const { data } = useLiveQuery(q => q.from({ card: cards as unknown as Collection<Card, string, Record<string, never>> })
    .where(({ card }) => eq(card.kind, "trigger-list")), [cards])
  // The collection owns CardSchema; the exact predicate above narrows its union.
  return data as ReadonlyArray<Extract<Card, { kind: "trigger-list" }>>
}

/** One TODO's card row, filtered at the collection: Review & merge reads the TODO it is bound to. */
export const useTodoCardRow = (cards: AppCollections["cards"], n: number): Extract<Card, { kind: "todo" }> | undefined => {
  const { data } = useLiveQuery(q => q.from({ card: cards as unknown as Collection<Card, string, Record<string, never>> })
    .where(({ card }) => eq(card.id, `todo:${n}`)), [cards, n])
  // The collection owns CardSchema; the id predicate above names one row.
  const row = (data as ReadonlyArray<Card>)[0]
  return row?.kind === "todo" ? row : undefined
}

/**
 * The files this conversation has read, filtered at the collection.
 *
 * A graph card's Code tab renders one of these inline rather than reading
 * the file itself: the card `files.read` writes IS the evidence, and the
 * hover and definition answers land on the same payload.
 */
export const useFileCardRows = (cards: AppCollections["cards"]): ReadonlyArray<Extract<Card, { kind: "file" }>> => {
  const { data } = useLiveQuery(q => q.from({ card: cards as unknown as Collection<Card, string, Record<string, never>> })
    .where(({ card }) => eq(card.kind, "file")), [cards])
  // The collection owns CardSchema; the exact predicate above narrows its union.
  return data as ReadonlyArray<Extract<Card, { kind: "file" }>>
}

/**
 * Every measured duration row the session holds.
 *
 * One live read for the whole transcript: a plan card filters to its own
 * repository, workspace and flow. The collection is small (one row per measured action
 * tag of the flows this session has opened) and empty until something reads
 * the projection, which is what a flow with no history looks like.
 */
export const useFlowDurationRows = (
  flowDurations: AppCollections["flowDurations"]
): ReadonlyArray<FlowDurationsRow> => useLiveQuery(flowDurations).data
