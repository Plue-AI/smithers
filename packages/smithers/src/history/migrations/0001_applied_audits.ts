/**
 * The control-side record of which completed time-travel audits have parked
 * their control run.
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Idempotent: CLIs before this rung created the same table on demand.
 * @category migrations
 * @since 1.0.0
 */
export const appliedAudits = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS smthrs_history_applied(audit_id TEXT PRIMARY KEY)`
})
