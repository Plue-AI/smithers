/**
 * Registration recovery only needs completions the run has not observed.
 *
 * @since 1.0.0
 */
import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Retains completion values for replay while removing consumed rows from sweeps.
 * Existing completions stay eligible until first read by the upgraded engine.
 *
 * @category migrations
 * @since 1.0.0
 */
export const deferredConsumption: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE flows_deferred_completions ADD COLUMN consumed_at_ms ${Dialect.integer(sql)}
    CHECK (consumed_at_ms IS NULL OR (${
    Dialect.isInteger(sql, sql`consumed_at_ms`)
  } AND consumed_at_ms >= 0 AND consumed_at_ms <= 9007199254740991))`
  yield* sql`CREATE INDEX flows_deferred_completions_unconsumed_idx
    ON flows_deferred_completions (flow_name, execution_id, deferred_name)
    WHERE consumed_at_ms IS NULL`
})
