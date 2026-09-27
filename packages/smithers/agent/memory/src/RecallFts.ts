/**
 * SQLite FTS5 recall binding.
 *
 * Terms are quoted independently, preserving FTS5 implicit AND semantics
 * while preventing user input from becoming an operator or column selector.
 * The store owns enablement and authoritative SQL filtering; a disabled
 * namespace kind therefore remains a loud `fts_not_enabled` MemoryError.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as FtsQuery from "./internal/FtsQuery.ts"
import { resolveBanks } from "./internal/ResolveNamespace.ts"
import type * as MemoryError from "./MemoryError.ts"
import * as MemoryStore from "./MemoryStore.ts"
import * as Namespace from "./Namespace.ts"
import * as Recall from "./Recall.ts"

/**
 * Escapes a query into a quoted, implicit-AND FTS5 expression.
 *
 * This is the one escaper both public entry points use. `MemoryStore.searchFts`
 * applies it to the raw query it receives, so a caller that has already escaped
 * a query must not pass the escaped form back in.
 *
 * @category constructors
 * @since 0.1.0
 */
export const literalFtsQuery: (query: string) => string = FtsQuery.literalFtsQuery

const run = (input: Recall.Input): Effect.Effect<Recall.Output, MemoryError.MemoryError, MemoryStore.MemoryStore> =>
  Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    const query = literalFtsQuery(input.query)
    const banks = yield* resolveBanks(input.banks)
    if (query.length === 0 || banks.length === 0) return []
    const requested = Recall.requestedRows(input.maxTokens)
    const rows = yield* Effect.all(
      banks.map(({ namespace }) =>
        store.searchFts({
          namespace,
          query: input.query,
          tagGroups: input.tagGroups,
          limit: requested * 5,
          status: "accepted"
        })
      ),
      { concurrency: 4 }
    )
    const results: Array<Recall.Result> = []
    for (let index = 0; index < rows.length; index++) {
      for (const row of rows[index] ?? []) {
        if (row.status !== undefined && row.status !== "accepted") continue
        if (input.tagGroups !== undefined && !input.tagGroups.every((group) => Namespace.matches(group, row.tags))) {
          continue
        }
        results.push({
          bank: banks[index]?.bank ?? "",
          key: row.key,
          text: row.text,
          score: row.score ?? 0,
          updatedAtMs: row.updatedAtMs
        })
      }
    }
    results.sort(Recall.compareResults)
    return Recall.capRecallResults(results.slice(0, requested), input.maxTokens)
  })

/**
 * Runs FTS recall against the supplied MemoryStore.
 *
 * @category constructors
 * @since 0.1.0
 */
export const recall = run

/**
 * Provides FTS recall as a replaceable recall slot.
 *
 * A disabled namespace is not converted to an empty result: the store's
 * typed `fts_not_enabled` error propagates to the caller.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Recall.Recall, never, MemoryStore.MemoryStore> = Recall.layerFrom(run)
