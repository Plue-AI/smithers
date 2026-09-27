/**
 * The authoritative memory schema, including idempotent pre-release upgrades.
 *
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const compositeMessagePrimaryKey = /PRIMARY\s+KEY\s*\(\s*thread_id\s*,\s*id\s*\)/iu

/**
 * Creates the memory schema. The shared migrator runs this Effect and records
 * its identity in the same transaction.
 *
 * @category migrations
 * @since 1.0.0
 */
export const initial = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS memory_facts (
    namespace_kind TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    fact_key TEXT NOT NULL,
    value_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`value_json`)}),
    tags_json TEXT CHECK (tags_json IS NULL OR ${Dialect.jsonValid(sql, sql`tags_json`)}),
    ttl_ms ${Dialect.integer(sql)},
    provenance_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`provenance_json`)}),
    created_at_ms ${Dialect.integer(sql)} NOT NULL,
    updated_at_ms ${Dialect.integer(sql)} NOT NULL,
    PRIMARY KEY (namespace_kind, namespace_id, fact_key),
    CHECK (namespace_kind IN ('flow', 'agent', 'user', 'global')),
    CHECK (length(namespace_id) > 0),
    CHECK (length(fact_key) > 0),
    CHECK (ttl_ms IS NULL OR ttl_ms >= 0)
  )`
  const factColumns = yield* Dialect.columns(sql, "memory_facts")
  if (!factColumns.some((column) => column.name === "tags_json")) {
    yield* sql`ALTER TABLE memory_facts
      ADD COLUMN tags_json TEXT CHECK (tags_json IS NULL OR ${Dialect.jsonValid(sql, sql`tags_json`)})`
  }
  // The expiry sweep filters on the computed sum, so the index is over that
  // expression; a plain (updated_at_ms, ttl_ms) index could never serve it.
  yield* sql`CREATE INDEX IF NOT EXISTS memory_facts_expires_at_idx
    ON memory_facts ((updated_at_ms + ttl_ms)) WHERE ttl_ms IS NOT NULL`
  yield* sql`CREATE TABLE IF NOT EXISTS memory_threads (
    thread_id TEXT PRIMARY KEY CHECK (length(thread_id) > 0),
    namespace_kind TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    title TEXT,
    metadata_json TEXT CHECK (metadata_json IS NULL OR ${Dialect.jsonValid(sql, sql`metadata_json`)}),
    created_at_ms ${Dialect.integer(sql)} NOT NULL,
    updated_at_ms ${Dialect.integer(sql)} NOT NULL,
    CHECK (namespace_kind IN ('flow', 'agent', 'user', 'global')),
    CHECK (length(namespace_id) > 0)
  )`
  yield* sql`CREATE TABLE IF NOT EXISTS memory_messages (
    id TEXT NOT NULL CHECK (length(id) > 0),
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    at_ms ${Dialect.integer(sql)} NOT NULL,
    PRIMARY KEY (thread_id, id),
    FOREIGN KEY (thread_id) REFERENCES memory_threads (thread_id)
  )`
  const messageTables = Dialect.isPostgres(sql) ?
    [] :
    yield* sql<{ readonly sql: string | null }>`SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'memory_messages'`
  const messageDefinition = messageTables[0]?.sql
  if (messageDefinition !== undefined && !compositeMessagePrimaryKey.test(messageDefinition ?? "")) {
    yield* sql`CREATE TABLE memory_messages_v2 (
      id TEXT NOT NULL CHECK (length(id) > 0),
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      at_ms ${Dialect.integer(sql)} NOT NULL,
      PRIMARY KEY (thread_id, id),
      FOREIGN KEY (thread_id) REFERENCES memory_threads (thread_id)
    )`
    yield* sql`INSERT INTO memory_messages_v2 (id, thread_id, role, text, at_ms)
      SELECT id, thread_id, role, text, at_ms FROM memory_messages`
    yield* sql`DROP TABLE memory_messages`
    yield* sql`ALTER TABLE memory_messages_v2 RENAME TO memory_messages`
  }
  yield* sql`CREATE INDEX IF NOT EXISTS memory_messages_thread_order_idx
    ON memory_messages (thread_id, at_ms, id)`
  yield* sql`CREATE TABLE IF NOT EXISTS memory_notes (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    namespace_kind TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    text TEXT NOT NULL,
    tags_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`tags_json`)}),
    provenance_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`provenance_json`)}),
    status TEXT NOT NULL DEFAULT 'accepted',
    created_at_ms ${Dialect.integer(sql)} NOT NULL,
    CHECK (namespace_kind IN ('flow', 'agent', 'user', 'global')),
    CHECK (length(namespace_id) > 0),
    CHECK (status IN ('pending', 'accepted', 'rejected'))
  )`
  yield* sql`CREATE INDEX IF NOT EXISTS memory_notes_namespace_order_idx
    ON memory_notes (namespace_kind, namespace_id, created_at_ms, id)`
  yield* sql`CREATE TABLE IF NOT EXISTS memory_note_supersedes (
    superseder_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    created_at_ms ${Dialect.integer(sql)} NOT NULL,
    PRIMARY KEY (superseder_id, target_id),
    FOREIGN KEY (superseder_id) REFERENCES memory_notes (id),
    FOREIGN KEY (target_id) REFERENCES memory_notes (id),
    CHECK (superseder_id <> target_id)
  )`
  // Default note reads ask "is this note superseded?", a lookup by target_id
  // that the primary key (superseder_id, target_id) cannot answer without a
  // scan of every edge per candidate row.
  yield* sql`CREATE INDEX IF NOT EXISTS memory_note_supersedes_target_idx
    ON memory_note_supersedes (target_id, superseder_id)`
  yield* sql`CREATE TABLE IF NOT EXISTS memory_fts_kinds (
    namespace_kind TEXT PRIMARY KEY,
    enabled_at_ms ${Dialect.integer(sql)} NOT NULL,
    CHECK (namespace_kind IN ('flow', 'agent', 'user', 'global'))
  )`
  yield* sql`CREATE TABLE IF NOT EXISTS memory_vectors (
    ${Dialect.rowId(sql)}
    record_kind TEXT NOT NULL,
    record_id TEXT NOT NULL,
    namespace_kind TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    dimensions ${Dialect.integer(sql)} NOT NULL,
    vector_bytes ${sql.literal(Dialect.isPostgres(sql) ? "BYTEA" : "BLOB")} NOT NULL,
    updated_at_ms ${Dialect.integer(sql)} NOT NULL,
    PRIMARY KEY (
      namespace_kind, namespace_id, record_kind, record_id, embedding_model
    ),
    CHECK (record_kind IN ('fact', 'note')),
    CHECK (namespace_kind IN ('flow', 'agent', 'user', 'global')),
    CHECK (length(record_id) > 0),
    CHECK (length(namespace_id) > 0),
    CHECK (length(embedding_model) > 0),
    CHECK (length(content_digest) > 0),
    CHECK (dimensions > 0)
  )`
  yield* sql`CREATE INDEX IF NOT EXISTS memory_vectors_namespace_idx
    ON memory_vectors (namespace_kind, namespace_id, embedding_model, updated_at_ms)`
})
