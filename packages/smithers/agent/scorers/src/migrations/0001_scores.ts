/**
 * Initial durable score-observation schema.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the durable score-observation table.
 *
 * @category migrations
 * @since 0.1.0
 */
export const migration: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE flows_scores (
    id ${Dialect.identity(sql)},
    kind TEXT NOT NULL CHECK (kind IN ('score', 'inconclusive')),
    target_step_key TEXT NOT NULL,
    scorer_key TEXT NOT NULL,
    value DOUBLE PRECISION,
    reason TEXT,
    metadata_json TEXT CHECK (metadata_json IS NULL OR ${Dialect.jsonValid(sql, sql`metadata_json`)}),
    at_ms ${Dialect.integer(sql)} NOT NULL,
    CHECK (
      (kind = 'score' AND value IS NOT NULL AND value >= 0 AND value <= 1) OR
      (kind = 'inconclusive' AND value IS NULL)
    )
  )`
  yield* sql`CREATE INDEX flows_scores_lookup_idx
    ON flows_scores (target_step_key, scorer_key, at_ms)`
})
