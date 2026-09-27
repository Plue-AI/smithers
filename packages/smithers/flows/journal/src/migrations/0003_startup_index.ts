/**
 * Index for the bounded journal source-event startup window.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Preserves deterministic timestamp/run/sequence ordering without sorting the retained history.
 *
 * @category migrations
 * @since 0.1.0
 */
export const startupIndex = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE INDEX flows_journal_events_startup_idx ON flows_journal_events (emitted_at_ms DESC, run_id DESC, seq DESC)`
})
