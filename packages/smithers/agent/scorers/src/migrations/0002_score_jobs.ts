/**
 * Idempotent scorer job-claim schema.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the scorer job-claim table.
 *
 * @category migrations
 * @since 0.1.0
 */
export const migration: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE flows_score_jobs (
    identity TEXT PRIMARY KEY,
    created_at_ms ${Dialect.integer(sql)} NOT NULL
  )`
})
