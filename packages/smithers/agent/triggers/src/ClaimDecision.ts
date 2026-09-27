/**
 * The one claim decision both trigger stores apply.
 *
 * A claim is a pure function of the rows it reads: the trigger declaration,
 * the fire row at the occurrence being claimed, and the fire row the active
 * reservation holds. Each store gathers that snapshot in its own storage,
 * calls {@link decide}, and applies the writes it answers. Writing the fences,
 * the expired-reservation reclaim, and the supersede predecessor substitution
 * once is what keeps `SqlTriggerStore` and the published in-memory store from
 * drifting apart.
 *
 * @since 1.0.0-rc.0
 */

import * as Overlap from "./Overlap.ts"
import type { Overlap as Policy } from "./Trigger.ts"
import { TriggerError } from "./TriggerError.ts"
import {
  type Claim,
  type ClaimFire,
  isReservation,
  type Outcome,
  reservationLeaseMs,
  reservationOccurrence
} from "./TriggerStore.ts"

/**
 * A fire row as the decision reads it. `outcome` is `null` for a claimed but
 * unsettled occurrence, matching the nullable column.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Fire {
  readonly outcome: Outcome | null
  readonly runId?: string | undefined
}

/**
 * Everything the decision reads, gathered by the store before it runs.
 *
 * `existingFire` is absent when this claim is what created the row.
 * `activeFire` is the row at `reservationOccurrence(activeRunId)`, read after
 * that insert, and is needed only while `activeRunId` is a reservation.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Snapshot {
  readonly revision: number
  readonly enabled: boolean
  readonly overlap: Policy
  readonly activeRunId?: string | undefined
  readonly activeClaimedAt?: number | undefined
  readonly pending?: number | undefined
  readonly existingFire?: Fire | undefined
  readonly activeFire?: Fire | undefined
}

/**
 * One durable edit a claim owes, in the order the store must apply them.
 *
 * `SetOutcome` with `whileOpen` may only settle a fire that is still `null` or
 * `buffered`; the SQL store spells that as a `WHERE` clause.
 * `ReleaseReservation` may only land while `expected` still owns the trigger.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Write =
  | {
    readonly _tag: "SetOutcome"
    readonly occurrence: number
    readonly outcome: Outcome
    readonly whileOpen: boolean
  }
  | { readonly _tag: "SetRunId"; readonly occurrence: number; readonly runId: string }
  | {
    readonly _tag: "ReleaseReservation"
    readonly expected: string
    readonly activeRunId?: string | undefined
    readonly pending?: number | undefined
  }
  | { readonly _tag: "AdvanceCursor"; readonly occurrence: number }
  | { readonly _tag: "SetPending"; readonly occurrence: number }
  | { readonly _tag: "Reserve"; readonly reservationId: string; readonly claimedAt: number }

/**
 * What a claim decided: a refusal the store fails with, or a claim outcome and
 * the writes that make it durable. An unclaimed occurrence answers
 * `{ claimed: false }` with no writes.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Decision =
  | { readonly _tag: "Refused"; readonly error: TriggerError }
  | { readonly _tag: "Decided"; readonly claim: Claim; readonly writes: ReadonlyArray<Write> }

/**
 * The claim request, the rows it reads, the reservation id the store minted
 * for it, and the store clock reading it was claimed at.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Input {
  readonly fire: ClaimFire
  readonly snapshot: Snapshot
  readonly reservationId: string
  readonly claimedAt: number
}

type AdmittedDecision = Extract<Decision, { readonly _tag: "Decided" }>

const decided = (claim: Claim, writes: ReadonlyArray<Write>): AdmittedDecision => ({ _tag: "Decided", claim, writes })

/**
 * What a reader finds behind a trigger's active owner: nothing, a live owner,
 * or an expired reservation to release.
 *
 * `expected` is the reservation the release must still find in place.
 * `recovered` is the launched predecessor the release hands back, and
 * `pending` is the occurrence it re-arms; both are absent when the reservation
 * covered no unsettled fire.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Lease =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Held"; readonly runId: string }
  | {
    readonly _tag: "Expired"
    readonly expected: string
    readonly recovered?: string | undefined
    readonly pending?: number | undefined
  }

/**
 * Applies the reservation lease to a trigger's active owner.
 *
 * `unfinished` is the fire row at `reservationOccurrence(activeRunId)` while
 * that row is still `null` or `buffered`, and is absent otherwise. A process
 * that died after claiming an occurrence but before launching it left the
 * reservation; the expired lease releases it and re-arms both ordinary and
 * buffered work.
 *
 * @category decision
 * @since 1.0.0-rc.0
 */
export const lease = (input: {
  readonly activeRunId?: string | undefined
  readonly activeClaimedAt?: number | undefined
  readonly pending?: number | undefined
  readonly now: number
  readonly unfinished?: Fire | undefined
}): Lease => {
  const { activeClaimedAt, activeRunId, now, pending, unfinished } = input
  if (activeRunId === undefined) return { _tag: "Idle" }
  if (!isReservation(activeRunId) || (activeClaimedAt !== undefined && activeClaimedAt > now - reservationLeaseMs)) {
    return { _tag: "Held", runId: activeRunId }
  }
  const occurrence = reservationOccurrence(activeRunId)
  if (occurrence === undefined || unfinished === undefined) return { _tag: "Expired", expected: activeRunId }
  const predecessor = unfinished.runId
  return {
    _tag: "Expired",
    expected: activeRunId,
    pending: Overlap.pendingAfter({ running: false, pending, due: occurrence }),
    ...(predecessor !== undefined && !isReservation(predecessor) ? { recovered: predecessor } : {})
  }
}

