/**
 * Producer identities retained when compaction deletes event payloads.
 *
 * @since 1.0.0-rc.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the durable compacted-identity index.
 *
 * @category migrations
 * @since 1.0.0-rc.0
 */
export const dedup: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE flows_journal_dedup (
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    source_id TEXT NOT NULL CHECK (length(source_id) > 0),
    source_seq ${Dialect.integer(sql)} NOT NULL CHECK (${
    Dialect.isInteger(sql, sql`source_seq`)
  } AND source_seq >= 0 AND source_seq <= 9007199254740991),
    event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) > 0),
    seq ${Dialect.integer(sql)} NOT NULL CHECK (${
    Dialect.isInteger(sql, sql`seq`)
  } AND seq >= 0 AND seq <= 9007199254740991),
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    PRIMARY KEY (run_id, source_id, source_seq)
  )`
  // Enforce the same identity constraints after their event rows are removed.
  // RAISE(IGNORE) leaves INSERT ... RETURNING empty, so the existing duplicate
  // path checks the owner fence and then resolves the original receipt.
  yield* Dialect.trigger(sql, {
    name: "flows_journal_dedup_insert_guard",
    table: "flows_journal_events",
    event: "BEFORE INSERT",
    when: `EXISTS (SELECT 1 FROM flows_journal_dedup WHERE event_id = NEW.event_id
      OR (run_id = NEW.run_id AND source_id = NEW.source_id AND source_seq = NEW.source_seq))`,
    ignore: true
  })
})
