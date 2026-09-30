/**
 * The default database-backed consensus strategy.
 *
 * This is the run store's former `flows_runs` ownership compare-and-swap
 * relocated: the owner tuple, the two-phase claim columns, claim recovery, and
 * the grant timestamp are the private schema of one strategy — the
 * `flows_consensus_leases` table — instead of a public contract on the run
 * row. The run row still mirrors the outcome, but the lease is what
 * arbitrates.
 *
 * Commit-time admission (R3) is exact: `guard` is a plain SELECT that joins
 * the caller's open write transaction — `DurableWriter` serializes write
 * transactions, so no reclaim can commit between the guard read and the
 * statements beside it — and every mutating operation runs through
 * `DurableWriter.write`, joining an enclosing transaction as a savepoint.
 * Prior art: Temporal's shard `rangeID` check
 * (`reference/temporal/service/history/shard/context_impl.go`,
 * `renewRangeLocked`).
 *
 * Governing design: `packages/smithers/flows/journal/docs/concepts/owner-fence.md`.
 *
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import {
  type ActivateOutcome,
  type Claimed,
  type ClaimOutcome,
  Consensus,
  ConsensusError,
  fenceLost,
  type HeartbeatOutcome,
  heartbeatStaleAfter,
  type LivenessEvidence,
  matchesEvidence,
  type RecoverOutcome,
  type Rejected,
  type RejectionReason,
  type Service
} from "./Consensus.ts"
import type { OwnerId } from "./OwnerId.ts"

const staleAfterMs = Duration.toMillis(heartbeatStaleAfter)

const rejected = (reason: RejectionReason): Rejected => ({ _tag: "Rejected", reason })
const claimed = (grantedAtMs: number): Claimed => ({ _tag: "Claimed", grantedAtMs })
const lost = { _tag: "Lost" } as const
const activated = { _tag: "Activated" } as const
const recovered = { _tag: "Recovered" } as const

interface LeaseRow {
  readonly owner_host_id: string | null
  readonly owner_pid: number | null
  readonly owner_nonce: string | null
  readonly claim_host_id: string | null
  readonly claim_pid: number | null
  readonly claim_nonce: string | null
}

/**
 * Constructs the database-backed strategy over the context's SQL client and
 * durable writer.
 *
 * @since 1.0.0
 * @category constructors
 */
