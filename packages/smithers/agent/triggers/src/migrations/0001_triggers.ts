/** @since 0.1.0 */
import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the `flows_triggers` and `flows_trigger_fires` tables.
 *
 * A named export rather than `export default`: the CommonJS build reads a
 * default import of a sibling module as the whole exports object, so the
 * migrator received `{ default }` instead of this Effect.
 *
 * @category migrations
 * @since 0.1.0
 */
export const triggers: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS flows_triggers (
    trigger_id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL,
    input_json TEXT NOT NULL,
    cron TEXT NOT NULL,
    timezone TEXT,
    overlap TEXT NOT NULL CHECK (overlap IN ('skip', 'buffer-one', 'supersede')),
    catch_up TEXT NOT NULL CHECK (catch_up IN ('none', 'one', 'all')),
    max_catch_up ${Dialect.integer(sql)} NOT NULL CHECK (max_catch_up >= 0),
    enabled ${Dialect.integer(sql)} NOT NULL CHECK (enabled IN (0, 1)),
    revision ${Dialect.integer(sql)} NOT NULL,
    last_fired_at_ms ${Dialect.integer(sql)},
    pending_at_ms ${Dialect.integer(sql)},
    active_run_id TEXT
  )`
  yield* sql`CREATE TABLE IF NOT EXISTS flows_trigger_fires (
    trigger_id TEXT NOT NULL,
    occurrence_at_ms ${Dialect.integer(sql)} NOT NULL,
    outcome TEXT,
    run_id TEXT,
    error TEXT,
    PRIMARY KEY (trigger_id, occurrence_at_ms),
    FOREIGN KEY (trigger_id) REFERENCES flows_triggers (trigger_id)
  )`
})
