/**
 * Native execution observations, independent of operational ownership leases.
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"
import * as Event from "./JournalEvent.ts"

/** Native semantic lifecycle fields recorded by the owning writer.
 * @category schemas
 * @since 1.0.0
 */
export const Observation = Schema.Struct({
  executionId: Event.RunId,
  flowName: Schema.NonEmptyString,
  status: Schema.Literals(["pending", "running", "suspended", "completed", "failed", "cancelled"]),
  createdAtMs: Event.TimestampMs,
  startedAtMs: Schema.NullOr(Event.TimestampMs),
  finishedAtMs: Schema.NullOr(Event.TimestampMs),
  parentRunId: Schema.NullOr(Event.RunId),
  lineageId: Event.RunId,
  roundOrdinal: Event.NonNegativeQuantity,
  cancelRequestedAtMs: Schema.NullOr(Event.TimestampMs),
  // Additive v1 extension: absent means the producer did not cover tree waits.
  treeVersion: Schema.optional(Schema.Literal(1)),
  parentPolicy: Schema.optional(Schema.Literals(["cancel", "detach"])),
  waiting: Schema.NullOr(Schema.Struct({
    reason: Schema.NonEmptyString,
    wakeAtMs: Schema.NullOr(Event.TimestampMs),
    tokenDigest: Schema.NullOr(Schema.NonEmptyString),
    point: Schema.optional(Schema.NullOr(Schema.String)),
    request: Schema.optional(Schema.NullOr(Schema.Json))
  }))
})
/** The value form of a native execution observation.
 * @category models
 * @since 1.0.0
 */
export type Observation = typeof Observation.Type

/** A new observation baseline never invents the preceding history.
 * @category schemas
 * @since 1.0.0
 */
export const Fact = Schema.Struct({
  version: Schema.Literal(1),
  baseline: Schema.Literals(["created", "legacy"]),
  observation: Observation
})

/** A corrupt/legacy row can still settle, but cannot establish a replay baseline.
 * @category schemas
 * @since 1.0.0
 */
export const UnavailableFact = Schema.Struct({
  version: Schema.Literal(1),
  unavailable: Schema.Literal("invalid-observation")
})

/** Root identity stays fixed while lifecycle follows its latest trampoline round.
 * @category schemas
 * @since 1.0.0
 */
export const View = Schema.Struct({
  root: Observation,
  current: Observation,
  /** Redacted display observations; opaque wake tokens are never journal authority. */
  humanWaits: Schema.optional(Schema.Array(Observation))
})
/** The value form of a logical execution view.
 * @category models
 * @since 1.0.0
 */
export type View = typeof View.Type

/** Source positions are native run-local sequence plus native journal generation.
 * @category models
 * @since 1.0.0
 */
export interface Input {
  readonly executionId: string
  readonly generation: number | null
  readonly sequence: number
  readonly eventType: string
  readonly payload: unknown
  readonly gap?: boolean
}
/** Honest replay coverage of the selected native root and current round.
 * @category schemas
 * @since 1.0.0
 */
export const Provenance = Schema.Struct({
  source: Schema.Literals(["events", "legacy-observation", "unverified-observation"]),
  rootExecutionId: Schema.String,
  humanWaits: Schema.optional(Schema.Literals(["events", "legacy-observation", "unverified-observation"])),
  /** Tree coverage starts independently in every native run-local stream. */
  humanWaitSources: Schema.optional(Schema.Array(Schema.Struct({
    executionId: Schema.String,
    generation: Schema.Number,
    baseline: Schema.Literals(["created", "legacy"]),
    fromSequence: Schema.Number,
    throughSequence: Schema.Number
  }))),
  currentExecutionId: Schema.optional(Schema.String),
  generation: Schema.optional(Schema.Number),
  baseline: Schema.optional(Schema.Literals(["created", "legacy"])),
  fromSequence: Schema.optional(Schema.Number),
  throughSequence: Schema.optional(Schema.Number)
})

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

