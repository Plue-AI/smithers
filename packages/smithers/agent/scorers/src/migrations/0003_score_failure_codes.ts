/**
 * Structured inconclusive failure codes and the checks that keep the table
 * readable.
 *
 * Two defects share this migration because both need the table rebuilt.
 * SQLite cannot add a `CHECK` to an existing table, and the store used to
 * persist observations it never validated: an inconclusive row with a `NULL`
 * reason was accepted on write and rejected on every later read of that
 * target, and a non-integral `at_ms` survived REAL affinity. `failure_code`
 * carries the classification the reason prose used to be the only record of.
 *
 * @since 0.1.0
 */
import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Rebuilds the score table with a failure code and the tightened checks.
 *
 * @category migrations
 * @since 0.1.0
 */
export const migration: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  // This literal list is frozen with the migration; `ScorerErrorCode` in
  // ../ScorerError.ts is the live vocabulary. Adding a code there requires a
  // new migration that rebuilds this CHECK, and `ScoreStore.test.ts` writes
  // every code through the store so the two cannot drift unnoticed.
  yield* sql`CREATE TABLE flows_scores_rebuilt (
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
        (kind = 'inconclusive' AND value IS NULL AND reason IS NOT NULL AND length(reason) > 0)
      )
    )
  )`
  // Rows written before these checks existed are repaired, never dropped and
  // never left to abort the copy: a store that cannot finish its migration is
  // a store that never opens again.
  yield* sql`INSERT INTO flows_scores_rebuilt (
    id, kind, target_step_key, scorer_key, value, reason, failure_code, metadata_json, at_ms
  )
  SELECT
    id,
    kind,
    CASE
      WHEN length(target_step_key) = 0
      THEN 'Stored target step key predates the non-empty-key requirement'
      ELSE target_step_key
    END,
    CASE
      WHEN length(scorer_key) = 0
      THEN 'Stored scorer key predates the non-empty-key requirement'
      ELSE scorer_key
    END,
    value,
    CASE
      WHEN kind = 'inconclusive' AND (reason IS NULL OR length(reason) = 0)
      THEN 'Stored inconclusive observation predates the recorded-reason requirement'
      ELSE reason
    END,
    NULL,
    metadata_json,
    ${Dialect.greatest(sql)}(0, cast(at_ms AS BIGINT))
  FROM flows_scores`
  yield* sql`DROP TABLE flows_scores`
  yield* sql`ALTER TABLE flows_scores_rebuilt RENAME TO flows_scores`
  yield* sql`CREATE INDEX flows_scores_lookup_idx
    ON flows_scores (target_step_key, scorer_key, at_ms)`
})
