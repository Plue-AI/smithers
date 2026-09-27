/**
 * Durable run idempotency claims, including upgrades of existing databases.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Adds the run-key claim table without changing existing control data.
 *
 * @category migrations
 * @since 1.0.0
 */
export const runKeys = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS control_run_keys (
    idempotency_key TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    claimant TEXT NOT NULL
  )`
})
