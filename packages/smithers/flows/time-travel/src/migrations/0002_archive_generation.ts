/**
 * Generation-aware archive upgrade.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as JournalGeneration from "@smthrs/journal/JournalGeneration"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { step } from "../internal/MigrationStep.ts"

/**
 * Rekeys archived records by journal generation.
 *
 * @since 0.1.0
 * @private
 */
export const archiveGeneration = Effect.gen(function*() {
  yield* JournalGeneration.initialize
  const sql = yield* SqlClient.SqlClient
  // Sequences are reused after truncation; the archive key includes the
  // journal generation observed inside the archive transaction.
  const createArchive = sql`CREATE TABLE IF NOT EXISTS flows_time_travel_archive (
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    generation ${Dialect.integer(sql)} NOT NULL CHECK (
      ${Dialect.isInteger(sql, sql`generation`)} AND generation >= 0 AND generation <= 9007199254740991
    ),
    seq ${Dialect.integer(sql)} NOT NULL CHECK (${
    Dialect.isInteger(sql, sql`seq`)
  } AND seq >= 0 AND seq <= 9007199254740991),
    event_id TEXT NOT NULL CHECK (length(event_id) > 0),
    source_id TEXT NOT NULL CHECK (length(source_id) > 0),
    source_seq ${Dialect.integer(sql)} NOT NULL CHECK (
      ${Dialect.isInteger(sql, sql`source_seq`)} AND source_seq >= 0 AND source_seq <= 9007199254740991
    ),
    emitted_at_ms ${Dialect.integer(sql)} NOT NULL CHECK (
      ${Dialect.isInteger(sql, sql`emitted_at_ms`)} AND emitted_at_ms >= 0 AND emitted_at_ms <= 9007199254740991
    ),
    event_type TEXT NOT NULL CHECK (length(event_type) > 0),
    payload_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`payload_json`)}),
    meta_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`meta_json`)}),
    archived_at_ms ${Dialect.integer(sql)} NOT NULL CHECK (
      ${Dialect.isInteger(sql, sql`archived_at_ms`)} AND archived_at_ms >= 0 AND archived_at_ms <= 9007199254740991
    ),
    PRIMARY KEY (run_id, generation, seq)
  )`

  yield* step("flows_time_travel_archive", createArchive)
  yield* step(
    "the flows_time_travel_archive generation rebuild",
    sql.withTransaction(Effect.gen(function*() {
      const columns = yield* Dialect.columns(sql, "flows_time_travel_archive")
      if (columns.some((column) => column.name === "generation")) return
      // Legacy rows have no recoverable generation. Reserve zero for them.
      // Older databases may also predate durable journal generations.
      yield* sql`ALTER TABLE flows_time_travel_archive RENAME TO flows_time_travel_archive_legacy`
      yield* createArchive
      yield* sql`INSERT INTO flows_time_travel_archive
        (run_id, generation, seq, event_id, source_id, source_seq, emitted_at_ms,
         event_type, payload_json, meta_json, archived_at_ms)
        SELECT run_id, 0, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json, archived_at_ms
        FROM flows_time_travel_archive_legacy`
      yield* sql`INSERT INTO flows_journal_generations (run_id, generation, after_seq)
        SELECT DISTINCT legacy.run_id, 1,
          COALESCE((SELECT MAX(seq) FROM flows_journal_events WHERE run_id = legacy.run_id), -1)
        FROM flows_time_travel_archive_legacy AS legacy WHERE true
        ON CONFLICT (run_id) DO NOTHING`
      yield* sql`DROP TABLE flows_time_travel_archive_legacy`
    }))
  )
})
