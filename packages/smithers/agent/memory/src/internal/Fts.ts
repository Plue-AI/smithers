/**
 * Lazy SQLite full-text search operations.
 *
 * @see https://memory.smithers.sh/reference/api/
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as SqlError from "effect/unstable/sql/SqlError"
import type { Fragment, Statement } from "effect/unstable/sql/Statement"
import type { DatabaseService } from "../Database.ts"
import type { Kind } from "../Namespace.ts"
import { literalFtsQuery } from "./FtsQuery.ts"

/**
 * A record projected into a namespace-kind FTS table.
 *
 * @category models
 * @since 0.1.0
 */
export interface FtsRecord {
  readonly recordId: string
  readonly recordKind: "fact" | "note"
  readonly namespaceId: string
  readonly key: string
  readonly text: string
}

/**
 * Raw rank row returned by SQLite FTS5.
 *
 * @category models
 * @since 0.1.0
 */
export interface FtsMatch {
  readonly record_id: string
  readonly record_kind: "fact" | "note"
  readonly rank: number
}

const ftsTable = (kind: Kind): string => `memory_fts_${kind}`

// FTS5's unicode61 tokenizer splits on every non-letter, non-digit character
// and folds diacritics, so "cafe" and "café" are one token. PostgreSQL's
// `simple` parser under the C locale instead reads every non-ASCII character
// as a letter, so U+FFFD or an em dash would glue words together, and it keeps
// accents. Both the indexed text and each query term are therefore decomposed
// (NFD), stripped of combining diacritical marks, recomposed (NFC), and
// reduced to Unicode alphanumeric runs, with the database-independent built-in
// `pg_c_utf8` collation classifying the characters. Every step is immutable
// core SQL, so the generated column needs no extension such as `unaccent`.
const postgresWords = (sql: SqlClient.SqlClient, text: Fragment): Fragment =>
  sql`regexp_replace(
    normalize(regexp_replace(normalize((${text}) COLLATE "pg_c_utf8", NFD), '[\\u0300-\\u036f]+', '', 'g'), NFC),
    '[^[:alnum:]]+', ' ', 'g')`

/**
 * The PostgreSQL generated search column of a namespace-kind FTS table.
 *
 * @category migrations
 * @since 1.0.0
 */
export const postgresSearchColumn = (sql: SqlClient.SqlClient): Fragment =>
  sql`search TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple', ${postgresWords(sql, sql`record_key || ' ' || text`)})
  ) STORED`

/**
 * The PostgreSQL search index of a namespace-kind FTS table.
 *
 * @category migrations
 * @since 1.0.0
 */
export const postgresSearchIndex = (sql: SqlClient.SqlClient, kind: Kind): Statement<unknown> =>
  sql`CREATE INDEX IF NOT EXISTS ${sql(`${ftsTable(kind)}_search`)} ON ${
    sql.literal(ftsTable(kind))
  } USING GIN (search)`

/**
 * Returns whether a namespace kind has opted into FTS5.
 *
 * @category queries
 * @since 0.1.0
 */
export const isFtsEnabled = (
  database: DatabaseService,
  kind: Kind
): Effect.Effect<boolean, SqlError.SqlError> =>
  database.sql<{ readonly enabled: number }>`
    SELECT 1 AS enabled FROM memory_fts_kinds WHERE namespace_kind = ${kind}
  `.pipe(Effect.map((rows) => rows.length > 0))

/**
 * Creates and fully backfills one namespace-kind FTS5 table.
 *
 * A kind that `memory_fts_kinds` already holds is left alone: its projection
 * has been maintained row by row since it was enabled, so a second call at
 * setup time does not rebuild it under the writer. The fact backfill is one
 * `INSERT ... SELECT` that derives the searchable text in SQL the same way
 * `searchableText` does: a string value is the string, an object with a
 * string `content` is that content, anything else is its JSON text.
 *
 * This Effect must be run inside `Database.write`.
 *
 * @category migrations
 * @since 0.1.0
 */
