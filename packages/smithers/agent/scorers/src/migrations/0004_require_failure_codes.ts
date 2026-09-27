/**
 * Required failure classifications for every inconclusive observation.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Backfills pre-classification rows and makes the classification mandatory.
 *
 * Migration 0003 introduced `failure_code` as nullable so existing rows could
 * cross the first rebuild. Keeping that shape let new writers omit the code
 * and made a structured failure indistinguishable from legacy data. This
 * second rebuild maps every legacy inconclusive row to the conservative
 * `inconclusive` class and rejects future omissions at the table boundary.
 *
 * @category migrations
 * @since 0.1.0
 */
export const migration: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE flows_scores_classified (
    id ${Dialect.identity(sql)},
    kind TEXT NOT NULL CHECK (kind IN ('score', 'inconclusive')),
    target_step_key TEXT NOT NULL,
    scorer_key TEXT NOT NULL,
    value DOUBLE PRECISION,
    reason TEXT,
    failure_code TEXT CHECK (
      failure_code IS NULL OR failure_code IN (
        'invalid_declaration', 'invalid_score', 'invalid_sampling', 'invalid_observation',
        'invalid_request', 'inconclusive', 'constraint', 'store'
      )
    ),
    metadata_json TEXT CHECK (metadata_json IS NULL OR ${Dialect.jsonValid(sql, sql`metadata_json`)}),
    at_ms ${Dialect.integer(sql)} NOT NULL CHECK (at_ms >= 0 AND ${Dialect.isInteger(sql, sql`at_ms`)}),
    CHECK (
      length(target_step_key) > 0 AND length(scorer_key) > 0 AND (
        (kind = 'score' AND value IS NOT NULL AND value >= 0 AND value <= 1 AND failure_code IS NULL) OR
        (kind = 'inconclusive' AND value IS NULL AND reason IS NOT NULL AND length(reason) > 0
          AND failure_code IS NOT NULL)
      )
    )
  )`
  yield* sql`INSERT INTO flows_scores_classified (
    id, kind, target_step_key, scorer_key, value, reason, failure_code, metadata_json, at_ms
  )
  SELECT
    id, kind, target_step_key, scorer_key, value, reason,
    CASE WHEN kind = 'inconclusive' THEN COALESCE(failure_code, 'inconclusive') ELSE NULL END,
    metadata_json, at_ms
  FROM flows_scores`
  yield* sql`DROP TABLE flows_scores`
  yield* sql`ALTER TABLE flows_scores_classified RENAME TO flows_scores`
  yield* sql`CREATE INDEX flows_scores_lookup_idx
    ON flows_scores (target_step_key, scorer_key, at_ms)`
})
