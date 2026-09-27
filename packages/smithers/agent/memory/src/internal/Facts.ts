/**
 * Fact operations of the SQL memory store.
 *
 * @since 0.1.0
 */

import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import type { DatabaseService } from "../Database.ts"
import type { MemoryError } from "../MemoryError.ts"
import type { Fact, ListFactsInput, Service } from "../MemoryStore.ts"
import type * as Namespace from "../Namespace.ts"
import { canonicalJson } from "./Canonical.ts"
import { searchableText } from "./FactProjection.ts"
import * as Fts from "./Fts.ts"
import { resolveNamespace } from "./ResolveNamespace.ts"
import {
  changed,
  decodeFact,
  decodeJson,
  encodeJson,
  type FactRow,
  type Fragment,
  storeError,
  validateLimit,
  validateNonEmpty,
  validateTags,
  validateTime
} from "./Store.ts"

const FACT_COLUMNS = "namespace_kind, namespace_id, fact_key, value_json, tags_json, ttl_ms, " +
  "provenance_json, created_at_ms, updated_at_ms"

const DELETE_EXPIRED_FACTS_CHUNK_SIZE = 256

const isExpired = (fact: Fact, now: number): boolean => fact.ttlMs !== undefined && fact.updatedAtMs + fact.ttlMs <= now

type ReadFacts = (
  input: ListFactsInput & { readonly keys?: ReadonlyArray<string> | undefined },
  recentFirst: boolean,
  after?: Fact
) => Effect.Effect<ReadonlyArray<Fact>, MemoryError>

