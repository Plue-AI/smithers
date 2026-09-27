/**
 * Preserve the actual decision without guessing erased legacy answers.
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Idempotent for both recorded migrations and standalone runtime bootstrap.
 * @category migrations
 * @since 1.0.0
 */
export const approvalDecisions = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(Effect.gen(function*() {
    const columns = yield* Dialect.columns(sql, "control_tokens")
    if (columns.some((column) => column.name === "decision_json")) return
    // NULL is intentional: old terminal tokens erased their answer. Their
    // decoder refuses recovery instead of inferring approval from a grant.
    // An undecided token still has its unambiguous resolved=0 representation.
    yield* sql`ALTER TABLE control_tokens ADD COLUMN decision_json TEXT`
  }))
})