// The journal canonicalizes object key order. Display metadata compares JSON
// values, so a writer's insertion order cannot turn an equal question into a gap.
const equalJson = (left: unknown, right: unknown): boolean => {
  if (left === right) return true
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => equalJson(value, right[index]))
  }
  const keys = Object.keys(left).sort()
  const other = Object.keys(right).sort()
  return keys.length === other.length && keys.every((key, index) =>
    key === other[index] &&
    equalJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])
  )
}

/** Compare semantic state only; heartbeat and owner incarnation are operational.
 * @category projections
 * @since 1.0.0
 */
export const equal = (left: Observation, right: Observation): boolean =>
  left.executionId === right.executionId && left.flowName === right.flowName && left.status === right.status &&
  left.createdAtMs === right.createdAtMs && left.startedAtMs === right.startedAtMs &&
  left.finishedAtMs === right.finishedAtMs &&
  left.parentRunId === right.parentRunId && left.lineageId === right.lineageId &&
  left.roundOrdinal === right.roundOrdinal &&
  left.cancelRequestedAtMs === right.cancelRequestedAtMs &&
  left.treeVersion === right.treeVersion && left.parentPolicy === right.parentPolicy &&
  (left.waiting === null ? right.waiting === null : right.waiting !== null &&
    left.waiting.reason === right.waiting.reason && left.waiting.wakeAtMs === right.waiting.wakeAtMs &&
    left.waiting.tokenDigest === right.waiting.tokenDigest && left.waiting.point === right.waiting.point &&
    equalJson(left.waiting.request, right.waiting.request))

/**
 * Fold native facts after a separately authenticated root binding. Sequence gaps
 * alone are not loss: SQL journal rollbacks leave unused sequence reservations.
 * A real omission/generation boundary invalidates coverage until a new complete
 * baseline is recorded. Unknown producer versions never become successful replay.
 * @category projections
 * @since 1.0.0
 */
