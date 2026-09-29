/**
 * Startup recovery for incomplete rewind audits.
 *
 * @since 0.1.0
 */

import type { Jj } from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import type { LivenessEvidence, OwnerId } from "@smthrs/run-store/Ownership"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as Clock from "effect/Clock"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { error, fromCause, type TimeTravelError as TimeTravelFailure } from "../TimeTravelError.ts"
import { type Audit, TimeTravelStore } from "../TimeTravelStore.ts"
import * as Compensation from "./Compensation.ts"
import type { EffectHandlerRegistry } from "./EffectHandlerRegistry.ts"
import * as Lease from "./Lease.ts"
import { AuditDetail } from "./Rewind.ts"
import * as RunRow from "./RunRow.ts"

/**
 * Recovery construction options.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly compensationTimeout?: Duration.Input | undefined
  readonly owner: OwnerId
  /**
   * Proof that the owner a running run or child records is gone. `undefined`
   * declines the takeover, and the audit stays `Busy` for a later pass.
   */
  readonly livenessEvidence: (
    audit: Audit,
    row: RunStore.RunRow,
    owner: OwnerId,
    nowMs: number
  ) => Effect.Effect<LivenessEvidence | undefined, TimeTravelFailure>
}

/**
 * Outcome for one recovered audit.
 *
 * `Busy` is a "not yet", not a failure: another process holds the run, or this
 * pass could not give acquired ownership back, so the audit row stays
 * `in_progress`, stays in `pendingAudits`, and remains recoverable. `Failed`
 * is terminal and closes the audit.
 *
 * @since 0.1.0
 * @category models
 */
export type Outcome =
  | { readonly _tag: "Completed"; readonly auditId: string }
  | { readonly _tag: "RolledBack"; readonly auditId: string }
  | { readonly _tag: "Busy"; readonly auditId: string; readonly error: TimeTravelFailure }
  | { readonly _tag: "Failed"; readonly auditId: string; readonly error: TimeTravelFailure }

const isAuditDetail = Schema.is(AuditDetail)

const sameOwner = (left: OwnerId, right: OwnerId): boolean =>
  left.hostId === right.hostId &&
  left.pid === right.pid &&
  left.nonce === right.nonce

const acquire = (
  runs: RunStore.Service,
  audit: Audit,
  options: Options
): Effect.Effect<RunStore.RunRow, TimeTravelFailure, Journal.Journal> =>
  Effect.gen(function*() {
    const row = yield* runs.get(audit.runId).pipe(
      Effect.mapError((cause) => RunRow.failure("read recovery run", cause))
    )
    if (row.status === "running" && row.owner !== null && sameOwner(row.owner, options.owner)) {
      return row
    }
    if (row.claim !== null) {
      return yield* Effect.fail(error("busy", `run ${audit.runId} has an active claim`))
    }

    const nowMs = yield* Clock.currentTimeMillis
    const running = row.status === "running"
    const evidence = running
      ? yield* Effect.gen(function*() {
        const found = yield* options.livenessEvidence(audit, row, options.owner, nowMs)
        if (found === undefined) {
          return yield* Effect.fail(error("busy", `run ${audit.runId} is still live`))
        }
        return found
      })
      : undefined
    // Recovery of an interrupted rewind is the same administrative surgery
    // as the rewind itself: its fencing must not append into the journal
    // whose post-frame emptiness `archiveCommitted` reads as evidence.
    yield* Lease.unjournaled(Lease.claimAndActivate(runs, {
      runId: audit.runId,
      expected: RunRow.snapshotOf(row),
      claimant: options.owner,
      nowMs,
      evidence,
      operations: {
        claim: running ? "steal recovery run" : "claim recovery run",
        activate: "activate recovery run"
      },
      refused: () => error("busy", `run ${audit.runId} could not be claimed for recovery`),
      lost: error("busy", `run ${audit.runId} lost its recovery claim`)
    }))
    return row
  })

const archiveCommitted = (
  journal: Journal.Service,
  store: TimeTravelStore["Service"],
  audit: Audit,
  detail: AuditDetail
): Effect.Effect<boolean, TimeTravelFailure> => {
  if (detail.phase === "archive_committed" || detail.phase === "completed") {
    return Effect.succeed(true)
  }
  if (detail.suffixCount === 0) return Effect.succeed(false)
  return journal.entries({
    runId: audit.runId as JournalEvent.RunId,
    after: audit.frame.seq as JournalEvent.Seq,
    limit: 1
  }).pipe(
    Effect.mapError((cause) => error("unknown", `could not inspect archive commit for ${audit.id}`, cause)),
    Effect.flatMap((page) => {
      if (page.entries.length > 0) return Effect.succeed(false)
      // An empty live suffix alone is not commit evidence: the suffix the
      // audit recorded must actually be IN the archive. A journal missing
      // rows on both sides is corruption, and recovery rolls it back rather
      // than declaring an archive that never happened complete.
      return detail.suffixTailSeq === undefined
        ? Effect.succeed(false)
        : store.archivedAt(audit.runId, detail.suffixTailSeq)
    })
  )
}

