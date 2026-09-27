/**
 * Keyword recall with no host dependencies.
 *
 * Scores every authoritative row in each selected bank by the number of
 * normalized query terms occurring in its key and text, breaks ties by newest
 * update, then applies the shared Smithers-compatible byte cap. There is no
 * recency window: an old match ranks the same as a new one.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import { resolveBanks } from "./internal/ResolveNamespace.ts"
import type * as MemoryError from "./MemoryError.ts"
import * as MemoryStore from "./MemoryStore.ts"
import * as Namespace from "./Namespace.ts"
import * as Recall from "./Recall.ts"

/**
 * A row accepted from the store retrieval seam.
 *
 * @category models
 * @since 0.1.0
 */
export type Row = Pick<MemoryStore.SearchRow, "key" | "text" | "tags" | "status" | "updatedAtMs">

/**
 * Splits a query into the normalized terms scoring compares against.
 *
 * @category models
 * @since 0.1.0
 */
export const normalizeQueryTerms = (value: string): ReadonlyArray<string> =>
  value.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)

/**
 * Scores one row by the number of normalized query terms occurring in its key
 * and text.
 *
 * @category models
 * @since 0.1.0
 */
export const scoreRow = (query: ReadonlyArray<string>, row: Row): number => {
  const haystack = `${row.key} ${row.text}`.normalize("NFKC").toLowerCase()
  return query.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0)
}

const matches = (row: Row, groups: ReadonlyArray<Recall.TagGroup> | undefined): boolean =>
  groups === undefined || groups.every((group) => Namespace.matches(group, row.tags))

const authoritative = (row: Row, groups: ReadonlyArray<Recall.TagGroup> | undefined): boolean =>
  matches(row, groups) && (row.status === undefined || row.status === "accepted")

/**
 * Runs keyword recall against the supplied MemoryStore.
 *
 * @category constructors
 * @since 0.1.0
 */
export const recall = (
  input: Recall.Input
): Effect.Effect<Recall.Output, MemoryError.MemoryError, MemoryStore.MemoryStore> =>
  Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    const banks = yield* resolveBanks(input.banks)
    const terms = normalizeQueryTerms(input.query)
    if (banks.length === 0 || terms.length === 0) return []
    const rows = yield* Effect.all(
      banks.map(({ namespace }) =>
        store.searchRows({
          namespace,
          status: "accepted",
          tagGroups: input.tagGroups
        })
      ),
      { concurrency: 4 }
    )
    const ranked = rows.flatMap((bankRows, index) =>
      bankRows
        .map((row) => ({ ...row, bank: banks[index]?.bank ?? "" }))
        .filter((row) => authoritative(row, input.tagGroups))
        .map((row) => ({
          bank: banks[index]?.bank ?? "",
          key: row.key,
          text: row.text,
          score: scoreRow(terms, row),
          updatedAtMs: row.updatedAtMs
        }))
        .filter((row) => row.score > 0)
    )
    ranked.sort(Recall.compareResults)
    return Recall.capRecallResults(ranked, input.maxTokens)
  })

/**
 * Provides keyword recall as the default replaceable recall slot.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Recall.Recall, never, MemoryStore.MemoryStore> = Recall.layerFrom(recall)
