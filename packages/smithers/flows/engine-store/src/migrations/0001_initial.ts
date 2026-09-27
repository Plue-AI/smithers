/**
 * Initial durable deferred-completion and clock-deadline schema.
 *
 * Schema boundary: `packages/smithers/flows/engine-store/docs/concepts/durable-waits.md`.
 *
 * @since 0.1.0
 */
import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the `flows_deferred_completions` and `flows_clock_deadlines` tables.
 *
 * @category migrations
 * @since 0.1.0
 */
export const initial: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE flows_deferred_completions (
    flow_name TEXT NOT NULL CHECK (length(flow_name) > 0),
    execution_id TEXT NOT NULL CHECK (length(execution_id) > 0),
    deferred_name TEXT NOT NULL CHECK (length(deferred_name) > 0),
    exit_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`exit_json`)}),
    metadata_json TEXT CHECK (metadata_json IS NULL OR ${Dialect.jsonValid(sql, sql`metadata_json`)}),
    completed_at_ms ${Dialect.integer(sql)} NOT NULL CHECK (${
    Dialect.isInteger(sql, sql`completed_at_ms`)
  } AND completed_at_ms >= 0 AND completed_at_ms <= 9007199254740991),
    PRIMARY KEY (flow_name, execution_id, deferred_name),
    FOREIGN KEY (execution_id) REFERENCES flows_runs (run_id)
  )`

  yield* sql`CREATE TABLE flows_clock_deadlines (
    flow_name TEXT NOT NULL CHECK (length(flow_name) > 0),
    execution_id TEXT NOT NULL CHECK (length(execution_id) > 0),
    clock_name TEXT NOT NULL CHECK (length(clock_name) > 0),
    deferred_name TEXT NOT NULL CHECK (length(deferred_name) > 0),
    due_at_ms ${Dialect.integer(sql)} NOT NULL CHECK (${
    Dialect.isInteger(sql, sql`due_at_ms`)
  } AND due_at_ms >= 0 AND due_at_ms <= 9007199254740991),
    completed_at_ms ${Dialect.integer(sql)} CHECK (completed_at_ms IS NULL OR (${
    Dialect.isInteger(sql, sql`completed_at_ms`)
  } AND completed_at_ms >= 0 AND completed_at_ms <= 9007199254740991)),
    PRIMARY KEY (flow_name, execution_id, clock_name),
    FOREIGN KEY (execution_id) REFERENCES flows_runs (run_id)
  )`

  yield* sql`CREATE INDEX flows_clock_deadlines_pending_idx ON flows_clock_deadlines (completed_at_ms, due_at_ms)`
})
