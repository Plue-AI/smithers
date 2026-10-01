/**
 * Record the operator consent a resume delegation carries.
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Adds the journal sequence of an operator's explicit resume to the pending
 * resume delegations.
 *
 * NULL is intentional for existing rows: a delegation recorded before this
 * column is an approval or a wake, which is background intent.
 *
 * @category migrations
 * @since 1.0.0
 */
export const resumeConsent = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(Effect.gen(function*() {
    const columns = yield* Dialect.columns(sql, "control_run_resumes")
    if (!columns.some((column) => column.name === "consent_seq")) {
      yield* sql`ALTER TABLE control_run_resumes ADD COLUMN consent_seq ${Dialect.integer(sql)}`
    }
  }))
})
