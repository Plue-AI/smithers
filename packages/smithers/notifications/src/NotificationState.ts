/**
 * Pure pending-notification queue state.
 *
 * @since 0.1.0
 */

import type { Notification } from "./Notification.ts"
import { admissionClass, coalesceKey } from "./Notification.ts"
import type * as NotificationEvent from "./NotificationEvent.ts"

/**
 * The default maximum number of pending notifications retained per run.
 *
 * The bound is what makes an undrained run a known quantity instead of a
 * function of how long it was ignored. Admitting past it decides
 * `rejected-full`, which retains nothing and writes no journal entry, so the
 * notification is admissible again once a boundary drains.
 * `NotificationQueue.layerWith` raises or lowers it for one composition.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultCapacity = 128

/**
 * A notification retained until it is promoted at a harness safe point.
 *
 * `seq` is the journal sequence the admission committed at, which is what a
 * turn-close cutoff compares against.
 *
 * @category models
 * @since 0.1.0
 */
export interface Pending {
  readonly notification: Notification
  readonly seq: number
}

/**
 * The result recorded for one durable notification admission.
 *
 * Re-exported from `NotificationEvent`, which owns the single declaration, so
 * the type these signatures use and the schema the journal validates against
 * can never drift apart.
 *
 * @category models
 * @since 0.1.0
 */
export type AdmissionDecision = NotificationEvent.AdmissionDecision

/**
 * Immutable bounded queue state derived from the notification journal.
 *
 * The value is immutable in its own structure: the state and the `Pending`
 * wrappers it holds are frozen, and every transition returns a new state
 * rather than editing this one. The notifications inside are not re-frozen
 * here, because `NotificationQueue.admit` already snapshots a notification at
 * the durability boundary, so no state built by the queue shares mutable
 * structure with a caller.
 *
 * @category models
 * @since 0.1.0
 */
export interface State {
  readonly capacity: number
  readonly items: ReadonlyArray<Pending>
}

/**
 * One pure admission transition and its visible decision.
 *
 * @category models
 * @since 0.1.0
 */
export interface Admission {
  readonly state: State
  readonly decision: AdmissionDecision
}

/**
 * A pure promotion transition: what a boundary takes, and what is left.
 *
 * @category models
 * @since 0.1.0
 */
export interface Promotion {
  readonly state: State
  readonly promoted: ReadonlyArray<Pending>
}

const immutable = (capacity: number, items: ReadonlyArray<Pending>): State =>
  Object.freeze({
    capacity,
    items: Object.freeze(items.map((item) => Object.freeze({ ...item })))
  })

const normalizedCapacity = (capacity: number): number =>
  Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0

const immutablePromotion = (state: State, promoted: ReadonlyArray<Pending>): Promotion =>
  Object.freeze({
    state,
    promoted: Object.freeze(promoted.map((item) => Object.freeze({ ...item })))
  })

/**
 * Creates an empty bounded notification queue.
 *
 * A capacity that is not a finite number becomes zero, so a misconfigured
 * bound refuses everything loudly rather than retaining an unbounded backlog.
 *
 * @param capacity the maximum number of pending notifications
 * @category constructors
 * @since 0.1.0
 */
export const empty = (capacity: number): State => immutable(normalizedCapacity(capacity), [])

/**
 * The pending item a notification coalesces into, or `-1` when it coalesces
 * with nothing.
 *
 * A coalescing key is scoped to one lineage. `targetLineageId` is the reader's
 * address, so two branches reporting the same condition under one ordinary key
 * are two pending notifications, and neither erases the other's.
 */
const coalesceIndex = (state: State, notification: Notification): number => {
  const key = coalesceKey(notification)
  if (key === null) return -1
  return state.items.findIndex((item) =>
    item.notification.targetLineageId === notification.targetLineageId &&
    coalesceKey(item.notification) === key
  )
}

/**
 * Admits a notification, coalescing only pending system events that share both
 * a key and a target lineage. Coalescing retains the first sequence so replay
 * order remains stable.
 *
 * A queue already at capacity decides `rejected-full` and retains nothing. The
 * caller owns what happens next: `NotificationQueue.admit` writes no journal
 * entry for that decision, so the same notification is admissible again once a
 * boundary drains.
 *
 * @param state the current queue state
 * @param notification the notification to admit
 * @param seq the journal sequence the admission is recorded at
 * @category operations
 * @since 0.1.0
 */
