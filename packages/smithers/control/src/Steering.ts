/**
 * The steer lifecycle as the control plane reads it back.
 *
 * A steer has two durable moments and two different writers. The control plane
 * records the first — `control.steer.enqueued`, written beside the admission
 * it caused. The second belongs to `@smthrs/notifications`: a turn boundary
 * promotes the notification and the queue journals the promotion. This module
 * projects that promotion into the control vocabulary, so a watcher folds one
 * stream instead of two, and so nothing writes "delivered" twice.
 *
 * Deriving rather than re-recording is what keeps the two halves honest. A
 * control plane that emitted its own delivery record would be asserting a fact
 * it did not observe: the boundary that delivered the steer runs in the agent
 * process, not this one.
 *
 * @since 0.1.0
 */

import type { ControlEvent } from "./ControlSchema.ts"

/**
 * The journal event type the notification queue records a promotion under.
 *
 * Named as a string rather than imported so this projection reads a journal
 * written by any queue implementation, exactly as `Lineage` reads engine
 * decisions.
 *
 * @category constants
 * @since 0.1.0
 */
export const promotedEventType = "flows/notifications/Promoted"

/**
 * The kind `watch` reports one delivered steer under.
 *
 * @category constants
 * @since 0.1.0
 */
export const deliveredEventType = "control.steer.delivered"

/**
 * The kind `Control.steer` records an accepted steer under.
 *
 * @category constants
 * @since 0.1.0
 */
export const enqueuedEventType = "control.steer.enqueued"

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []

/**
 * Derives one delivery delta per message a promotion entry named.
 *
 * A boundary promotes a batch, so one entry can disclose several deliveries.
 * Each delta carries the source sequence and the boundary that took it.
 * `ControlLive.watch` adds an expansion cursor so a consumer can resume
 * between deliveries in the same batch.
 *
 * A promotion that named nothing derives nothing: an idle boundary drains an
 * empty queue on every turn, and reporting that as a delivery would bury the
 * real ones.
 *
 * @param event the projected journal entry
 * @category projections
 * @since 0.1.0
 */
export const derive = (event: ControlEvent): ReadonlyArray<ControlEvent> => {
  const runId = event.runId
  if (event.kind !== promotedEventType || runId === undefined) return []
  const payload = record(event.payload)
  if (payload === undefined) return []
  const boundary = typeof payload["boundary"] === "string" ? payload["boundary"] : undefined
  if (boundary === undefined) return []
  return strings(payload["ids"]).map((messageId): ControlEvent => ({
    sequence: event.sequence,
    kind: deliveredEventType,
    runId,
    occurredAt: event.occurredAt,
    payload: { runId, messageId, boundary }
  }))
}

/**
 * Expands one projected entry into itself plus any deliveries it discloses.
 *
 * @param event the projected journal entry
 * @category projections
 * @since 0.1.0
 */
export const expand = (event: ControlEvent): ReadonlyArray<ControlEvent> => [event, ...derive(event)]
