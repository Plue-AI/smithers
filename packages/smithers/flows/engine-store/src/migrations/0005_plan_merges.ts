/**
 * Durable scheduler merge intentions and their committed plan extensions.
 * @since 1.0.0
 */
import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Existing heads retain an unknown merge-state version; a later runtime must
 * not infer its missing control decisions from arbitrary plan-node bodies.
 * @since 1.0.0
 * @category migrations
 */
export const planMerges: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE flows_plan_input_heads ADD COLUMN merge_state_version ${Dialect.integer(sql)}
    CHECK (merge_state_version IS NULL OR merge_state_version = 1)`
  yield* Dialect.trigger(sql, {
    name: `flows_plan_input_heads_merge_version_immutable`,
    table: `flows_plan_input_heads`,
    event: "BEFORE UPDATE",
    when: `NEW.merge_state_version IS DISTINCT FROM OLD.merge_state_version`,
    reject: "plan merge state version is immutable"
  })
  yield* sql`CREATE TABLE flows_plan_merge_intents (
    run_id TEXT NOT NULL REFERENCES flows_runs(run_id) ON DELETE CASCADE,
    stopped_node_id TEXT NOT NULL CHECK (length(stopped_node_id) > 0),
    intent_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`intent_json`)}),
    checksum TEXT NOT NULL CHECK (length(checksum) = 64),
    PRIMARY KEY (run_id, stopped_node_id)
  )`
  yield* sql`CREATE TABLE flows_plan_merge_completions (
    run_id TEXT NOT NULL REFERENCES flows_runs(run_id) ON DELETE CASCADE,
    stopped_node_id TEXT NOT NULL CHECK (length(stopped_node_id) > 0),
    generation ${Dialect.integer(sql)} NOT NULL CHECK (${Dialect.isInteger(sql, sql`generation`)} AND generation > 0),
    merge_node_id TEXT NOT NULL CHECK (length(merge_node_id) > 0),
    completion_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`completion_json`)}),
    checksum TEXT NOT NULL CHECK (length(checksum) = 64),
    PRIMARY KEY (run_id, stopped_node_id),
    UNIQUE (run_id, generation), UNIQUE (run_id, merge_node_id),
    FOREIGN KEY (run_id, stopped_node_id) REFERENCES flows_plan_merge_intents(run_id, stopped_node_id) ON DELETE CASCADE
  )`
  for (const table of ["flows_plan_merge_intents", "flows_plan_merge_completions"]) {
    yield* Dialect.trigger(sql, {
      name: `${table}_no_update`,
      table: `${table}`,
      event: "BEFORE UPDATE",
      reject: "plan merge decisions are immutable"
    })
    yield* Dialect.trigger(sql, {
      name: `${table}_no_delete`,
      table: `${table}`,
      event: "BEFORE DELETE",
      when: `EXISTS (SELECT 1 FROM flows_runs WHERE run_id = OLD.run_id)`,
      reject: "plan merge decisions belong to their run"
    })
  }
})
