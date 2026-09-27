/**
 * Durable signal admission and immutable wait bindings.
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Adds the signal inbox without replaying legacy messages that lack delivery identity.
 * @category migrations
 * @since 1.0.0
 */
export const signalCommands = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS control_signal_commands (
    seq ${Dialect.identity(sql)},
    command_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    wait_token TEXT,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'rejected', 'terminal'))
  )`
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS control_signal_commands_wait ON control_signal_commands(wait_token) WHERE wait_token IS NOT NULL`
  yield* sql`CREATE INDEX IF NOT EXISTS control_signal_commands_pending ON control_signal_commands(state, seq)`
})
