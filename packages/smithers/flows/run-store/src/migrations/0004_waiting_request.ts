/**
 * The question a parked run is waiting on an answer to.
 *
 * `waiting_reason` and `waiting_token` say THAT a run is parked on a human
 * decision and which wait point holds it; neither says what was asked. A
 * `HumanTask` park therefore left the prompt, the kind of answer it wants, and
 * the attempt budget nowhere a reader could find them: the question lived only
 * in the action payload of an execution that had already released its owner,
 * so the approvals inbox could describe the gate as "something is waiting" and
 * no more (run-3, `coding-clarification`).
 *
 * This column is that missing half. It is the JSON the wait declared about
 * itself — for `HumanTask`, `{kind, name, prompt, attempt, maxAttempts}` — and
 * it is written and cleared with the other three waiting columns, so it can
 * never describe a wait the run is no longer holding.
 *
 * Append-only, as every migration after the first must be: the column is
 * nullable, so every row an earlier build wrote stays valid and reads back as
 * a park that declared no question.
 *
 * @since 1.0.0
 */
import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Adds `waiting_request` to `flows_runs`.
 *
 * @category migrations
 * @since 1.0.0
 */
export const waitingRequest: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE flows_runs ADD COLUMN waiting_request TEXT
    CHECK (waiting_request IS NULL OR ${Dialect.jsonValid(sql, sql`waiting_request`)})`
})