/**
 * Builds the fact operations, plus the filtered reader search pages through.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (database: DatabaseService): {
  readonly readFacts: ReadFacts
  readonly service: Pick<
    Service,
    "putFact" | "getFact" | "deleteFact" | "listFacts" | "listAllFacts" | "deleteExpiredFacts"
  >
} => {
  const { sql } = database
  const columns = sql.literal(FACT_COLUMNS)

  const readFacts: ReadFacts = (input, recentFirst, after) =>
    Effect.gen(function*() {
      const { namespace } = yield* resolveNamespace(input.namespace)
      const limit = yield* validateLimit(input.limit, "listFacts")
      if (limit === 0) return []
      const now = yield* Clock.currentTimeMillis
      const order = sql.literal(recentFirst ? "updated_at_ms DESC, fact_key" : "fact_key")
      const conditions: Array<Fragment> = [
        sql`namespace_kind = ${namespace.kind}`,
        sql`namespace_id = ${namespace.id}`,
        sql`(ttl_ms IS NULL OR updated_at_ms + ttl_ms > ${now})`
      ]
      if (input.prefix !== undefined) {
        conditions.push(sql`substr(fact_key, 1, length(${input.prefix})) = ${input.prefix}`)
      }
      if (input.keys !== undefined) {
        conditions.push(input.keys.length === 0 ? sql.literal("1 = 0") : sql.in("fact_key", input.keys))
      }
      if (after !== undefined) {
        // Recency descends, but keys ascend within a timestamp tie.
        conditions.push(sql`(updated_at_ms < ${after.updatedAtMs}
          OR (updated_at_ms = ${after.updatedAtMs} AND fact_key > ${after.key}))`)
      }
      const where = sql.and(conditions)
      const rows = yield* (limit === undefined
        ? sql<FactRow>`SELECT ${columns} FROM memory_facts WHERE ${where} ORDER BY ${order}`
        : sql<FactRow>`SELECT ${columns} FROM memory_facts WHERE ${where} ORDER BY ${order} LIMIT ${limit}`).pipe(
          Effect.mapError(storeError("could not list memory facts"))
        )
      return yield* Effect.forEach(rows, decodeFact)
    })

  const listFacts: Service["listFacts"] = (input) => readFacts(input, false)

  const getFact: Service["getFact"] = (input) =>
    Effect.gen(function*() {
      const { namespace } = yield* resolveNamespace(input.namespace)
      yield* validateNonEmpty(input.key, "fact key", ["key"])
      const rows = yield* sql<FactRow>`SELECT ${columns}
        FROM memory_facts
        WHERE namespace_kind = ${namespace.kind}
          AND namespace_id = ${namespace.id}
          AND fact_key = ${input.key}
        LIMIT 1`.pipe(Effect.mapError(storeError("could not read memory fact")))
      if (rows.length === 0) {
        return undefined
      }
      const fact = yield* decodeFact(rows[0]!)
      const now = yield* Clock.currentTimeMillis
      return isExpired(fact, now) ? undefined : fact
    })

  const listAllFacts: Service["listAllFacts"] = Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    const rows = yield* sql<FactRow>`SELECT ${columns}
      FROM memory_facts
      WHERE ttl_ms IS NULL OR updated_at_ms + ttl_ms > ${now}
      ORDER BY namespace_kind, namespace_id, fact_key`.pipe(
      Effect.mapError(storeError("could not list all memory facts"))
    )
    return yield* Effect.forEach(rows, decodeFact)
  })

  const putFact: Service["putFact"] = (input) =>
    Effect.gen(function*() {
      const { namespace } = yield* resolveNamespace(input.namespace)
      yield* validateNonEmpty(input.key, "fact key", ["key"])
      if (input.ttlMs !== undefined) {
        yield* validateTime(input.ttlMs, "ttlMs", ["ttlMs"])
      }
      const valueJson = yield* encodeJson(input.value, "fact value", ["value"])
      const value = yield* decodeJson(valueJson, "fact value")
      const tags = input.tags === undefined ? undefined : yield* validateTags(input.tags)
      const tagsJson = tags === undefined ? null : canonicalJson(tags)
      const provenanceJson = yield* encodeJson(input.provenance, "fact provenance", ["provenance"])
      const now = yield* Clock.currentTimeMillis
      yield* database.write(
        Effect.gen(function*() {
          yield* sql`INSERT INTO memory_facts (${columns}) VALUES (
            ${namespace.kind}, ${namespace.id}, ${input.key}, ${valueJson}, ${tagsJson}, ${input.ttlMs ?? null},
            ${provenanceJson}, ${now}, ${now}
          ) ON CONFLICT (namespace_kind, namespace_id, fact_key) DO UPDATE SET
            value_json = excluded.value_json,
            tags_json = excluded.tags_json,
            ttl_ms = excluded.ttl_ms,
            provenance_json = excluded.provenance_json,
            updated_at_ms = excluded.updated_at_ms`
          yield* Fts.replaceFtsRecord(database, namespace.kind, {
            recordId: input.key,
            recordKind: "fact",
            namespaceId: namespace.id,
            key: input.key,
            text: searchableText(value)
          })
        })
      ).pipe(Effect.mapError(storeError("could not write memory fact")))
    })

  const deleteFact: Service["deleteFact"] = (input) =>
    Effect.gen(function*() {
      const { namespace } = yield* resolveNamespace(input.namespace)
      yield* validateNonEmpty(input.key, "fact key", ["key"])
      return yield* database.write(
        Effect.gen(function*() {
          const result = yield* sql`DELETE FROM memory_facts
            WHERE namespace_kind = ${namespace.kind}
              AND namespace_id = ${namespace.id}
              AND fact_key = ${input.key}`.raw
          yield* Fts.deleteFtsRecord(database, namespace.kind, {
            recordId: input.key,
            recordKind: "fact",
            namespaceId: namespace.id
          })
          yield* sql`DELETE FROM memory_vectors
            WHERE namespace_kind = ${namespace.kind}
              AND namespace_id = ${namespace.id}
              AND record_kind = 'fact'
              AND record_id = ${input.key}`
          return changed(result) > 0
        })
      ).pipe(Effect.mapError(storeError("could not delete memory fact")))
    })

  const deleteExpiredFacts: Service["deleteExpiredFacts"] = Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      database.write(
        Effect.gen(function*() {
          let deleted = 0
          let hasMore = true
          while (hasMore) {
            // No ORDER BY: the expression index hands back expired rows in
            // expiry order, and a chunk is deleted before the next is read.
            const expiring = yield* sql<{
              readonly namespace_kind: Namespace.Kind
              readonly namespace_id: string
              readonly fact_key: string
            }>`SELECT namespace_kind, namespace_id, fact_key
              FROM memory_facts
              WHERE ttl_ms IS NOT NULL AND updated_at_ms + ttl_ms <= ${now}
              LIMIT ${DELETE_EXPIRED_FACTS_CHUNK_SIZE}`
            if (expiring.length === 0) {
              break
            }
            // One statement per table per namespace, not four per fact.
            const byNamespace = new Map<string, { kind: Namespace.Kind; id: string; keys: Array<string> }>()
            for (const fact of expiring) {
              const namespaceKey = `${fact.namespace_kind}\u0000${fact.namespace_id}`
              const group = byNamespace.get(namespaceKey)
              if (group === undefined) {
                byNamespace.set(namespaceKey, {
                  kind: fact.namespace_kind,
                  id: fact.namespace_id,
                  keys: [fact.fact_key]
                })
              } else {
                group.keys.push(fact.fact_key)
              }
            }
            for (const group of byNamespace.values()) {
              yield* Fts.deleteFtsFacts(database, group.kind, group.id, group.keys)
              yield* sql`DELETE FROM memory_vectors
                WHERE namespace_kind = ${group.kind}
                  AND namespace_id = ${group.id}
                  AND record_kind = 'fact'
                  AND ${sql.in("record_id", group.keys)}`
              const result = yield* sql`DELETE FROM memory_facts
                WHERE namespace_kind = ${group.kind}
                  AND namespace_id = ${group.id}
                  AND ${sql.in("fact_key", group.keys)}
                  AND ttl_ms IS NOT NULL
                  AND updated_at_ms + ttl_ms <= ${now}`.raw
              deleted += changed(result)
            }
            hasMore = expiring.length === DELETE_EXPIRED_FACTS_CHUNK_SIZE
          }
          return deleted
        })
      )
    ),
    Effect.mapError(storeError("could not delete expired memory facts"))
  )

  return {
    readFacts,
    service: { putFact, getFact, deleteFact, listFacts, listAllFacts, deleteExpiredFacts }
  }
}
