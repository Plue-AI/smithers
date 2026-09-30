/**
 * The source record store's schema installation.
 *
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the `smithers_integration_records`, `smithers_integration_streams`
 * and `smithers_integration_revocations` tables.
 *
 * Records are keyed by connection and external id. A stream row carries the
 * mark-and-sweep generation of one synchronized stream, and a revocation row
 * withdraws a whole connection (container `*`) or one container of it.
 *
 * Like the cursor migration, this stays out of `package.json` `exports` and
 * `core.ts`: consumers reach it through `Core.Migrations.set`. Exported by
 * name, never as a default, for the CommonJS build reason documented beside
 * `integrationCursors`.
 *
 * @category migrations
 * @since 1.0.0
 */
export const integrationRecords: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS smithers_integration_records (
    connection_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    url TEXT,
    author_id TEXT,
    author_label TEXT,
    created_at_ms DOUBLE PRECISION,
    updated_at_ms DOUBLE PRECISION,
    version TEXT,
    retrieved_at_ms DOUBLE PRECISION NOT NULL,
    access_scope TEXT NOT NULL CHECK (access_scope IN ('private', 'container', 'workspace', 'public')),
    access_container_id TEXT,
    thread_container_id TEXT,
    thread_id TEXT,
    parent_id TEXT,
    text TEXT NOT NULL,
    deleted ${Dialect.integer(sql)} NOT NULL CHECK (deleted IN (0, 1)),
    payload_json TEXT NOT NULL,
    revoked ${Dialect.integer(sql)} NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
    stream TEXT,
    seen_generation ${Dialect.integer(sql)} NOT NULL DEFAULT 0,
    PRIMARY KEY (connection_id, external_id)
  )`
  yield* sql`CREATE INDEX IF NOT EXISTS smithers_integration_records_stream
    ON smithers_integration_records (connection_id, stream, seen_generation)`
  yield* sql`CREATE INDEX IF NOT EXISTS smithers_integration_records_access_container
    ON smithers_integration_records (connection_id, access_container_id)`
  yield* sql`CREATE INDEX IF NOT EXISTS smithers_integration_records_thread_container
    ON smithers_integration_records (connection_id, thread_container_id)`
  yield* sql`CREATE TABLE IF NOT EXISTS smithers_integration_streams (
    connection_id TEXT NOT NULL,
    stream TEXT NOT NULL,
    generation ${Dialect.integer(sql)} NOT NULL,
    sweeping ${Dialect.integer(sql)} NOT NULL CHECK (sweeping IN (0, 1)),
    updated_at_ms ${Dialect.integer(sql)} NOT NULL,
    PRIMARY KEY (connection_id, stream)
  )`
  yield* sql`CREATE TABLE IF NOT EXISTS smithers_integration_revocations (
    connection_id TEXT NOT NULL,
    container_id TEXT NOT NULL,
    revoked_at_ms ${Dialect.integer(sql)} NOT NULL,
    PRIMARY KEY (connection_id, container_id)
  )`
})

/**
 * Adds `swept` to `smithers_integration_records`: whether a record's deletion
 * was inferred by a completed full listing that omitted it, rather than
 * reported by the provider. Only a provider deletion outranks a live copy with
 * the same change time and version; an inferred one yields to the next listing
 * that contains the record again.
 *
 * @category migrations
 * @since 1.0.0
 */
export const integrationRecordsSwept: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE smithers_integration_records
    ADD COLUMN swept ${Dialect.integer(sql)} NOT NULL DEFAULT 0 CHECK (swept IN (0, 1))`
})
