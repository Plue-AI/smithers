/**
 * Lease-row fixtures for suites that exercise the fenced channel without
 * driving the two-phase claim lifecycle themselves.
 *
 * `flows_consensus_leases` is `SqlConsensus`'s private table, created by this
 * package's own migrations, so a journal suite can stand a fence up by
 * writing the row the strategy's `guard` reads. The conformance suite drives
 * the same fence through the strategy's public operations instead.
 */
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import type { OwnerId } from "../../src/OwnerId.ts"

/** Makes `holder` the run's owner, replacing whoever held it before. */
export const hold = (sql: SqlClient.SqlClient, runId: string, holder: OwnerId, heartbeatAtMs = 0) =>
  sql`
    INSERT INTO flows_consensus_leases (
      run_id, owner_host_id, owner_pid, owner_nonce, granted_at_ms, heartbeat_at_ms
    ) VALUES (
      ${runId}, ${holder.hostId}, ${holder.pid}, ${holder.nonce}, ${heartbeatAtMs}, ${heartbeatAtMs}
    )
    ON CONFLICT (run_id) DO UPDATE SET
      owner_host_id = excluded.owner_host_id,
      owner_pid = excluded.owner_pid,
      owner_nonce = excluded.owner_nonce,
      granted_at_ms = excluded.granted_at_ms,
      heartbeat_at_ms = excluded.heartbeat_at_ms,
      claim_host_id = NULL,
      claim_pid = NULL,
      claim_nonce = NULL,
      claimed_at_ms = NULL
  `

/** Drops the run's lease entirely, as a released or settled run has none. */
export const release = (sql: SqlClient.SqlClient, runId: string) =>
  sql`DELETE FROM flows_consensus_leases WHERE run_id = ${runId}`