// The durable child nonce identifies claims made by rewind or an earlier
// recovery pass, even after recovery has replaced/released the parent owner.
const protocolChildOwner = (owner: OwnerId | null, childRunId: string): boolean =>
  owner !== null && (
    owner.nonce.endsWith(`:rewind-child:${childRunId}`) ||
    owner.nonce.endsWith(`:recovery-child:${childRunId}`)
  )

const childEvidence = (
  audit: Audit,
  row: RunStore.RunRow,
  owner: OwnerId,
  nowMs: number,
  options: Options
): Effect.Effect<LivenessEvidence, TimeTravelFailure> =>
  Effect.gen(function*() {
    const evidence = yield* options.livenessEvidence(audit, row, owner, nowMs)
    if (evidence === undefined) {
      return yield* Effect.fail(error("busy", `child ${row.runId} is still owned`))
    }
    return evidence
  })

/**
 * Resolves children an interrupted rewind had already planned to cancel.
 * Before commit, release only protocol claims and park activated children.
 * After commit, reclaim expired protocol owners and finish cancellation.
 *
 * The plan is durable on the audit detail before the archive commit, so this is
 * a resumption rather than a new decision: a child already terminal is skipped,
 * and one that cannot be claimed leaves the audit open with the remainder still
 * pending, so a later pass retries it. Idempotent by construction, because
 * `pendingChildren` clears only once every child is resolved.
 */
const resolvePending = (
  runs: RunStore.Service,
  audit: Audit,
  detail: AuditDetail,
  options: Options,
  committed: boolean
): Effect.Effect<AuditDetail, TimeTravelFailure> =>
  Effect.gen(function*() {
    const pending = detail.pendingChildren ?? []
    if (pending.length === 0) return detail
    const cancelled = [...detail.cancelledChildren]
    for (const childRunId of pending) {
      const row = yield* runs.get(childRunId).pipe(
        Effect.map((value): RunStore.RunRow | undefined => value),
        Effect.catch((cause) =>
          cause.code === "not_found_row"
            ? Effect.succeed(undefined)
            : Effect.fail(RunRow.failure(`read pending child ${childRunId}`, cause))
        )
      )
      if (row === undefined || RunStore.isTerminalRunStatus(row.status)) continue
      if (!committed && !protocolChildOwner(row.owner, childRunId) && !protocolChildOwner(row.claim, childRunId)) {
        continue
      }
      const childOwner: OwnerId = {
        ...options.owner,
        nonce: `${options.owner.nonce}:recovery-child:${childRunId}`
      }
      if (row.claim !== null) {
        if (!protocolChildOwner(row.claim, childRunId) || row.claimedAtMs === null) {
          return yield* Effect.fail(error("busy", `child ${childRunId} has an active claim`))
        }
        const nowMs = yield* Clock.currentTimeMillis
        // An unactivated claim has its own identity and timestamp, independent
        // of the run's original owner. Probe that lease and clear its exact CAS.
        const evidence = yield* childEvidence(
          audit,
          { ...row, owner: row.claim, heartbeatAtMs: row.claimedAtMs },
          childOwner,
          nowMs,
          options
        )
        const recovered = yield* runs.recoverClaim(
          childRunId,
          row.claim,
          row.claimedAtMs,
          childOwner,
          nowMs,
          evidence
        ).pipe(Effect.mapError((cause) => RunRow.failure(`recover pending child claim ${childRunId}`, cause)))
        if (recovered._tag !== "Recovered") {
          return yield* Effect.fail(error("busy", `child ${childRunId} could not release its stale claim`))
        }
      }
      // Before commit only release ownership this protocol acquired. A child
      // not yet activated keeps its original status and owner after claim CAS.
      if (!committed && !protocolChildOwner(row.owner, childRunId)) continue
      const nowMs = yield* Clock.currentTimeMillis
      const running = row.status === "running"
      const evidence = running
        ? yield* Effect.gen(function*() {
          if (!protocolChildOwner(row.owner, childRunId)) {
            return yield* Effect.fail(error("busy", `child ${childRunId} is owned outside rewind recovery`))
          }
          return yield* childEvidence(audit, row, childOwner, nowMs, options)
        })
        : undefined
      // The audit keeps the whole remaining plan: nothing is written on a
      // `busy` refusal, so the next pass sees the same list and retries it.
      yield* Lease.claimAndActivate(runs, {
        runId: childRunId,
        expected: RunRow.snapshotOf(row),
        claimant: childOwner,
        nowMs,
        evidence,
        operations: {
          claim: `${running ? "steal" : "claim"} pending child ${childRunId}`,
          activate: `activate pending child ${childRunId}`
        },
        refused: () => error("busy", `child ${childRunId} could not be claimed for cancellation`),
        lost: error("busy", `child ${childRunId} lost its cancellation claim`)
      })
      const done = yield* runs.transitionOwned(childRunId, childOwner, committed ? "cancelled" : "suspended").pipe(
        Effect.mapError((cause) => RunRow.failure(`cancel pending child ${childRunId}`, cause))
      )
      if (done._tag !== "Transitioned") {
        return yield* Effect.fail(error("busy", `child ${childRunId} lost its cancellation fence`))
      }
      if (committed) cancelled.push(childRunId)
    }
    // Reaching here means every planned child is resolved: cancelled, already
    // terminal, gone, or released before commit. An unresolved child failed above
    // and left the audit open with its plan intact.
    return { ...detail, cancelledChildren: cancelled, pendingChildren: [] }
  })

