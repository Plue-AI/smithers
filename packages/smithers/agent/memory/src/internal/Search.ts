/**
 * Raw row search and FTS5 operations of the SQL memory store.
 *
 * @since 0.1.0
 */

import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { DatabaseService } from "../Database.ts"
import type { MemoryError } from "../MemoryError.ts"
import type { Fact, FtsRow, ListFactsInput, ListNotesInput, Note, SearchRow, Service } from "../MemoryStore.ts"
import * as Namespace from "../Namespace.ts"
import { compareText } from "./Canonical.ts"
import { retainedTags, searchableText } from "./FactProjection.ts"
import * as Fts from "./Fts.ts"
import { ftsTerms } from "./FtsQuery.ts"
import { resolveNamespace } from "./ResolveNamespace.ts"
import {
  collectUntil,
  error,
  MIN_NOTE_PAGE_SIZE,
  NOTE_PAGE_SIZE,
  storeError,
  tagMatcher,
  validateLimit,
  validateRecords
} from "./Store.ts"

/**
 * The domain readers search pages through.
 *
 * @category models
 * @since 0.1.0
 */
export interface Readers {
  readonly readFacts: (
    input: ListFactsInput & { readonly keys?: ReadonlyArray<string> | undefined },
    recentFirst: boolean,
    after?: Fact
  ) => Effect.Effect<ReadonlyArray<Fact>, MemoryError>
  readonly readNotes: (
    input: ListNotesInput & { readonly ids?: ReadonlyArray<string> | undefined },
    recentFirst?: boolean
  ) => Effect.Effect<ReadonlyArray<Note>, MemoryError>
}

const factSearchRow = (bank: string, fact: Fact): SearchRow => ({
  id: fact.key,
  kind: "fact",
  bank,
  namespace: fact.namespace,
  key: fact.key,
  text: searchableText(fact.value),
  tags: fact.tags ?? retainedTags(fact.value),
  updatedAtMs: fact.updatedAtMs
})

const noteSearchRow = (bank: string, note: Note): SearchRow => ({
  id: note.id,
  kind: "note",
  bank,
  namespace: note.namespace,
  key: note.id,
  text: note.text,
  tags: note.tags,
  updatedAtMs: note.createdAtMs,
  status: note.status
})

