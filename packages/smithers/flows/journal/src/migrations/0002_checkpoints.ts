/**
 * Durable journal checkpoints and the compaction floor.
 *
 * One row per `(run_id, seq)`: the caller-captured state that replays the run
 * from `seq` without the entries before it. `compacted_at_ms` is NULL until a
 * compaction has truncated the entries strictly below `seq`; the largest
 * compacted `seq` per run is the run's compaction floor, and reads whose
 * cursor starts below it fail with `compacted` instead of returning a
 * silently shortened history.
 *
 * Prior art: Temporal's mutable state is exactly this shape, a durable
 * snapshot pinned to a history offset (`last_first_event_id` in
 * `reference/temporal/proto/internal/temporal/server/api/persistence/v1/executions.proto`),
 * with history below it never replayed.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the `flows_journal_checkpoints` table.
 *
 * @category migrations
 * @since 0.1.0
 */
export const checkpoints: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE flows_journal_checkpoints (
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    seq ${Dialect.integer(sql)} NOT NULL CHECK (${
    Dialect.isInteger(sql, sql`seq`)
  } AND seq >= 0 AND seq <= 9007199254740991),
    state_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`state_json`)}),
    created_at_ms ${Dialect.integer(sql)} NOT NULL CHECK (${
    Dialect.isInteger(sql, sql`created_at_ms`)
  } AND created_at_ms >= 0 AND created_at_ms <= 9007199254740991),
    compacted_at_ms ${Dialect.integer(sql)} CHECK (compacted_at_ms IS NULL OR (${
    Dialect.isInteger(sql, sql`compacted_at_ms`)
  } AND compacted_at_ms >= 0 AND compacted_at_ms <= 9007199254740991)),
    PRIMARY KEY (run_id, seq)
  )`
})
