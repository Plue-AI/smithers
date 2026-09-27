/**
 * Shared engine node-record identity rules for the duration projection.
 *
 * A host copies every engine journal entry of a run into the control journal
 * as a `control.engine.event` envelope, so the node records both executors
 * write arrive here verbatim. The envelope's own fields are guarded the way
 * `callEvents.ts` guards them, and the record inside it is decoded with the
 * payload schemas `@smthrs/journal` publishes rather than with a second,
 * hand-written copy of the same contract.
 *
 * @since 1.0.0
 */

import { EngineEvent } from "@smthrs/journal"
import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/** A sparse historical observation is readable without inventing missing fields.
 * @category models
 * @since 1.0.0
 */
export interface NodeObservation {
  readonly kind?: string | undefined
  readonly payload?: unknown
}

/**
 * One node record, with the envelope coordinates that scope and stamp it.
 *
 * `executionId` is the native run the record belongs to, which is what keeps
 * two executions of one node id apart, and `emittedAtMs` is the native
 * timestamp the engine wrote, which is what a duration is measured between.
 *
 * @category models
 * @since 1.0.0
 */
export interface NodeRecord<Payload> {
  readonly executionId: string
  readonly emittedAtMs: number
  readonly payload: Payload
}

/**
 * The envelope of a versioned native record, or nothing.
 *
 * Only `version`, `executionId` and `emittedAtMs` are guarded, because those
 * are the fields a duration fold reads. The native `generation` and `sequence`
 * are not: the fold pairs a settlement with the last schedule of the same
 * execution and node, in the order the control journal committed them, so
 * neither one changes what it computes.
 */
const envelopeOf = (event: NodeObservation): Record<string, unknown> | undefined => {
  if (event.kind !== "control.engine.event" || typeof event.payload !== "object" || event.payload === null) {
    return undefined
  }
  const envelope = event.payload as Record<string, unknown>
  if (
    envelope.version !== 1 || typeof envelope.executionId !== "string" ||
    typeof envelope.emittedAtMs !== "number" || !Number.isFinite(envelope.emittedAtMs)
  ) return undefined
  return envelope
}

/** One record of the named type, decoded by the journal's own payload schema. */
const nodeRecord = <A>(
  event: NodeObservation,
  eventType: string,
  decode: (payload: unknown) => Option.Option<A>
): NodeRecord<A> | undefined => {
  const envelope = envelopeOf(event)
  if (envelope === undefined || envelope.eventType !== eventType) return undefined
  const payload = decode(envelope.payload)
  if (payload._tag === "None") return undefined
  return {
    executionId: envelope.executionId as string,
    emittedAtMs: envelope.emittedAtMs as number,
    payload: payload.value
  }
}

const decodeScheduled = Schema.decodeUnknownOption(EngineEvent.NodeScheduledPayload)
const decodeSettled = Schema.decodeUnknownOption(EngineEvent.NodeSettledPayload)

/** A node the executor admitted, as the engine recorded it.
 * @category projections
 * @since 1.0.0
 */
export const nodeScheduled = (
  event: NodeObservation
): NodeRecord<EngineEvent.NodeScheduledPayload> | undefined =>
  nodeRecord(event, EngineEvent.nodeEventTypes.nodeScheduled, decodeScheduled)

/** A node that reached an outcome, as the engine recorded it.
 * @category projections
 * @since 1.0.0
 */
export const nodeSettled = (
  event: NodeObservation
): NodeRecord<EngineEvent.NodeSettledPayload> | undefined =>
  nodeRecord(event, EngineEvent.nodeEventTypes.nodeSettled, decodeSettled)