export const enableFts = (
  database: DatabaseService,
  kind: Kind,
  enabledAtMs: number
): Effect.Effect<void, SqlError.SqlError> => {
  const { sql } = database
  const table = sql.literal(ftsTable(kind))
  return Effect.gen(function*() {
    if (yield* isFtsEnabled(database, kind)) {
      return
    }
    if (Dialect.isPostgres(sql)) {
      yield* sql`CREATE TABLE IF NOT EXISTS ${table} (
        record_id TEXT NOT NULL, record_kind TEXT NOT NULL, namespace_id TEXT NOT NULL,
        record_key TEXT NOT NULL, text TEXT NOT NULL,
        ${postgresSearchColumn(sql)}
      )`
      yield* postgresSearchIndex(sql, kind)
    } else {
      yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS ${table}
        USING fts5(record_id UNINDEXED, record_kind UNINDEXED, namespace_id UNINDEXED, record_key, text)`
    }
    yield* sql`INSERT INTO memory_fts_kinds (namespace_kind, enabled_at_ms)
      VALUES (${kind}, ${enabledAtMs})`
    yield* sql`DELETE FROM ${table}`
    yield* sql`INSERT INTO ${table} (record_id, record_kind, namespace_id, record_key, text)
      SELECT fact_key, 'fact', namespace_id, fact_key,
        ${
      Dialect.isPostgres(sql) ?
        sql`CASE
          WHEN jsonb_typeof(value_json::jsonb) = 'string' THEN value_json::jsonb #>> '{}'
          WHEN jsonb_typeof(value_json::jsonb -> 'content') = 'string' THEN value_json::jsonb ->> 'content'
          ELSE value_json END` :
        sql`CASE
          WHEN json_type(value_json) = 'text' THEN json_extract(value_json, '$')
          WHEN json_type(value_json) = 'object' AND json_type(value_json, '$.content') = 'text'
            THEN json_extract(value_json, '$.content')
          ELSE value_json END`
    }
      FROM memory_facts WHERE namespace_kind = ${kind}`
    yield* sql`INSERT INTO ${table} (record_id, record_kind, namespace_id, record_key, text)
      SELECT id, 'note', namespace_id, id, text
      FROM memory_notes WHERE namespace_kind = ${kind}`
  })
}

/**
 * Deletes the FTS projections of many facts of one namespace and kind when the
 * kind is enabled, with one statement instead of one per fact.
 *
 * @category projections
 * @since 1.0.0
 */
export const deleteFtsFacts = (
  database: DatabaseService,
  kind: Kind,
  namespaceId: string,
  factKeys: ReadonlyArray<string>
): Effect.Effect<void, SqlError.SqlError> =>
  Effect.gen(function*() {
    if (factKeys.length === 0 || !(yield* isFtsEnabled(database, kind))) return
    const { sql } = database
    const table = sql.literal(ftsTable(kind))
    yield* sql`DELETE FROM ${table}
      WHERE record_kind = 'fact'
        AND namespace_id = ${namespaceId}
        AND ${sql.in("record_id", factKeys)}`
  })

/**
 * Replaces one authoritative record's FTS projection when its kind is enabled.
 *
 * This Effect must be run inside the authoritative record's
 * `Database.write` transaction.
 *
 * @category projections
 * @since 0.1.0
 */
export const replaceFtsRecord = (
  database: DatabaseService,
  kind: Kind,
  record: FtsRecord
): Effect.Effect<void, SqlError.SqlError> =>
  Effect.gen(function*() {
    if (!(yield* isFtsEnabled(database, kind))) {
      return
    }
    const { sql } = database
    const table = sql.literal(ftsTable(kind))
    yield* sql`DELETE FROM ${table}
      WHERE record_id = ${record.recordId}
        AND record_kind = ${record.recordKind}
        AND namespace_id = ${record.namespaceId}`
    yield* sql`INSERT INTO ${table} (record_id, record_kind, namespace_id, record_key, text)
      VALUES (${record.recordId}, ${record.recordKind}, ${record.namespaceId}, ${record.key}, ${record.text})`
  })

/**
 * Deletes one authoritative record's FTS projection when its kind is enabled.
 *
 * @category projections
 * @since 0.1.0
 */
export const deleteFtsRecord = (
  database: DatabaseService,
  kind: Kind,
  record: Pick<FtsRecord, "recordId" | "recordKind" | "namespaceId">
): Effect.Effect<void, SqlError.SqlError> =>
  Effect.gen(function*() {
    if (!(yield* isFtsEnabled(database, kind))) return
    const table = database.sql.literal(ftsTable(kind))
    yield* database.sql`DELETE FROM ${table}
      WHERE record_id = ${record.recordId}
        AND record_kind = ${record.recordKind}
        AND namespace_id = ${record.namespaceId}`
  })

/**
 * Searches one namespace-kind FTS5 table in raw BM25 rank order.
 *
 * `offset` lets a caller walk the ranked matches in pages. A match can be
 * dropped by a status, supersession, or tag filter the FTS table knows nothing
 * about, so returning the caller's page size in one shot would under-fill the
 * answer; paging is what lets the store keep asking until it has enough.
 *
 * @category queries
 * @since 0.1.0
 */
export const searchFts = (
  database: DatabaseService,
  kind: Kind,
  namespaceId: string,
  terms: ReadonlyArray<string>,
  limit: number,
  offset = 0
): Effect.Effect<ReadonlyArray<FtsMatch>, SqlError.SqlError> => {
  const { sql } = database
  const tableName = ftsTable(kind)
  const table = sql.literal(tableName)
  if (Dialect.isPostgres(sql)) {
    // Each term is a phrase of its words, and the terms are ANDed, as FTS5
    // reads the quoted terms of `literalFtsQuery`.
    const query = terms
      .map((term) => sql`phraseto_tsquery('simple', ${postgresWords(sql, sql`${term}`)})`)
      .reduce((all, term) => sql`${all} && ${term}`)
    return sql<FtsMatch>`SELECT record_id, record_kind, -ts_rank(search, ${query}) AS rank
      FROM ${table} WHERE search @@ (${query}) AND namespace_id = ${namespaceId}
      ORDER BY rank, record_id LIMIT ${limit} OFFSET ${offset}`
  }
  const bm25 = sql.literal(`bm25(${tableName})`)
  return sql<FtsMatch>`SELECT record_id, record_kind, ${bm25} AS rank
    FROM ${table}
    WHERE ${table} MATCH ${literalFtsQuery(terms.join(" "))} AND namespace_id = ${namespaceId}
    ORDER BY rank
    LIMIT ${limit} OFFSET ${offset}`
}