export const make: Effect.Effect<Service, never, DurableWriter | SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter

  const strategyError = (cause: unknown): ConsensusError =>
    new ConsensusError({
      code: "persistence_failed",
      message: "consensus lease operation failed",
      cause
    })

  // The original cause is preserved through the wrapper so an enclosing
  // `DurableWriter.write`'s retry classification still sees a transient
  // conflict raised by a savepoint-nested lease statement.
  const write = <A>(
    body: Effect.Effect<A, unknown>
  ): Effect.Effect<A, ConsensusError> =>
    writer.write(body).pipe(Effect.mapError((cause) => cause instanceof ConsensusError ? cause : strategyError(cause)))

  const leaseOf = (runId: string) =>
    sql<LeaseRow>`
      SELECT owner_host_id, owner_pid, owner_nonce, claim_host_id, claim_pid, claim_nonce
      FROM flows_consensus_leases
      WHERE run_id = ${runId}
    `

  const prune = (runId: string) =>
    sql`
      DELETE FROM flows_consensus_leases
      WHERE run_id = ${runId} AND owner_host_id IS NULL AND claim_host_id IS NULL
    `

  const claim: Service["claim"] = Effect.fn("Consensus.claim")((
    runId: string,
    claimant: OwnerId,
    nowMs: number
  ) =>
    write(Effect.gen(function*() {
      const rows = yield* sql<{ readonly run_id: string }>`
        INSERT INTO flows_consensus_leases (run_id, claim_host_id, claim_pid, claim_nonce, claimed_at_ms)
        VALUES (${runId}, ${claimant.hostId}, ${claimant.pid}, ${claimant.nonce}, ${nowMs})
        ON CONFLICT (run_id) DO UPDATE SET
          claim_host_id = excluded.claim_host_id,
          claim_pid = excluded.claim_pid,
          claim_nonce = excluded.claim_nonce,
          claimed_at_ms = excluded.claimed_at_ms
        WHERE flows_consensus_leases.claim_host_id IS NULL
          AND flows_consensus_leases.owner_host_id IS NULL
        RETURNING run_id
      `
      if (rows.length > 0) return claimed(nowMs)
      // The upsert only misses on a conflicting row, so the lease exists and
      // holds a claim, an owner, or both.
      const lease = (yield* leaseOf(runId))[0]!
      return lease.claim_host_id !== null ? rejected("already_claimed") : rejected("owner_held")
    }))
  )

  const activate: Service["activate"] = Effect.fn("Consensus.activate")((
    runId: string,
    owner: OwnerId,
    grantedAtMs: number,
    nowMs: number
  ) =>
    write(Effect.gen(function*() {
      const rows = yield* sql<{ readonly run_id: string }>`
        UPDATE flows_consensus_leases
        SET
          owner_host_id = ${owner.hostId},
          owner_pid = ${owner.pid},
          owner_nonce = ${owner.nonce},
          granted_at_ms = ${grantedAtMs},
          heartbeat_at_ms = ${nowMs},
          claim_host_id = NULL,
          claim_pid = NULL,
          claim_nonce = NULL,
          claimed_at_ms = NULL
        WHERE run_id = ${runId}
          AND claim_host_id = ${owner.hostId}
          AND claim_pid = ${owner.pid}
          AND claim_nonce = ${owner.nonce}
          AND claimed_at_ms = ${grantedAtMs}
        RETURNING run_id
      `
      return (rows.length > 0 ? activated : lost) satisfies ActivateOutcome
    }))
  )

  const heartbeat: Service["heartbeat"] = Effect.fn("Consensus.heartbeat")((
    runId: string,
    owner: OwnerId,
    nowMs: number
  ) =>
    write(Effect.gen(function*() {
      // Monotonic: a pulse delayed past a newer one from the same owner never
      // moves the lease backwards and never makes a live run look stale.
      const rows = yield* sql<{ readonly heartbeat_at_ms: number }>`
        UPDATE flows_consensus_leases
        SET heartbeat_at_ms = ${Dialect.greatest(sql)}(heartbeat_at_ms, ${nowMs})
        WHERE run_id = ${runId}
          AND owner_host_id = ${owner.hostId}
          AND owner_pid = ${owner.pid}
          AND owner_nonce = ${owner.nonce}
        RETURNING heartbeat_at_ms
      `
      const row = rows[0]
      return (row === undefined
        ? lost
        : { _tag: "Renewed", heartbeatAtMs: Number(row.heartbeat_at_ms) }) satisfies HeartbeatOutcome
    }))
  )

  const release: Service["release"] = Effect.fn("Consensus.release")((runId: string, owner: OwnerId) =>
    write(Effect.gen(function*() {
      yield* sql`
        UPDATE flows_consensus_leases
        SET claim_host_id = NULL, claim_pid = NULL, claim_nonce = NULL, claimed_at_ms = NULL
        WHERE run_id = ${runId}
          AND claim_host_id = ${owner.hostId}
          AND claim_pid = ${owner.pid}
          AND claim_nonce = ${owner.nonce}
      `
      yield* sql`
        UPDATE flows_consensus_leases
        SET owner_host_id = NULL, owner_pid = NULL, owner_nonce = NULL,
          granted_at_ms = NULL, heartbeat_at_ms = NULL
        WHERE run_id = ${runId}
          AND owner_host_id = ${owner.hostId}
          AND owner_pid = ${owner.pid}
          AND owner_nonce = ${owner.nonce}
      `
      yield* prune(runId)
    }))
  )

  const steal: Service["steal"] = Effect.fn("Consensus.steal")((
    runId: string,
    claimant: OwnerId,
    nowMs: number,
    evidence: LivenessEvidence
  ) =>
    Effect.suspend((): Effect.Effect<ClaimOutcome, ConsensusError> => {
      if (!matchesEvidence(evidence.expectedOwner, claimant, nowMs, evidence)) {
        return Effect.succeed(rejected("evidence_invalid"))
      }
      return write(Effect.gen(function*() {
        const rows = yield* sql<{ readonly run_id: string }>`
          UPDATE flows_consensus_leases
          SET
            claim_host_id = ${claimant.hostId},
            claim_pid = ${claimant.pid},
            claim_nonce = ${claimant.nonce},
            claimed_at_ms = ${nowMs}
          WHERE run_id = ${runId}
            AND owner_host_id = ${evidence.expectedOwner.hostId}
            AND owner_pid = ${evidence.expectedOwner.pid}
            AND owner_nonce = ${evidence.expectedOwner.nonce}
            AND heartbeat_at_ms < ${nowMs - staleAfterMs}
            AND claim_host_id IS NULL
          RETURNING run_id
        `
        if (rows.length > 0) return claimed(nowMs)
        const lease = (yield* leaseOf(runId))[0]
        if (lease !== undefined && lease.claim_host_id !== null) return rejected("already_claimed")
        if (
          lease === undefined ||
          lease.owner_host_id !== evidence.expectedOwner.hostId ||
          Number(lease.owner_pid) !== evidence.expectedOwner.pid ||
          lease.owner_nonce !== evidence.expectedOwner.nonce
        ) {
          // A run nobody owns, or one owned by somebody else, has no owner
          // this evidence could disprove.
          return rejected("evidence_invalid")
        }
        return rejected("owner_live")
      }))
    })
  )

  const recover: Service["recover"] = Effect.fn("Consensus.recover")((
    runId: string,
    staleClaimant: OwnerId,
    grantedAtMs: number,
    observer: OwnerId,
    nowMs: number,
    evidence: LivenessEvidence
  ) =>
    Effect.suspend((): Effect.Effect<RecoverOutcome, ConsensusError> => {
      if (!matchesEvidence(staleClaimant, observer, nowMs, evidence)) {
        return Effect.succeed(rejected("evidence_invalid"))
      }
      return write(Effect.gen(function*() {
        const rows = yield* sql<{ readonly run_id: string }>`
          UPDATE flows_consensus_leases
          SET claim_host_id = NULL, claim_pid = NULL, claim_nonce = NULL, claimed_at_ms = NULL
          WHERE run_id = ${runId}
            AND claim_host_id = ${staleClaimant.hostId}
            AND claim_pid = ${staleClaimant.pid}
            AND claim_nonce = ${staleClaimant.nonce}
            AND claimed_at_ms = ${grantedAtMs}
            AND claimed_at_ms < ${nowMs - staleAfterMs}
          RETURNING run_id
        `
        if (rows.length > 0) {
          yield* prune(runId)
          return recovered
        }
        const matches = yield* sql<{ readonly run_id: string }>`
          SELECT run_id FROM flows_consensus_leases
          WHERE run_id = ${runId}
            AND claim_host_id = ${staleClaimant.hostId}
            AND claim_pid = ${staleClaimant.pid}
            AND claim_nonce = ${staleClaimant.nonce}
            AND claimed_at_ms = ${grantedAtMs}
        `
        // The exact claim survived the compare-and-swap only because it is
        // not yet stale; anything else means the claim moved on.
        return matches.length > 0 ? rejected("claim_fresh") : rejected("claim_changed")
      }))
    })
  )

  const guard: Service["guard"] = Effect.fn("Consensus.guard")((runId: string, owner: OwnerId) =>
    write(Effect.gen(function*() {
      const held = yield* sql<{ readonly ok: number }>`
        SELECT 1 AS ok FROM flows_consensus_leases
        WHERE run_id = ${runId}
          AND owner_host_id = ${owner.hostId}
          AND owner_pid = ${owner.pid}
          AND owner_nonce = ${owner.nonce}
      `
      if (held.length === 0) {
        return yield* Effect.fail(fenceLost(runId, owner))
      }
    }))
  )

  return Consensus.of({ claim, activate, heartbeat, release, steal, recover, guard })
})

/**
 * Provides the database-backed strategy.
 *
 * @since 1.0.0
 * @category layers
 */
export const layer: Layer.Layer<Consensus, never, DurableWriter | SqlClient.SqlClient> = Layer.effect(Consensus, make)
