/**
 * Indexed allocation of the global run-parent sequence.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Supports MAX(seq) without scanning retained edges from unrelated runs.
 *
 * @category migrations
 * @since 1.0.0
 */
export const runParentSequence: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE INDEX flows_run_parents_seq_idx ON flows_run_parents (seq)`
})
