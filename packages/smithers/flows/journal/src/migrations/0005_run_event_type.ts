/**
 * Indexed exact event-type reads within a run.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Keeps filtered cursor reads proportional to the matching entries.
 *
 * @category migrations
 * @since 1.0.0
 */
export const runEventType: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE INDEX flows_journal_events_run_event_type_idx ON flows_journal_events (run_id, event_type, seq)`
})