/**
 * Builds the raw row search and FTS5 operations over the fact and note readers.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  database: DatabaseService,
  { readFacts, readNotes }: Readers
): Pick<Service, "searchRows" | "enableFts" | "searchFts"> => {
  const { sql } = database

  // Both sides are read newest-first, so the merge of each side's top `limit`
  // MATCHING rows provably contains the global top `limit`. That only holds
  // when each side really returns `limit` matches, which is why the fact side
  // pages the same way `readNotes` does instead of overscanning a window.
  const searchRows: Service["searchRows"] = (input) =>
    Effect.gen(function*() {
      const limit = yield* validateLimit(input.limit, "searchRows")
      if (limit === 0) return []
      const { bank, namespace } = yield* resolveNamespace(input.namespace)
      yield* validateRecords(input.records, "searchRows")
      const tagFiltered = input.tagGroups !== undefined
      const matchesTags = tagMatcher(input)
      const toFactRow = (fact: Fact): SearchRow => factSearchRow(bank, fact)
      const factQuery = {
        namespace,
        ...(input.records === undefined ? {} : {
          keys: input.records.filter((record) => record.kind === "fact").map((record) => record.id)
        }),
        ...(input.prefix === undefined ? {} : { prefix: input.prefix })
      }
      const readFactRows = Effect.gen(function*() {
        if (limit === undefined || !tagFiltered) {
          const facts = yield* readFacts(
            { ...factQuery, ...(limit === undefined ? {} : { limit }) },
            true
          )
          const rows = facts.map(toFactRow)
          return tagFiltered ? rows.filter((row) => matchesTags(row.tags)) : rows
        }
        const pageSize = Math.min(NOTE_PAGE_SIZE, Math.max(limit, MIN_NOTE_PAGE_SIZE))
        const facts = yield* collectUntil(
          limit,
          pageSize,
          (size, after: Fact | undefined) => readFacts({ ...factQuery, limit: size }, true, after),
          (facts) => Effect.succeed(facts.filter((fact) => matchesTags(toFactRow(fact).tags)))
        )
        return facts.map(toFactRow)
      })
      const [factRows, notes] = yield* Effect.all([
        readFactRows,
        readNotes({
          ...input,
          namespace,
          ...(input.records === undefined ? {} : {
            ids: input.records.filter((record) => record.kind === "note").map((record) => record.id)
          }),
          ...(limit === undefined ? {} : { limit })
        }, true)
      ])
      const rows = [...factRows, ...notes.map((note) => noteSearchRow(bank, note))]
        .sort((left, right) => right.updatedAtMs - left.updatedAtMs || compareText(left.key, right.key))
      return limit === undefined ? rows : rows.slice(0, limit)
    })

  const enableFts: Service["enableFts"] = (kind) =>
    Effect.gen(function*() {
      const decodedKind = yield* Schema.decodeUnknownEffect(Namespace.Kind)(kind).pipe(
        Effect.mapError(() => error("invalid_namespace", "FTS namespace kind is invalid"))
      )
      const now = yield* Clock.currentTimeMillis
      yield* database.write(Fts.enableFts(database, decodedKind, now)).pipe(
        Effect.mapError(storeError(`could not enable FTS for "${decodedKind}"`))
      )
    })

  const searchFts: Service["searchFts"] = (input) =>
    Effect.gen(function*() {
      const limit = (yield* validateLimit(input.limit, "searchFts")) ?? 20
      const { bank, namespace } = yield* resolveNamespace(input.namespace)
      yield* validateRecords(input.records, "searchFts")
      const enabled = yield* Fts.isFtsEnabled(database, namespace.kind).pipe(
        Effect.mapError(storeError("could not inspect FTS enablement"))
      )
      if (!enabled) {
        return yield* Effect.fail(
          error(
            "fts_not_enabled",
            `FTS is not enabled for namespace kind "${namespace.kind}"; call enableFts first`
          )
        )
      }
      const terms = ftsTerms(input.query)
      if (terms.length === 0) {
        return []
      }
      if (limit === 0 || input.records?.length === 0) {
        return []
      }
      // Ranked matches are resolved by id, never through a recency window: a
      // window drops a legitimately matching row simply for being older than
      // the newest N in its namespace. Matches a status, supersession or tag
      // filter rejects are refilled from the next page of ranks, so an FTS
      // query for N rows returns N whenever N passing matches exist.
      const matchesTags = tagMatcher(input)
      const filtered = input.records !== undefined || input.tagGroups !== undefined ||
        input.prefix !== undefined || input.status !== undefined || input.includeSuperseded !== true
      const pageSize = filtered ? NOTE_PAGE_SIZE : Math.min(NOTE_PAGE_SIZE, Math.max(limit, MIN_NOTE_PAGE_SIZE))
      const identities = input.records === undefined ?
        undefined :
        new Set(input.records.map((record) => `${record.kind}\0${record.id}`))
      let offset = 0
      // BM25 ranks depend on the corpus. Keep OFFSET rank pages in one
      // transaction so concurrent writes cannot move matches between pages.
      return yield* sql.withTransaction(collectUntil(
        limit,
        pageSize,
        (size) =>
          Fts.searchFts(database, namespace.kind, namespace.id, terms, size, offset).pipe(
            Effect.tap((matches) =>
              Effect.sync(() => {
                offset += matches.length
              })
            ),
            Effect.mapError(storeError("memory FTS query failed"))
          ),
        (matches) =>
          Effect.gen(function*() {
            const eligible = identities === undefined ?
              matches :
              matches.filter((match) => identities.has(`${match.record_kind}\0${match.record_id}`))
            const factKeys = eligible.filter((match) => match.record_kind === "fact").map((match) => match.record_id)
            const noteIds = eligible.filter((match) => match.record_kind === "note").map((match) => match.record_id)
            const [facts, notes] = yield* Effect.all([
              factKeys.length === 0
                ? Effect.succeed<ReadonlyArray<Fact>>([])
                : readFacts({
                  namespace,
                  keys: factKeys,
                  ...(input.prefix === undefined ? {} : { prefix: input.prefix })
                }, true),
              noteIds.length === 0
                ? Effect.succeed<ReadonlyArray<Note>>([])
                : readNotes({
                  namespace,
                  ids: noteIds,
                  ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
                  ...(input.tagGroups === undefined ? {} : { tagGroups: input.tagGroups }),
                  ...(input.status === undefined ? {} : { status: input.status }),
                  ...(input.includeSuperseded === undefined ? {} : { includeSuperseded: input.includeSuperseded })
                }, true)
            ])
            const byId = new Map<string, SearchRow>()
            for (const fact of facts) {
              const row = factSearchRow(bank, fact)
              if (matchesTags(row.tags)) byId.set(`fact\0${row.id}`, row)
            }
            for (const note of notes) byId.set(`note\0${note.id}`, noteSearchRow(bank, note))
            const ordered: Array<FtsRow> = []
            for (const match of eligible) {
              const row = byId.get(`${match.record_kind}\0${match.record_id}`)
              if (row !== undefined) {
                const rank = Number(match.rank)
                ordered.push({ ...row, rank, score: -rank })
              }
            }
            return ordered
          })
      )).pipe(Effect.mapError(storeError("memory FTS query failed")))
    })

  return { searchRows, enableFts, searchFts }
}