export const admit = (state: State, notification: Notification, seq: number): Admission => {
  const coalesced = coalesceIndex(state, notification)
  if (coalesced !== -1) {
    const existing = state.items[coalesced]!
    const items = [...state.items]
    items[coalesced] = { notification, seq: existing.seq }
    return Object.freeze({ state: immutable(state.capacity, items), decision: "coalesced" })
  }

  if (state.items.length >= state.capacity) {
    return Object.freeze({ state, decision: "rejected-full" })
  }

  return Object.freeze({
    state: immutable(state.capacity, [...state.items, { notification, seq }]),
    decision: "admitted"
  })
}

/**
 * Applies the decision already committed in an admission journal event.
 *
 * Replay never re-decides: the committed decision is the one that happened,
 * whatever this process's state would have chosen. The `rejected-full` branch
 * stays reachable for a record written by any other writer, even though this
 * package never writes one.
 *
 * @param state the state so far
 * @param notification the notification the record admitted
 * @param seq the journal sequence the record committed at
 * @param decision the decision the record carries
 * @category operations
 * @since 0.1.0
 */
export const applyAdmission = (
  state: State,
  notification: Notification,
  seq: number,
  decision: AdmissionDecision
): State => {
  if (decision === "rejected-full") return state
  if (decision === "admitted") {
    return immutable(state.capacity, [...state.items, { notification, seq }])
  }
  const index = coalesceIndex(state, notification)
  // A record whose lineage holds nothing under the key is retained rather than
  // dropped, which is also what keeps a decision recorded before coalescing
  // was lineage-scoped replayable: it applies to the item it named, or to none.
  if (index === -1) return immutable(state.capacity, [...state.items, { notification, seq }])
  const items = [...state.items]
  items[index] = { notification, seq: items[index]!.seq }
  return immutable(state.capacity, items)
}

/**
 * Returns still-pending notifications in their durable journal order.
 *
 * @param state the current queue state
 * @param admission which admission class to report
 * @param targetLineageId the lineage to report for, or every lineage when absent
 * @category getters
 * @since 0.1.0
 */
export const pending = (
  state: State,
  admission: "steer" | "queue",
  targetLineageId?: string
): ReadonlyArray<Pending> =>
  Object.freeze(
    state.items.filter((item) =>
      admissionClass(item.notification) === admission &&
      (targetLineageId === undefined || item.notification.targetLineageId === targetLineageId)
    )
  )

/**
 * Promotes every steer notification admitted at or before the turn-close
 * cutoff. Notifications admitted after the cutoff remain pending.
 *
 * The cutoff is what holds a steer that arrived mid-turn until the next
 * boundary, and `NotificationQueue.DrainInput.cutoffSeq` is how a caller sets
 * it. A drain that names no cutoff delivers everything pending for the lineage.
 *
 * @param state the current queue state
 * @param cutoffSeq the highest admission sequence this boundary may deliver
 * @param targetLineageId the lineage the boundary belongs to, or every lineage when absent
 * @category operations
 * @since 0.1.0
 */
export const promoteSteers = (state: State, cutoffSeq: number, targetLineageId?: string): Promotion => {
  const promoted: Array<Pending> = []
  const remaining: Array<Pending> = []
  for (const item of state.items) {
    if (
      admissionClass(item.notification) === "steer" &&
      item.seq <= cutoffSeq &&
      (targetLineageId === undefined || item.notification.targetLineageId === targetLineageId)
    ) {
      promoted.push(item)
    } else {
      remaining.push(item)
    }
  }
  return immutablePromotion(immutable(state.capacity, remaining), promoted)
}

/**
 * Promotes exactly the oldest pending queue notification.
 *
 * @param state the current queue state
 * @param targetLineageId the lineage the boundary belongs to, or every lineage when absent
 * @category operations
 * @since 0.1.0
 */
export const promoteQueued = (state: State, targetLineageId?: string): Promotion => {
  const index = state.items.findIndex((item) =>
    admissionClass(item.notification) === "queue" &&
    (targetLineageId === undefined || item.notification.targetLineageId === targetLineageId)
  )
  if (index === -1) return immutablePromotion(state, [])
  const promoted = state.items[index]!
  return immutablePromotion(
    immutable(state.capacity, [...state.items.slice(0, index), ...state.items.slice(index + 1)]),
    [promoted]
  )
}

/**
 * Applies a durable promotion record while replaying journal history.
 *
 * @param state the state so far
 * @param ids the notification ids the record promoted
 * @category operations
 * @since 0.1.0
 */
export const applyPromoted = (state: State, ids: ReadonlyArray<string>): State => {
  if (ids.length === 0) return state
  const promoted = new Set(ids)
  return immutable(state.capacity, state.items.filter((item) => !promoted.has(item.notification.id)))
}
