/**
 * Trampoline lineage columns on `flows_runs`.
 *
 * A round is its own run row, chained to the previous round through the `parent_run_id`
 * column this table already reserved for continue-as-new, and these two
 * columns are what make the chain readable as a lineage rather than as an
 * anonymous ancestry: which lineage a round belongs to, and which round of it
 * this is. They are NOT `flows_run_parents` edges — that table is the subflow
 * DAG cycle detection walks, and a lineage is a chain of successive
 * executions of one run rather than a parent spawning a child.
 *
 * Append-only, as every migration after the first must be: both columns are
 * nullable, so every row an earlier build wrote stays valid and reads back as
 * "round 0 of its own lineage".
 *
 * @since 0.1.0
 */
import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Adds `lineage_id` and `round_ordinal` to `flows_runs` and indexes the pair.
 *
 * @category migrations
 * @since 0.1.0
 */
export const lineage: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE flows_runs ADD COLUMN lineage_id TEXT CHECK (lineage_id IS NULL OR length(lineage_id) > 0)`
  yield* sql`ALTER TABLE flows_runs ADD COLUMN round_ordinal ${Dialect.integer(sql)} CHECK (round_ordinal IS NULL OR (${
    Dialect.isInteger(sql, sql`round_ordinal`)
  } AND round_ordinal >= 0 AND round_ordinal <= 9007199254740991))`

  yield* sql`CREATE UNIQUE INDEX flows_runs_lineage_idx ON flows_runs (lineage_id, round_ordinal)`
})
