/** @since 1.0.0-rc.1 */

import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Indexes `flows_trigger_fires` by `run_id`, so a fires listing filtered to
 * one run and the prune's active-run check read an index instead of the
 * whole ledger.
 *
 * A named export rather than `export default`: the CommonJS build reads a
 * default import of a sibling module as the whole exports object, so the
 * migrator received `{ default }` instead of this Effect.
 *
 * @category migrations
 * @since 1.0.0-rc.1
 */
export const fireRunIndex: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE INDEX IF NOT EXISTS flows_trigger_fires_run_id ON flows_trigger_fires (run_id)`
})
