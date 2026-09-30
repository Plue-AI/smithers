/**
 * The `SqlConsensus` lease table.
 *
 * This is the private schema of the default consensus strategy: the owner
 * tuple, the two-phase claim columns, and the grant timestamp relocated from
 * `flows_runs`. Lease rows are strategy evidence, never history: heartbeats
 * and lease state never enter the journal.
 *
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the `flows_consensus_leases` table and backfills a lease for every
 * running or claimed run when `flows_runs` is already present, so an owner
 * that was driving a run before this migration keeps its fence afterwards.
 *
 * @category migrations
 * @since 1.0.0
 */
export const consensus: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE flows_consensus_leases (
    run_id TEXT PRIMARY KEY CHECK (length(run_id) > 0),
    owner_host_id TEXT,
    owner_pid ${Dialect.integer(sql)} CHECK (owner_pid IS NULL OR (${
    Dialect.isInteger(sql, sql`owner_pid`)
  } AND owner_pid >= 0)),
    owner_nonce TEXT,
    granted_at_ms ${Dialect.integer(sql)} CHECK (granted_at_ms IS NULL OR (${
    Dialect.isInteger(sql, sql`granted_at_ms`)
  } AND granted_at_ms >= 0)),
    heartbeat_at_ms ${Dialect.integer(sql)} CHECK (heartbeat_at_ms IS NULL OR (${
    Dialect.isInteger(sql, sql`heartbeat_at_ms`)
  } AND heartbeat_at_ms >= 0)),
    claim_host_id TEXT,
    claim_pid ${Dialect.integer(sql)} CHECK (claim_pid IS NULL OR (${
    Dialect.isInteger(sql, sql`claim_pid`)
  } AND claim_pid >= 0)),
    claim_nonce TEXT,
    claimed_at_ms ${Dialect.integer(sql)} CHECK (claimed_at_ms IS NULL OR (${
    Dialect.isInteger(sql, sql`claimed_at_ms`)
  } AND claimed_at_ms >= 0))
  )`

  const tables = yield* Dialect.tables(sql)
  if (!tables.some((table) => table.name === "flows_runs")) {
    return
  }

  yield* sql`
    INSERT INTO flows_consensus_leases (
      run_id,
      owner_host_id,
      owner_pid,
      owner_nonce,
      granted_at_ms,
      heartbeat_at_ms,
      claim_host_id,
      claim_pid,
      claim_nonce,
      claimed_at_ms
    )
    SELECT
      run_id,
      owner_host_id,
      owner_pid,
      owner_nonce,
      CASE WHEN status = 'running' THEN heartbeat_at_ms ELSE NULL END,
      CASE WHEN status = 'running' THEN heartbeat_at_ms ELSE NULL END,
      claim_host_id,
      claim_pid,
      claim_nonce,
      claimed_at_ms
    FROM flows_runs
    WHERE status = 'running' OR claim_host_id IS NOT NULL
    ON CONFLICT (run_id) DO NOTHING
  `
})