export const fold = (inputs: ReadonlyArray<Input>, rootExecutionId: string, observed?: View): {
  readonly view: View | undefined
  readonly provenance: typeof Provenance.Type
} => {
  interface State {
    generation: number
    sequence: number
    observation?: Observation
    baseline?: "created" | "legacy"
    fromSequence?: number
    treeFromSequence?: number
    treeBaseline?: "created" | "legacy"
    uncovered: boolean
  }
  const states = new Map<string, State>()
  for (const input of inputs) {
    let state = states.get(input.executionId)
    if (input.generation !== null && state !== undefined && input.generation < state.generation) continue
    if (input.gap) {
      if (state === undefined) {
        states.set(input.executionId, {
          generation: input.generation ?? -1,
          sequence: -1,
          uncovered: true
        })
      } else {
        if (input.generation !== null && input.generation > state.generation) {
          state = { generation: input.generation, sequence: -1, uncovered: true }
          states.set(input.executionId, state)
        }
        state.uncovered = true
      }
      continue
    }
    if (input.generation === null) continue
    if (state === undefined || input.generation > state.generation) {
      state = { generation: input.generation, sequence: -1, uncovered: state !== undefined || input.generation > 0 }
      states.set(input.executionId, state)
    }
    if (input.sequence <= state.sequence) continue
    state.sequence = input.sequence
    const payload = record(input.payload)
    const candidate = payload.executionFact
    if (candidate === undefined) {
      // Diagnostic decisions and wake requests are not lifecycle mutations.
      if (
        state.observation !== undefined && input.eventType === "flows.engine.run-decision" &&
        ![
          "wake-scheduled",
          "claim-lost",
          "activation-lost",
          "steal-refused-owner-alive",
          "child-policy-applied",
          "lease-reconfirmed"
        ]
          .includes(String(payload.decision))
      ) {
        state.uncovered = true
      }
      if (state.observation !== undefined && input.eventType === "flows.engine.interrupted") state.uncovered = true
      continue
    }
    if (
      (input.eventType !== "flows.engine.run-decision" && input.eventType !== "flows.engine.interrupted") ||
      !Schema.is(Fact)(candidate) || candidate.observation.executionId !== input.executionId
    ) {
      state.uncovered = true
      continue
    }
    if (state.observation === undefined || state.uncovered) {
      state.baseline = state.uncovered ? "legacy" : candidate.baseline
      state.fromSequence = input.sequence
    }
    const completeTree = candidate.observation.treeVersion === 1 && candidate.observation.parentPolicy !== undefined &&
      (candidate.observation.waiting === null || candidate.observation.waiting.point !== undefined &&
          candidate.observation.waiting.request !== undefined)
    if (completeTree && (state.treeFromSequence === undefined || state.uncovered)) {
      state.treeFromSequence = input.sequence
      state.treeBaseline = state.uncovered || state.observation !== undefined ? "legacy" : candidate.baseline
    } else if (!completeTree) {
      delete state.treeFromSequence
      delete state.treeBaseline
    }
    state.observation = candidate.observation
    state.uncovered = false
  }
  const root = states.get(rootExecutionId)
  let current = root
  if (root?.observation !== undefined) {
    let ordinal = root.observation.roundOrdinal
    for (const state of states.values()) {
      if (
        state.observation?.lineageId === root.observation.lineageId &&
        state.observation.roundOrdinal > ordinal
      ) {
        current = state
        ordinal = state.observation.roundOrdinal
      }
    }
  }
  const treeApplicable = observed?.humanWaits !== undefined || current?.observation?.treeVersion === 1
  const reachable = new Map<string, number>()
  if (current?.observation !== undefined) reachable.set(current.observation.executionId, 0)
  for (let depth = 1; depth <= 64; depth++) {
    let added = false
    for (const [id, state] of states) {
      const observation = state.observation
      if (
        reachable.has(id) || observation === undefined || observation.parentRunId === null ||
        observation.parentPolicy === "detach" || reachable.get(observation.parentRunId) !== depth - 1
      ) continue
      reachable.set(id, depth)
      added = true
    }
    if (!added) break
  }
  const tree = [...reachable].map(([id, depth]) => ({ state: states.get(id)!, depth }))
  tree.sort((a, b) =>
    a.depth - b.depth ||
    a.state.observation!.createdAtMs - b.state.observation!.createdAtMs ||
    // Execution ids are the reachable-map keys, so no two entries share one
    // and the comparator never has to report a tie here.
    (a.state.observation!.executionId < b.state.observation!.executionId ? -1 : 1)
  )
  const humanWaits = tree.flatMap(({ state }) => {
    const observation = state.observation!
    return !["completed", "failed", "cancelled"].includes(observation.status) &&
        observation.waiting?.reason === "approval" && observation.waiting.tokenDigest !== null
      ? [observation] :
      []
  })
  // SQL and memory stores can enumerate an equal set of waits differently.
  // Verify every identity and value without making store order semantic.
  const observedHumanWaits = observed?.humanWaits
  const observedWaits = new Map((observedHumanWaits ?? []).map((wait) => [wait.executionId, wait]))
  const treeCovered = treeApplicable && tree.length > 0 &&
    // A missing/corrupt stream has unknown ancestry and cannot prove absence of a human wait.
    [...states.values()].every((state) => state.observation !== undefined && !state.uncovered) &&
    tree.every(({ state }) =>
      state.observation?.treeVersion === 1 && state.observation.parentPolicy !== undefined &&
      (state.observation.waiting === null || state.observation.waiting.point !== undefined &&
          state.observation.waiting.request !== undefined)
    ) &&
    (observedHumanWaits === undefined || humanWaits.length === observedHumanWaits.length &&
        observedWaits.size === humanWaits.length && humanWaits.every((wait) => {
          const other = observedWaits.get(wait.executionId)
          return other !== undefined && equal(wait, other)
        }))
  const view = root?.observation !== undefined && current?.observation !== undefined
    ? { root: root.observation, current: current.observation, ...(treeApplicable ? { humanWaits } : {}) } :
    undefined
  const covered = view !== undefined && !root?.uncovered && !current?.uncovered &&
    (!treeApplicable || treeCovered) &&
    (observed === undefined || equal(view.root, observed.root) && equal(view.current, observed.current))
  return {
    view: covered ? view : observed,
    provenance: {
      source: covered
        ? "events"
        : root?.observation === undefined && !root?.uncovered
        ? "legacy-observation"
        : "unverified-observation",
      rootExecutionId,
      ...(treeApplicable ?
        {
          humanWaits: treeCovered ?
            "events" as const :
            current?.observation?.treeVersion === 1
            ? "unverified-observation" as const
            : "legacy-observation" as const
        } :
        {}),
      ...(treeCovered ?
        {
          humanWaitSources: tree.map(({ state }) => ({
            executionId: state.observation!.executionId,
            generation: state.generation,
            baseline: state.treeBaseline!,
            fromSequence: state.treeFromSequence!,
            throughSequence: state.sequence
          }))
        } :
        {}),
      ...(current?.observation === undefined ? {} : { currentExecutionId: current.observation.executionId }),
      ...(current === undefined ? {} : { generation: current.generation }),
      ...(current?.baseline === undefined
        ? {}
        : { baseline: root?.baseline === "legacy" ? "legacy" : current.baseline }),
      ...(current?.fromSequence === undefined ? {} : { fromSequence: current.fromSequence }),
      ...(current === undefined ? {} : { throughSequence: current.sequence })
    }
  }
}