/**
 * The refusals a claim owes before it reads any fire row, in the order the
 * stores apply them. A store checks these first so a refused claim leaves the
 * ledger untouched; {@link decide} re-applies them so a store that only calls
 * it is still fenced.
 *
 * @category decision
 * @since 1.0.0-rc.0
 */
export const refuse = (
  snapshot: Pick<Snapshot, "enabled" | "revision">,
  fire: ClaimFire
): TriggerError | undefined => {
  if (snapshot.revision !== fire.expectedRevision) {
    return new TriggerError({
      code: "revision_mismatch",
      message: `trigger ${fire.triggerId} is at revision ${snapshot.revision}, not the claimed ${fire.expectedRevision}`
    })
  }
  if (!snapshot.enabled) {
    return new TriggerError({ code: "trigger_disabled", message: `trigger ${fire.triggerId} is disabled` })
  }
  return undefined
}

/**
 * Applies the claim protocol to a snapshot.
 *
 * @category decision
 * @since 1.0.0-rc.0
 */
export const decide = (input: Input): Decision => {
  const refusal = refuse(input.snapshot, input.fire)
  return refusal === undefined ? decideFenced(input) : { _tag: "Refused", error: refusal }
}

/**
 * Decides over a snapshot already admitted by {@link refuse} in the same
 * transaction. This avoids checking the same immutable revision twice.
 * @category decision
 * @since 1.0.0-rc.0
 * @private
 */
export const decideFenced = ({ claimedAt, fire, reservationId, snapshot }: Input): AdmittedDecision => {
  let activeRunId = snapshot.activeRunId
  let pending = snapshot.pending
  // A reservation with no claim timestamp predates the lease column. Nothing
  // writes that shape now, so treating it as expired is the only way such a
  // row is ever reclaimed.
  const expiredReservation = activeRunId !== undefined && isReservation(activeRunId) &&
      (snapshot.activeClaimedAt === undefined || snapshot.activeClaimedAt <= claimedAt - reservationLeaseMs)
    ? activeRunId
    : undefined
  const existing = snapshot.existingFire
  if (existing !== undefined) {
    const resumableBuffer = fire.resumeBuffered === true && existing.outcome === "buffered"
    const resumableReservation = existing.outcome === null &&
      (activeRunId === undefined ||
        (reservationOccurrence(activeRunId) === fire.occurrence && expiredReservation !== undefined))
    const resumableSupersede = fire.resumeBuffered === true && existing.outcome === null &&
      snapshot.overlap === "supersede" && activeRunId !== undefined && existing.runId === activeRunId
    if (!resumableBuffer && !resumableReservation && !resumableSupersede) return decided({ claimed: false }, [])
  }
  const writes: Array<Write> = []
  if (expiredReservation !== undefined) {
    const expiredOccurrence = reservationOccurrence(expiredReservation)
    const expiredFire = expiredOccurrence === undefined ? undefined : snapshot.activeFire
    if (
      expiredOccurrence !== undefined && expiredFire !== undefined &&
      (expiredFire.outcome === null || expiredFire.outcome === "buffered")
    ) {
      if (snapshot.overlap === "supersede") {
        const predecessor = expiredFire.runId
        activeRunId = predecessor !== undefined && !isReservation(predecessor) ? predecessor : undefined
        if (expiredOccurrence !== fire.occurrence) {
          writes.push({ _tag: "SetOutcome", occurrence: expiredOccurrence, outcome: "superseded", whileOpen: false })
        }
      } else {
        activeRunId = undefined
        if (expiredOccurrence !== fire.occurrence) {
          pending = Overlap.pendingAfter({ running: false, pending, due: expiredOccurrence })
        }
      }
    } else {
      activeRunId = undefined
    }
    writes.push({ _tag: "ReleaseReservation", expected: expiredReservation, activeRunId, pending })
  }
  const state: Overlap.State = { running: activeRunId !== undefined, pending, due: fire.occurrence }
  const action = Overlap.decide(snapshot.overlap, state)
  // A skip or buffer is complete inside the claim transaction. A fire or
  // supersede is only reserved here; its cursor advances when `recordResult`
  // makes the launched run durable.
  if (action === "skip" || action === "buffer") {
    writes.push({
      _tag: "SetOutcome",
      occurrence: fire.occurrence,
      outcome: action === "skip" ? "skipped" : "buffered",
      whileOpen: false
    })
    writes.push({ _tag: "AdvanceCursor", occurrence: fire.occurrence })
    if (action === "buffer") writes.push({ _tag: "SetPending", occurrence: Overlap.pendingAfter(state) })
    return decided({ claimed: true, action }, writes)
  }
  let supersededRunId = activeRunId
  if (action === "supersede" && activeRunId !== undefined) {
    if (isReservation(activeRunId)) {
      const activeOccurrence = reservationOccurrence(activeRunId)
      if (activeOccurrence !== undefined) {
        const predecessor = snapshot.activeFire?.runId
        if (predecessor !== undefined && !isReservation(predecessor)) supersededRunId = predecessor
        writes.push({ _tag: "SetOutcome", occurrence: activeOccurrence, outcome: "superseded", whileOpen: true })
      }
    }
    if (supersededRunId !== undefined && !isReservation(supersededRunId)) {
      writes.push({ _tag: "SetRunId", occurrence: fire.occurrence, runId: supersededRunId })
    }
  }
  writes.push({ _tag: "Reserve", reservationId, claimedAt })
  return decided(
    {
      claimed: true,
      action,
      reservationId,
      ...(supersededRunId === undefined ? {} : { activeRunId: supersededRunId })
    },
    writes
  )
}
