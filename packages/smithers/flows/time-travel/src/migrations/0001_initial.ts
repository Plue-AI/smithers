/**
 * Initial time-travel schema. Keep this rung frozen.
 *
 * @since 0.1.0
 */
import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { step } from "../internal/MigrationStep.ts"

/**
 * Creates the original time-travel tables and indexes.
 *
 * @since 0.1.0
 * @private
 */
export const initial = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* step(
    "flows_time_travel_audits",
    sql`CREATE TABLE IF NOT EXISTS flows_time_travel_audits (
    ${Dialect.rowId(sql)}
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    lineage_id TEXT NOT NULL CHECK (length(lineage_id) > 0),
    seq ${Dialect.integer(sql)} NOT NULL CHECK (${
      Dialect.isInteger(sql, sql`seq`)
    } AND seq >= 0 AND seq <= 9007199254740991),
    status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
    rate_limit_json TEXT CHECK (rate_limit_json IS NULL OR ${Dialect.jsonValid(sql, sql`rate_limit_json`)}),
    detail_json TEXT CHECK (detail_json IS NULL OR ${Dialect.jsonValid(sql, sql`detail_json`)})
  )`
  )
  yield* step(
    "flows_time_travel_audits_status_idx on flows_time_travel_audits",
    sql`CREATE INDEX IF NOT EXISTS flows_time_travel_audits_status_idx
    ON flows_time_travel_audits (status)`
  )
  yield* step(
    "flows_time_travel_receipts",
    sql`CREATE TABLE IF NOT EXISTS flows_time_travel_receipts (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    audit_id TEXT NOT NULL CHECK (length(audit_id) > 0),
    effect_id TEXT NOT NULL CHECK (length(effect_id) > 0),
    receipt_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`receipt_json`)})
  )`
  )
  yield* step(
    "flows_time_travel_snapshots",
    sql`CREATE TABLE IF NOT EXISTS flows_time_travel_snapshots (
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    lineage_id TEXT NOT NULL CHECK (length(lineage_id) > 0),
    seq ${Dialect.integer(sql)} NOT NULL CHECK (${
      Dialect.isInteger(sql, sql`seq`)
    } AND seq >= 0 AND seq <= 9007199254740991),
    change_id TEXT NOT NULL CHECK (length(change_id) > 0),
    PRIMARY KEY (run_id, lineage_id, seq)
  )`
  )
  // The frame address is `(lineageId, seq)`, and every engine record carries
  // its lineage in the open `meta` envelope. Indexing it out of `meta_json`
  // keeps a lineage-filtered replay from degenerating into a full run scan.
  yield* step(
    "flows_journal_events_lineage_idx on flows_journal_events",
    sql`CREATE INDEX IF NOT EXISTS flows_journal_events_lineage_idx
    ON flows_journal_events (run_id, ${Dialect.jsonText(sql, sql`meta_json`, "$.lineageId")}, seq)`
  )
  yield* step(
    "flows_time_travel_edges",
    sql`CREATE TABLE IF NOT EXISTS flows_time_travel_edges (
    ${Dialect.rowId(sql)}
    parent_run_id TEXT NOT NULL CHECK (length(parent_run_id) > 0),
    parent_seq ${Dialect.integer(sql)} NOT NULL CHECK (
      ${Dialect.isInteger(sql, sql`parent_seq`)} AND parent_seq >= 0 AND parent_seq <= 9007199254740991
    ),
    child_run_id TEXT NOT NULL UNIQUE CHECK (length(child_run_id) > 0),
    kind TEXT NOT NULL CHECK (kind IN ('child', 'fork', 'continuation')),
    attached ${Dialect.integer(sql)} NOT NULL CHECK (attached IN (0, 1)),
    CHECK (parent_run_id <> child_run_id)
  )`
  )
  yield* step(
    "flows_time_travel_edges_parent_idx on flows_time_travel_edges",
    sql`CREATE INDEX IF NOT EXISTS flows_time_travel_edges_parent_idx
    ON flows_time_travel_edges (parent_run_id, parent_seq)`
  )
  // A minted fork id, reserved before the child's workspace is provisioned
  // and consumed when the fork commits. A row that outlives its fork is the
  // durable trace of a process that died between the two; it keeps its
  // ordinal taken (`reclaimed_at_ms` marks it handed back) so a retry never
  // asks jj for the lane name the leftover on disk already holds.
  yield* step(
    "flows_time_travel_fork_intents",
    sql`CREATE TABLE IF NOT EXISTS flows_time_travel_fork_intents (
    child_run_id TEXT PRIMARY KEY CHECK (length(child_run_id) > 0),
    parent_run_id TEXT NOT NULL CHECK (length(parent_run_id) > 0),
    parent_seq ${Dialect.integer(sql)} NOT NULL CHECK (
      ${Dialect.isInteger(sql, sql`parent_seq`)} AND parent_seq >= 0 AND parent_seq <= 9007199254740991
    ),
    reserved_at_ms ${Dialect.integer(sql)} NOT NULL CHECK (
      ${Dialect.isInteger(sql, sql`reserved_at_ms`)} AND reserved_at_ms >= 0 AND reserved_at_ms <= 9007199254740991
    ),
    reclaimed_at_ms ${Dialect.integer(sql)} CHECK (
      reclaimed_at_ms IS NULL
      OR (${
      Dialect.isInteger(sql, sql`reclaimed_at_ms`)
    } AND reclaimed_at_ms >= 0 AND reclaimed_at_ms <= 9007199254740991)
    )
  )`
  )
  yield* step(
    "flows_time_travel_fork_intents_parent_idx on flows_time_travel_fork_intents",
    sql`CREATE INDEX IF NOT EXISTS flows_time_travel_fork_intents_parent_idx
    ON flows_time_travel_fork_intents (parent_run_id, parent_seq)`
  )
  yield* step(
    "flows_time_travel_archive",
    sql`CREATE TABLE IF NOT EXISTS flows_time_travel_archive (
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    seq ${Dialect.integer(sql)} NOT NULL CHECK (${
      Dialect.isInteger(sql, sql`seq`)
    } AND seq >= 0 AND seq <= 9007199254740991),
    event_id TEXT NOT NULL CHECK (length(event_id) > 0),
    source_id TEXT NOT NULL CHECK (length(source_id) > 0),
    source_seq ${Dialect.integer(sql)} NOT NULL CHECK (
      ${Dialect.isInteger(sql, sql`source_seq`)} AND source_seq >= 0 AND source_seq <= 9007199254740991
    ),
    emitted_at_ms ${Dialect.integer(sql)} NOT NULL CHECK (
      ${Dialect.isInteger(sql, sql`emitted_at_ms`)} AND emitted_at_ms >= 0 AND emitted_at_ms <= 9007199254740991
    ),
    event_type TEXT NOT NULL CHECK (length(event_type) > 0),
    payload_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`payload_json`)}),
    meta_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`meta_json`)}),
    archived_at_ms ${Dialect.integer(sql)} NOT NULL CHECK (
      ${Dialect.isInteger(sql, sql`archived_at_ms`)} AND archived_at_ms >= 0 AND archived_at_ms <= 9007199254740991
    ),
    PRIMARY KEY (run_id, seq)
  )`
  )
})
