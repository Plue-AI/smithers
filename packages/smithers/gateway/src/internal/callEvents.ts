/**
 * Shared call lifecycle identity rules for full and incremental projections.
 *
 * @since 1.0.0
 */

import { CallFact, StepFact } from "@smthrs/journal"
import * as Schema from "effect/Schema"

/** A sparse historical observation is readable without inventing missing fields.
 * @category models
 * @since 1.0.0
 */
export interface CallObservation {
  readonly kind?: string | undefined
  readonly runId?: string | undefined
  readonly sequence?: number | undefined
  readonly payload?: unknown
}

/** Interpret only the native producer's versioned, run-scoped outbox facts.
 * @category projections
 * @since 1.0.0
 */
export const nativeCallEvent = <Event extends CallObservation>(event: Event): Event | undefined => {
  if (event.kind !== "control.engine.event" || typeof event.payload !== "object" || event.payload === null) {
    return undefined
  }
  const envelope = event.payload as Record<string, unknown>
  if (
    envelope.version !== 1 || envelope.eventType !== CallFact.eventType || typeof envelope.executionId !== "string" ||
    typeof envelope.generation !== "number" || !Number.isSafeInteger(envelope.generation) || envelope.generation < 0 ||
    typeof envelope.sequence !== "number" || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 0 ||
    typeof envelope.emittedAtMs !== "number" || !Number.isFinite(envelope.emittedAtMs) || envelope.emittedAtMs < 0 ||
    envelope.sourceSequence !== 0
  ) return undefined
  const fact = Schema.decodeUnknownOption(CallFact.Fact)(envelope.payload)
  if (
    fact._tag === "None" || fact.value.identity.runId !== event.runId ||
    envelope.sourceId !== `call-fact-v1:${fact.value.callId}:${fact.value.phase}`
  ) return undefined
  return {
    ...event,
    kind: fact.value.phase === "invoked" ? "control.agent.cell-call-started" : "control.agent.cell-call-settled",
    payload: JSON.parse(JSON.stringify({ ...fact.value, callFactVersion: 1, at: envelope.emittedAtMs }))
  }
}

/** Normalize a checkpoint only within its recorded execution and source.
 * Replayed prefixes retain the generation that first recorded the work.
 * @category projections
 * @since 1.0.0
 */
export const nativeStepEvent = <Event extends CallObservation>(event: Event): Event | undefined => {
  if (event.kind !== "control.engine.event" || typeof event.payload !== "object" || event.payload === null) {
    return undefined
  }
  const envelope = event.payload as Record<string, unknown>
  if (
    envelope.version !== 1 || envelope.eventType !== StepFact.eventType ||
    typeof envelope.generation !== "number" || !Number.isSafeInteger(envelope.generation) || envelope.generation < 0 ||
    typeof envelope.sequence !== "number" || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 0 ||
    typeof envelope.emittedAtMs !== "number" || !Number.isFinite(envelope.emittedAtMs) || envelope.emittedAtMs < 0
  ) return undefined
  const decoded = Schema.decodeUnknownOption(StepFact.Fact)(envelope.payload)
  if (decoded._tag === "None") return undefined
  const fact = decoded.value
  const step = fact.step
  if (
    envelope.executionId !== step.executionId || envelope.sourceSequence !== fact.sourceSequence ||
    envelope.sourceId !== `step-fact-v1:${step.stepId}:${step.attempt}:${step.ask}:${step.retry}` ||
    fact.generation > envelope.generation || !Number.isFinite(fact.at) ||
    typeof fact.payload !== "object" || fact.payload === null || Array.isArray(fact.payload)
  ) return undefined
  return {
    ...event,
    kind: fact.eventType,
    payload: {
      ...fact.payload,
      step: { ...step, generation: fact.generation, frame: fact.frame, ordinal: fact.ordinal },
      at: fact.at
    }
  }
}

/** Scope call matching to the recorded invocation, including its generation.
 * @category projections
 * @since 1.0.0
 */
export const callScope = (event: CallObservation): string | undefined => {
  const payload = event.payload
  if (typeof payload !== "object" || payload === null || !("step" in payload)) return undefined
  const step = payload.step
  if (typeof step !== "object" || step === null || Array.isArray(step)) return undefined
  const scope = step as Record<string, unknown>
  return JSON.stringify([
    scope.executionId,
    scope.stepId,
    scope.attempt,
    scope.ask,
    scope.retry,
    scope.scope,
    scope.generation
  ])
}

/**
 * Identity first; the upgrade fallback can consume only unidentified starts.
 *
 * @category projections
 * @since 1.0.0
 */
export const openCallIndex = (
  open: ReadonlyArray<
    { readonly flowName: string; readonly callId?: string | undefined; readonly scope?: string | undefined }
  >,
  callId: string | undefined,
  flowName: string | undefined,
  scope?: string
): number => {
  const identified = callId === undefined
    ? -1
    : open.findIndex((call) => call.callId === callId && call.scope === scope)
  if (identified >= 0) return identified
  return open.findIndex((call) =>
    call.scope === scope && call.callId === undefined && (flowName === undefined || call.flowName === flowName)
  )
}