/** Control bridge inputs retain their native run-local positions and generation.
 * @category models
 * @since 1.0.0
 */
export interface BridgeEvent {
  readonly runId?: string | undefined
  readonly kind: string
  readonly payload: unknown
}

/** Interpret only the host's explicit root binding, never an ID naming convention.
 * @category projections
 * @since 1.0.0
 */
export const foldControl = (events: ReadonlyArray<BridgeEvent>, controlRunId: string, observed?: View) => {
  let root: string | undefined
  let conflicting = false
  const inputs: Array<Input> = []
  for (const event of events) {
    if (event.runId !== controlRunId) continue
    const payload = record(event.payload)
    if (event.kind === "control.engine.bound") {
      if (
        payload.version !== 1 || payload.controlRunId !== controlRunId || typeof payload.executionId !== "string" ||
        payload.executionId.length === 0
      ) {
        conflicting = true
      } else if (root !== undefined && root !== payload.executionId) conflicting = true
      else root = payload.executionId
    }
    if (
      event.kind === "control.engine.event" && payload.version === 1 && typeof payload.executionId === "string" &&
      typeof payload.generation === "number" && Number.isSafeInteger(payload.generation) && payload.generation >= 0 &&
      typeof payload.sequence === "number" && Number.isSafeInteger(payload.sequence) && payload.sequence >= 0 &&
      typeof payload.eventType === "string"
    ) {
      inputs.push({
        executionId: payload.executionId,
        generation: payload.generation,
        sequence: payload.sequence,
        eventType: payload.eventType,
        payload: payload.payload
      })
    }
    if (
      event.kind === "control.engine.event" &&
      !(payload.version === 1 && typeof payload.executionId === "string" &&
        typeof payload.generation === "number" && Number.isSafeInteger(payload.generation) && payload.generation >= 0 &&
        typeof payload.sequence === "number" && Number.isSafeInteger(payload.sequence) && payload.sequence >= 0 &&
        typeof payload.eventType === "string")
    ) {
      if (typeof payload.executionId !== "string") conflicting = true
      else {inputs.push({
          executionId: payload.executionId,
          generation: null,
          sequence: -1,
          eventType: event.kind,
          payload,
          gap: true
        })}
    }
    if (event.kind === "control.engine.projection-gap" && typeof payload.executionId === "string") {
      inputs.push({
        executionId: payload.executionId,
        generation: typeof payload.generation === "number" ? payload.generation : null,
        sequence: -1,
        eventType: event.kind,
        payload,
        gap: true
      })
    }
  }
  if (root === undefined || conflicting || observed !== undefined && observed.root.executionId !== root) {
    return observed === undefined ? undefined : {
      view: observed,
      provenance: {
        source: conflicting || root !== undefined ? "unverified-observation" as const : "legacy-observation" as const,
        rootExecutionId: observed.root.executionId,
        currentExecutionId: observed.current.executionId
      }
    }
  }
  return fold(inputs, root, observed)
}
