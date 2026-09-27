/**
 * Durable database identity and coalesced execution change tracking.
 *
 * @since 1.0.0
 */
import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Retains one current revision per run ID, including deleted IDs forever.
 * Triggers participate in the mutating transaction, including raw SQL writes.
 * @category migrations
 * @since 1.0.0
 */
export const executionRevisions: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE flows_run_source (
    singleton ${Dialect.integer(sql)} PRIMARY KEY CHECK (singleton = 1),
    source TEXT NOT NULL CHECK (length(source) = 32 AND ${
    sql.literal(Dialect.isPostgres(sql) ? "source !~ '[^0-9a-f]'" : "source NOT GLOB '*[^0-9a-f]*'")
  }),
    revision ${Dialect.integer(sql)} NOT NULL CHECK (${
    Dialect.isInteger(sql, sql`revision`)
  } AND revision >= 0 AND revision <= 9007199254740991)
  )`
  yield* sql`INSERT INTO flows_run_source VALUES (1, ${
    sql.literal(Dialect.isPostgres(sql) ? "replace(gen_random_uuid()::text, '-', '')" : "lower(hex(randomblob(16)))")
  }, 0)`
  yield* sql`CREATE TABLE flows_run_changes (
    run_id TEXT PRIMARY KEY NOT NULL CHECK (length(run_id) > 0),
    revision ${Dialect.integer(sql)} NOT NULL UNIQUE CHECK (${
    Dialect.isInteger(sql, sql`revision`)
  } AND revision > 0 AND revision <= 9007199254740991),
    deleted ${Dialect.integer(sql)} NOT NULL CHECK (deleted IN (0, 1))
  )`
  yield* sql`ALTER TABLE flows_runs ADD COLUMN cancel_acknowledgement_json TEXT
    CHECK (cancel_acknowledgement_json IS NULL OR ${Dialect.jsonValid(sql, sql`cancel_acknowledgement_json`)})`
  // Old rows receive a real baseline revision; their prior mutation order is unknown.
  yield* sql`INSERT INTO flows_run_changes (run_id, revision, deleted)
    SELECT run_id, ROW_NUMBER() OVER (ORDER BY created_at_ms, run_id), 0 FROM flows_runs`
  yield* sql`UPDATE flows_run_source SET revision = (SELECT COUNT(*) FROM flows_run_changes)`
  for (const [operation, row, deleted] of [["INSERT", "NEW", 0], ["UPDATE", "NEW", 0], ["DELETE", "OLD", 1]] as const) {
    yield* Dialect.trigger(sql, {
      name: `flows_runs_revision_${operation.toLowerCase()}`,
      table: "flows_runs",
      event: `AFTER ${operation}`,
      body: `
        ${
        Dialect.isPostgres(sql)
          ? "IF NOT EXISTS (SELECT 1 FROM flows_run_source WHERE singleton = 1) THEN RAISE EXCEPTION 'execution source identity is missing' USING ERRCODE = '23514'; END IF;"
          : "SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM flows_run_source WHERE singleton = 1) THEN RAISE(ABORT, 'execution source identity is missing') END;"
      }
        UPDATE flows_run_source SET revision = revision + 1 WHERE singleton = 1;
        INSERT INTO flows_run_changes (run_id, revision, deleted)
          SELECT ${row}.run_id, revision, ${deleted} FROM flows_run_source WHERE singleton = 1
          ON CONFLICT (run_id) DO UPDATE SET revision = excluded.revision, deleted = excluded.deleted;
      `
    })
  }
  yield* Dialect.trigger(sql, {
    name: `flows_runs_identity_immutable`,
    table: `flows_runs`,
    event: "BEFORE UPDATE OF run_id",
    when: `NEW.run_id <> OLD.run_id`,
    reject: "run identity is immutable"
  })
})
