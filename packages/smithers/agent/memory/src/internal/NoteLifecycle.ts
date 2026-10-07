/**
 * Durable lifecycle metadata for the existing append-only notes.
 *
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Adds status-transition time and accepted TODO without changing creation data.
 *
 * @category migrations
 * @since 1.0.0
 */
export const noteLifecycle = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const columns = yield* Dialect.columns(sql, "memory_notes")
  if (!columns.some((column) => column.name === "status_at_ms")) {
    yield* sql`ALTER TABLE memory_notes ADD COLUMN status_at_ms ${Dialect.integer(sql)}`
  }
  if (!columns.some((column) => column.name === "accepted_todo")) {
    yield* sql`ALTER TABLE memory_notes ADD COLUMN accepted_todo TEXT`
  }
})
