/**
 * Record who admitted each signal command.
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Adds the admitting principal to the signal inbox.
 *
 * NULL is intentional for existing rows: a command admitted before this column
 * has no recorded identity, so it cannot answer a human wait, which requires
 * `ApprovalAuthority` to authorize the admitting principal.
 *
 * @category migrations
 * @since 1.0.0
 */
export const signalPrincipals = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(Effect.gen(function*() {
    const columns = yield* Dialect.columns(sql, "control_signal_commands")
    if (columns.some((column) => column.name === "principal_json")) return
    yield* sql`ALTER TABLE control_signal_commands ADD COLUMN principal_json TEXT`
  }))
})
