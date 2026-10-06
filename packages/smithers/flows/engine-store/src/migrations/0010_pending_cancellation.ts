/**
 * Indexed cancellation cleanup for admissions whose handler is unavailable.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Bounds cleanup reads to requested pending rows.
 *
 * @category migrations
 * @since 1.0.0
 */
export const pendingCancellation: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE INDEX flows_runs_pending_cancel_idx ON flows_runs (created_at_ms, run_id)
    WHERE status = 'pending' AND cancel_requested_at_ms IS NOT NULL`
})
