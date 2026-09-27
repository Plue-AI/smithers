/**
 * Initial durable step result cache schema.
 *
 * See the {@link https://smithers.sh/docs/reference/api/step-cache | step-cache reference}.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the `flows_step_cache` head table and the `flows_step_cache_recorded`
 * provenance ledger.
 *
 * The head is the mutable content-addressed answer `get` serves and `evict`
 * reclaims. The ledger is append-only: every `put` also lands its entry under
 * `(key_digest, recorded_run_id, recorded_event_seq)`, so a replay that names
 * the exact recording event reads the bytes that were durable then, however
 * the head has moved since. Collection requires an explicit reference policy.
 * Eviction protects future executions from a poisoned head; it must never
 * rewrite recorded history.
 *
 * One writer outside this package does delete ledger rows:
 * `@smthrs/engine-store`'s Retention erases a terminal run's rows by
 * `recorded_run_id`, together with the journal that could have replayed them.
 * Shared-tier write-back names foreign runs that match no such delete.
 * `sweepExpired` can reclaim these rows when its host-supplied reference
 * policy confirms that no retained local history needs them.
 *
 * @category migrations
 * @since 0.1.0
 */
export const initial: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE flows_step_cache (
    key_digest TEXT PRIMARY KEY CHECK (length(key_digest) > 0),
    result_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`result_json`)}),
    meta_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`meta_json`)}),
    created_at_ms ${Dialect.integer(sql)} NOT NULL CHECK (
      ${Dialect.isInteger(sql, sql`created_at_ms`)} AND
      created_at_ms >= 0 AND
      created_at_ms <= 9007199254740991
    ),
    recorded_run_id TEXT NOT NULL CHECK (length(recorded_run_id) > 0),
    recorded_event_seq ${Dialect.integer(sql)} NOT NULL CHECK (
      ${Dialect.isInteger(sql, sql`recorded_event_seq`)} AND
      recorded_event_seq >= 0 AND
      recorded_event_seq <= 9007199254740991
    )
  )`
  yield* sql`CREATE TABLE flows_step_cache_recorded (
    key_digest TEXT NOT NULL CHECK (length(key_digest) > 0),
    result_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`result_json`)}),
    meta_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`meta_json`)}),
    created_at_ms ${Dialect.integer(sql)} NOT NULL CHECK (
      ${Dialect.isInteger(sql, sql`created_at_ms`)} AND
      created_at_ms >= 0 AND
      created_at_ms <= 9007199254740991
    ),
    recorded_run_id TEXT NOT NULL CHECK (length(recorded_run_id) > 0),
    recorded_event_seq ${Dialect.integer(sql)} NOT NULL CHECK (
      ${Dialect.isInteger(sql, sql`recorded_event_seq`)} AND
      recorded_event_seq >= 0 AND
      recorded_event_seq <= 9007199254740991
    ),
    PRIMARY KEY (key_digest, recorded_run_id, recorded_event_seq)
  )`
})
