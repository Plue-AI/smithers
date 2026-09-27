/** @since 0.1.0 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Adds `active_claimed_at_ms`, the lease start of a launch reservation.
 *
 * A named export rather than `export default`: the CommonJS build reads a
 * default import of a sibling module as the whole exports object, so the
 * migrator received `{ default }` instead of this Effect.
 *
 * @category migrations
 * @since 0.1.0
 */
export const reservationLease: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE flows_triggers ADD COLUMN active_claimed_at_ms ${Dialect.integer(sql)}`
})