/**
 * Deduplicate identified call lifecycles and committed checkpoint observations.
 *
 * @category projections
 * @since 1.0.0
 */
export const callEventKey = (event: CallObservation): string | undefined => {
  const stepEvent = nativeStepEvent(event)
  const original = event
  event = stepEvent ?? nativeCallEvent(event) ?? event
  const payload = event.payload
  if (
    (event.kind === "control.agent.cell-call-started" || event.kind === "control.agent.cell-call-settled") &&
    typeof payload === "object" && payload !== null && "callId" in payload && typeof payload.callId === "string"
  ) {
    return JSON.stringify([event.kind, payload.callId, callScope(event)])
  }
  // An older checkpoint may not have a call ID. Its durable source identity
  // still deduplicates replay, including after the event body is evicted.
  if (stepEvent === undefined) {
    // A persisted model settlement has a journal sequence even when older
    // telemetry has no native checkpoint identity. Re-delivery is one call.
    if (event.kind === "control.agent.model-settled" && typeof event.sequence === "number" && Number.isSafeInteger(event.sequence)) {
      return JSON.stringify(["model-settled", event.runId, event.sequence, callScope(event)])
    }
    return undefined
  }
  const envelope = original.payload as Record<string, unknown>
  return JSON.stringify(["step-fact", original.runId, callScope(stepEvent), envelope.sourceSequence])
}

/**
 * Native facts supersede identified telemetry while retaining its display
 * position. Unidentified history cannot acquire an invented identity.
 *
 * @category projections
 * @since 1.0.0
 */
export const uniqueCallEvents = <Event extends CallObservation>(
  events: ReadonlyArray<Event>
): ReadonlyArray<Event> => {
  const native = new Map<string, Event>()
  const normalized = events.map((event) => {
    const fact = nativeStepEvent(event) ?? nativeCallEvent(event)
    if (fact === undefined) return event
    const key = callEventKey(event)
    if (key !== undefined && !native.has(key)) native.set(key, fact)
    return fact
  })
  const seen = new Set<string>()
  const stepSeen = new Set<string>()
  return normalized.flatMap((event, index) => {
    const original = events[index]!
    if (nativeStepEvent(original) !== undefined) {
      const envelope = original.payload as Record<string, unknown>
      const fact = envelope.payload as Record<string, unknown>
      const identity = JSON.stringify([original.runId, callScope(event), envelope.sourceSequence, fact.generation])
      if (stepSeen.has(identity)) return []
      stepSeen.add(identity)
    }
    const key = callEventKey(original)
    if (key === undefined) return [event]
    if (seen.has(key)) return []
    seen.add(key)
    const preferred = native.get(key)
    return [preferred === undefined ? event : { ...preferred, sequence: event.sequence }]
  })
}

/**
 * What {@link CallEventFilter} did with one event.
 *
 * `rewrite` means the event superseded one the filter already kept: the batch
 * rule replaces the earlier event in place, so a reader holding the earlier
 * output must refold from the whole journal.
 *
 * @category projections
 * @since 1.0.0
 */
export type CallEventVerdict<Event> =
  | { readonly _tag: "keep"; readonly event: Event }
  | { readonly _tag: "drop" }
  | { readonly _tag: "rewrite" }

/**
 * {@link uniqueCallEvents} one event at a time, for a journal read in order.
 *
 * The sets are exactly the ones the batch builds, so a filter fed a whole
 * journal holds the state the batch ended with. Only one case cannot be
 * answered in order: a native fact whose key an earlier telemetry event
 * already claimed. That verdict is `rewrite`.
 *
 * @category projections
 * @since 1.0.0
 */
export interface CallEventFilter<Event extends CallObservation> {
  readonly push: (event: Event) => CallEventVerdict<Event>
}

/**
 * Builds an empty {@link CallEventFilter}.
 *
 * @category projections
 * @since 1.0.0
 */
export const callEventFilter = <Event extends CallObservation>(): CallEventFilter<Event> => {
  const native = new Map<string, Event>()
  const seen = new Set<string>()
  const stepSeen = new Set<string>()
  return {
    push: (original) => {
      const step = nativeStepEvent(original)
      const fact = step ?? nativeCallEvent(original)
      const event = fact ?? original
      const key = callEventKey(original)
      if (fact !== undefined && key !== undefined && !native.has(key)) {
        native.set(key, fact)
        // The batch hands this fact to the event that first claimed the key.
        if (seen.has(key)) return { _tag: "rewrite" }
      }
      if (step !== undefined) {
        const envelope = original.payload as Record<string, unknown>
        const payload = envelope.payload as Record<string, unknown>
        const identity = JSON.stringify([original.runId, callScope(event), envelope.sourceSequence, payload.generation])
        if (stepSeen.has(identity)) return { _tag: "drop" }
        stepSeen.add(identity)
      }
      if (key === undefined) return { _tag: "keep", event }
      if (seen.has(key)) return { _tag: "drop" }
      seen.add(key)
      const preferred = native.get(key)
      return { _tag: "keep", event: preferred === undefined ? event : { ...preferred, sequence: event.sequence } }
    }
  }
}
