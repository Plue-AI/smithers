/**
 * Committed native results and the control binding that authorizes them.
 * @since 1.0.0
 */

import type { ControlSchema } from "@smthrs/control"

interface Identity {
  readonly runId: string
  readonly executionId: string
}

/**
 * Kept across bounded journal windows; only the host's root binding authorizes output.
 * @category models
 * @since 1.0.0
 */
export interface NativeResolution {
  readonly binding?: Identity | undefined
  readonly result?: (Identity & { readonly text: string }) | undefined
  readonly conflict?: true | undefined
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const same = (left: Identity, right: Identity): boolean =>
  left.runId === right.runId && left.executionId === right.executionId
const position = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0

/**
 * A root's committed success is authoritative; child outputs and telemetry are not.
 * @category projections
 * @since 1.0.0
 */
export const fromEvent = (event: ControlSchema.ControlEvent): NativeResolution | undefined => {
  if (event.runId === undefined || event.runId.length === 0) return undefined
  const bridge = record(event.payload)
  if (event.kind === "control.engine.bound") {
    return bridge.version === 1 && bridge.controlRunId === event.runId &&
        typeof bridge.executionId === "string" && bridge.executionId.length > 0
      ? { binding: { runId: event.runId, executionId: bridge.executionId } }
      : { conflict: true }
  }
  if (
    event.kind !== "control.engine.event" || bridge.version !== 1 ||
    typeof bridge.executionId !== "string" || !position(bridge.generation) || !position(bridge.sequence) ||
    bridge.eventType !== "flows.engine.run-decision"
  ) return undefined
  const decision = record(bridge.payload)
  const fact = record(decision.executionFact)
  const observation = record(fact.observation)
  const state = record(decision.state)
  const input = record(state.payload)
  const result = record(state.result)
  const exit = record(result.exit)
  if (
    decision.decision !== "transitioned" || decision.status !== "completed" || fact.version !== 1 ||
    (fact.baseline !== "created" && fact.baseline !== "legacy") ||
    observation.executionId !== bridge.executionId || observation.status !== "completed" ||
    observation.flowName !== "agent/run" || state.version !== 1 || state.flowName !== "agent/run" ||
    input.runId !== event.runId || typeof input.planId !== "string" || input.planId.length === 0 ||
    result._tag !== "Complete" || exit._tag !== "Success" || !Object.hasOwn(exit, "value")
  ) return undefined
  try {
    const text = typeof exit.value === "string" ? exit.value : JSON.stringify(exit.value)
    return text === undefined ? undefined : { result: { runId: event.runId, executionId: bridge.executionId, text } }
  } catch {
    return undefined
  }
}

/**
 * Combining adjacent windows retains the binding even after its event is evicted.
 * @category projections
 * @since 1.0.0
 */
export const combine = (
  earlier: NativeResolution | undefined,
  later: NativeResolution | undefined
): NativeResolution | undefined => {
  if (earlier === undefined) return later
  if (later === undefined) return earlier
  const conflict = earlier.conflict || later.conflict ||
    (earlier.binding !== undefined && later.binding !== undefined && !same(earlier.binding, later.binding)) ||
    (earlier.result !== undefined && later.result !== undefined &&
      (!same(earlier.result, later.result) || earlier.result.text !== later.result.text))
  return {
    binding: later.binding ?? earlier.binding,
    result: later.result ?? earlier.result,
    ...(conflict ? { conflict: true } : {})
  }
}

/**
 * Returns output only for one unambiguous, bound root.
 * @category projections
 * @since 1.0.0
 */
export const output = (value: NativeResolution | undefined): string | undefined =>
  value?.conflict !== true && value?.binding !== undefined && value.result !== undefined &&
    same(value.binding, value.result) ?
    value.result.text :
    undefined