const terminalFailure = (
  store: TimeTravelStore["Service"],
  audit: Audit,
  detail: AuditDetail | undefined,
  failure: TimeTravelFailure
): Effect.Effect<Outcome, never> =>
  store.updateAudit(audit.id, {
    status: "failed",
    detail: detail === undefined
      ? {
        version: 1,
        phase: "terminal_failure",
        failure: failure.message
      }
      : {
        ...detail,
        phase: "terminal_failure",
        failure: failure.message
      }
  }).pipe(
    Effect.ignore,
    Effect.as({ _tag: "Failed" as const, auditId: audit.id, error: failure })
  )

const recoverOne = (
  audit: Audit,
  options: Options
): Effect.Effect<
  Outcome,
  never,
  EffectHandlerRegistry | Jj | Journal.Journal | RunStore.RunStore | TimeTravelStore
> =>
  Effect.gen(function*() {
    const store = yield* TimeTravelStore
    const runs = yield* RunStore.RunStore
    const journal = yield* Journal.Journal
    const decodedDetail = isAuditDetail(audit.detail) ? audit.detail : undefined
    if (decodedDetail === undefined) {
      return yield* terminalFailure(
        store,
        audit,
        undefined,
        error("unknown", `audit ${audit.id} has no recoverable protocol detail`)
      )
    }
    let detail: AuditDetail = decodedDetail

    /**
     * OWNERSHIP IS TAKEN, HELD, AND GIVEN BACK.
     *
     * `acquire` used to hand back an unclaimed suspended row and let the
     * rollback run unfenced, so a concurrent engine could claim the run and
     * start executing it while recovery restored the workspace underneath.
     * It now claims every row it acts on. That makes the release the other half
     * of the contract: a failure after the claim used to leave the run
     * `running` under the recovery identity with a heartbeat nobody renews, so
     * the ownership is restored on every exit path, and a heartbeat pulses for
     * as long as the pass holds it.
     */
    let acquired: RunStore.RunRow | undefined
    let releaseProblem: string | undefined
    const release = (status: RunStore.RunStatus) =>
      Effect.suspend(() =>
        acquired === undefined
          ? Effect.void
          : Effect.exit(Lease.unjournaled(runs.transitionOwned(
            audit.runId,
            options.owner,
            // Pending cannot be restored directly; suspended releases ownership.
            status === "pending" ? "suspended" : status,
            acquired.stateJson
          ))).pipe(
            Effect.flatMap((released) =>
              Effect.sync(() => {
                if (Exit.isFailure(released)) {
                  releaseProblem = fromCause(released.cause).message
                } else if (released.value._tag !== "Transitioned") {
                  releaseProblem = `ownership release returned ${released.value._tag}`
                }
              })
            )
          )
      )
    const recoveryExit = yield* Effect.exit(
      Effect.uninterruptible(
        Effect.gen(function*() {
          const acquiredRow = yield* acquire(runs, audit, options)
          acquired = acquiredRow
          // The release below is itself an owned transition, so it runs inside
          // the held lease, before the heartbeat stops.
          return yield* Lease.withHeldLease(audit.runId, options.owner, (lease) =>
            lease.guard(Effect.gen(function*() {
              const committed = yield* archiveCommitted(journal, store, audit, detail)
              if (committed) {
                // The cancellations the rewind planned before its commit are
                // finished here. Closing the audit without draining them dropped
                // exactly the work `detachedChildren: "cancel"` was asked for.
                const drained = yield* resolvePending(runs, audit, detail, options, true)
                // The live run row still carries the post-frame state the rewind
                // truncated. Derive the state at the surviving frame just as the
                // normal rewind path does; a history without a decision payload
                // falls back to the row recovery acquired.
                const frameState = yield* store.stateAt(audit.runId, audit.frame)
                yield* lease.releasing
                const suspended = yield* Lease.unjournaled(runs.transitionOwned(
                  audit.runId,
                  options.owner,
                  "suspended",
                  frameState ?? acquiredRow.stateJson
                )).pipe(
                  Effect.mapError((cause) => RunRow.failure("finish recovered suspension", cause))
                )
                if (suspended._tag !== "Transitioned") {
                  return yield* Effect.fail(
                    error("busy", `run ${audit.runId} lost its recovery fence`)
                  )
                }
                yield* store.updateAudit(audit.id, {
                  status: "completed",
                  detail: { ...drained, phase: "completed" }
                })
                return { _tag: "Completed" as const, auditId: audit.id }
              }

              if (detail.compensation !== undefined) {
                const compensated = detail.compensation
                const { compensation: _, ...stripped } = detail
                // A successful rollback is a non-idempotent fact. Persist it
                // before the ownership restoration can fail, so another recovery
                // pass never repeats those handler rollbacks. The guard
                // interrupts this body when the fence is lost, so the rollback
                // and its record are one uninterruptible unit.
                yield* Effect.uninterruptible(
                  Compensation.rollback(compensated, options.compensationTimeout).pipe(
                    Effect.andThen(Effect.sync(() => (detail = stripped))),
                    Effect.andThen(store.updateAudit(audit.id, { detail: stripped }))
                  )
                )
              }
              detail = yield* resolvePending(runs, audit, detail, options, false)
              yield* lease.releasing
              const restored = yield* Lease.unjournaled(runs.transitionOwned(
                audit.runId,
                options.owner,
                detail.originalStatus === "pending" ? "suspended" : detail.originalStatus,
                acquiredRow.stateJson
              )).pipe(
                Effect.mapError((cause) => RunRow.failure("restore recovered run", cause))
              )
              if (restored._tag !== "Transitioned") {
                return yield* Effect.fail(
                  error("busy", `run ${audit.runId} lost its rollback fence`)
                )
              }
              acquired = undefined
              yield* store.updateAudit(audit.id, {
                status: "failed",
                detail: {
                  ...detail,
                  phase: "rolled_back",
                  failure: "startup recovery rolled back an uncommitted rewind"
                }
              })
              return { _tag: "RolledBack" as const, auditId: audit.id }
            })).pipe(
              Effect.tap(() => Effect.sync(() => (acquired = undefined))),
              Effect.onError(() => release(detail.originalStatus))
            ))
        })
      )
    )
    if (Exit.isSuccess(recoveryExit)) return recoveryExit.value
    const failure = fromCause(recoveryExit.cause)
    if (releaseProblem !== undefined) {
      return {
        _tag: "Busy" as const,
        auditId: audit.id,
        error: error(
          failure.code,
          `${failure.message}; could not give ownership back: ${releaseProblem}`,
          { recovery: recoveryExit.cause, release: releaseProblem }
        )
      }
    }
    // A `busy` refusal says only that someone else holds the run right now:
    // an active claim, a live owner, a fence taken while this pass ran.
    // Recording it as `failed` removed the audit from `pendingAudits`
    // permanently, so a rewind interrupted after its compensation but before
    // its archive commit could never be rolled back by any later pass, and
    // the engine's stale-heartbeat steal would resume the run against a
    // workspace this rewind had already rewound.
    //
    // Nothing is written on this path on purpose. The audit's detail is the
    // live rewind's own bookkeeping; a recovery pass that stamped a message
    // on it would clobber the phase the owner is still advancing.
    if (failure.code === "busy") {
      return { _tag: "Busy" as const, auditId: audit.id, error: failure }
    }
    return yield* terminalFailure(store, audit, detail, failure)
  })

/**
 * Scans and resolves every pending rewind audit independently.
 *
 * A committed archive finishes the suspended transition. An uncommitted
 * rewind restores its jj snapshot and handler receipts. Per-audit failures are
 * returned as typed terminal outcomes and recorded on the same audit row;
 * recovery never invents a run status.
 *
 * An audit whose run another process still holds is reported `Busy` and left
 * untouched, so it is picked up by the next pass rather than closed on the
 * strength of a race. {@link Options.livenessEvidence} is what turns "held by
 * a process that died" back into progress; with none supplied, a run that is
 * still `running` under a foreign owner is always refused.
 *
 * @since 0.1.0
 * @category constructors
 */
export const recover = (
  options: Options
): Effect.Effect<
  ReadonlyArray<Outcome>,
  TimeTravelFailure,
  EffectHandlerRegistry | Jj | Journal.Journal | RunStore.RunStore | TimeTravelStore
> =>
  Effect.fn("Recovery.recover")(() =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({ ownerHostId: options.owner.hostId })
      const store = yield* TimeTravelStore
      const audits = yield* store.pendingAudits()
      return yield* Effect.forEach(audits, (audit) => recoverOne(audit, options), {
        concurrency: 1
      })
    })
  )()
