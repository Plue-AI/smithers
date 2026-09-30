/**
 * Record who launched each run.
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Adds the launching principal to the launch index.
 *
 * NULL is intentional for existing rows: a run launched before these columns
 * has no recorded launcher, so only a reader that sees every run lists or
 * watches it.
 *
 * @category migrations
 * @since 1.0.0
 */
export const runPrincipals = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(Effect.gen(function*() {
    const columns = yield* Dialect.columns(sql, "control_runs")
    if (!columns.some((column) => column.name === "principal_id")) {
      yield* sql`ALTER TABLE control_runs ADD COLUMN principal_id TEXT`
    }
    if (!columns.some((column) => column.name === "principal_kind")) {
      yield* sql`ALTER TABLE control_runs ADD COLUMN principal_kind TEXT`
    }
  }))
})
