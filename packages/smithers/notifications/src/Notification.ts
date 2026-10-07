/**
 * Durable notification payloads and their admission classification.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"

/**
 * Producer-supplied attribution carried as data alongside the authenticated
 * source actor. These labels never authorize a notification or a model action.
 * They pass through the journal's ordinary redaction policy.
 *
 * @category models
 * @since 1.0.0
 */
export const Attribution = Schema.Record(Schema.String, Schema.String)

/**
 * Durable origin of a notification: who said it, from where, and at which
 * turn.
 *
 * Provenance travels with the notification because the run that receives one
 * is not the run that wrote it. An operator steer, a parent run's event, and a
 * webhook all arrive on the same queue, and only these fields say which is
 * which after the fact.
 *
 * @category models
 * @since 0.1.0
 */
export const Provenance = Schema.Struct({
  sourceRunId: Schema.String,
  sourceLineageId: Schema.String,
  sourceTurn: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  sourceActor: Schema.String,
  attribution: Schema.optional(Attribution)
})

/**
 * The decoded form of {@link Provenance}.
 *
 * @category models
 * @since 0.1.0
 */
export type Provenance = typeof Provenance.Type

const common = {
  id: Schema.NonEmptyString,
  targetLineageId: Schema.NonEmptyString,
  provenance: Provenance,
  payload: Schema.Json
}

/**
 * A human message that must reach the model before the current turn closes.
 *
 * `id` is the caller's idempotency key: admitting it twice with the same
 * content is one notification, and admitting it with different content is a
 * producer bug the queue refuses. New admissions fingerprint the validated
 * content before journal redaction, so redaction does not change retry identity.
 *
 * @category models
 * @since 0.1.0
 */
export const HumanSteer = Schema.TaggedStruct("human-steer", {
  ...common,
  delivery: Schema.Literal("steer")
})

/**
 * The decoded form of {@link HumanSteer}.
 *
 * @category models
 * @since 0.1.0
 */
export type HumanSteer = typeof HumanSteer.Type

/**
 * A human message that waits for the run to become idle.
 *
 * The delivery class is the whole difference from {@link HumanSteer}: a
 * follow-up is not urgent enough to interrupt the turn in flight, so it is
 * promoted one at a time when the run would otherwise have nothing to do.
 *
 * @category models
 * @since 0.1.0
 */
export const HumanFollowup = Schema.TaggedStruct("human-followup", {
  ...common,
  delivery: Schema.Literal("queue")
})

/**
 * The decoded form of {@link HumanFollowup}.
 *
 * @category models
 * @since 0.1.0
 */
export type HumanFollowup = typeof HumanFollowup.Type

/**
 * A machine-originated event. Events sharing a coalescing key and a target
 * lineage collapse to the most recent one while pending.
 *
 * Coalescing is what keeps a chatty producer from filling the queue: ten
 * updates about one condition are one pending notification carrying the latest
 * of them. The key is scoped to `targetLineageId`, so two branches reporting
 * one condition under the same ordinary key each keep their own event. An
 * event with no key never coalesces.
 *
 * @category models
 * @since 0.1.0
 */
export const SystemEvent = Schema.TaggedStruct("system-event", {
  ...common,
  delivery: Schema.Literal("queue"),
  coalescingKey: Schema.optional(Schema.String)
})

/**
 * The decoded form of {@link SystemEvent}.
 *
 * @category models
 * @since 0.1.0
 */
export type SystemEvent = typeof SystemEvent.Type

/**
 * Any durable notification retained by the pending queue.
 *
 * `NotificationQueue.admit` decodes its argument against this union before it
 * journals anything, so a value that does not match it is refused rather than
 * acknowledged and then skipped by every replay. Journal-backed queues deeply
 * freeze decoded notifications, including payloads, before returning them from
 * `pending` or `drain`.
 *
 * @category models
 * @since 0.1.0
 */
export const Notification = Schema.Union([HumanSteer, HumanFollowup, SystemEvent])

/**
 * Any durable notification retained by the pending queue.
 *
 * @category models
 * @since 0.1.0
 */
export type Notification = typeof Notification.Type

/**
 * How a notification is allowed to reach the model.
 *
 * `steer` notifications are promoted in a batch at turn close; `queue`
 * notifications are promoted one at a time when the run would otherwise idle.
 *
 * @param notification the notification to classify
 * @category getters
 * @since 0.1.0
 */
export const admissionClass = (notification: Notification): "steer" | "queue" => notification.delivery

/**
 * The key a pending notification coalesces on, or `null` when it must never
 * be coalesced. Only system events coalesce, and only when they declare a key.
 *
 * @param notification the notification to key
 * @category getters
 * @since 0.1.0
 */
export const coalesceKey = (notification: Notification): string | null =>
  notification._tag === "system-event" ? notification.coalescingKey ?? null : null
