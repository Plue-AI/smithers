/**
 * Run ancestry as the control plane reads it.
 *
 * A run's ancestry is recorded by whoever created the run, in four different
 * places: the run row's `parent_run_id`, `lineage_id`, and `round_ordinal`
 * columns; the `flows_run_parents` edge a spawn writes; the `created` and
 * `handed-off` run decisions the engine journals; and the `fork-created`
 * marker time travel writes on a forked child. This module owns the one
 * vocabulary they all project onto — {@link Origin} — and the pure functions
 * that do the projecting, so the durable runtime and the watch stream cannot
 * disagree about what a run's ancestry means.
 *
 * The two event types named here are produced by `@smthrs/engine-store` and
 * `@smthrs/time-travel`. They are named as strings rather than imported
 * because the control plane reads journals, not engines: a control plane that
 * depended on the engine could not project a journal written by a different
 * one.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"
import type { ControlEvent } from "./ControlSchema.ts"

/**
 * How a run came to exist.
 *
 * The three values are the lineage-edge kinds of
 * `docs/pages/concepts/time-travel.md`: a `child` is a run its parent spawned, a
 * `fork` is a run branched off a parent frame, and a `continuation` is a later
 * round of one trampoline lineage. A rewind is deliberately absent — it
 * truncates a run in place and creates none — and a run with no ancestor has
 * no origin at all.
 *
 * @category models
 * @since 0.1.0
 */
export const Origin = Schema.Literals(["child", "fork", "continuation"])

/**
 * How a run came to exist.
 *
 * @category models
 * @since 0.1.0
 */
export type Origin = typeof Origin.Type

/**
 * The ancestry facts an origin is decided from.
 *
 * @category models
 * @since 0.1.0
 */
export interface Ancestry {
  readonly parentRunId?: string | undefined
  readonly roundOrdinal?: number | undefined
  /** Whether a `fork-created` marker names this run. */
  readonly forked?: boolean | undefined
}

/**
 * The journal event type carrying an engine run decision.
 *
 * @category constants
 * @since 0.1.0
 */
export const runDecisionEventType = "flows.engine.run-decision"

/**
 * The journal event type time travel writes on a forked child.
 *
 * @category constants
 * @since 0.1.0
 */
export const forkCreatedEventType = "flows.time-travel.fork-created"

/**
 * The kind `watch` reports a derived ancestry delta under.
 *
 * @category constants
 * @since 0.1.0
 */
export const lineageEventType = "control.run.lineage"

/**
 * Decides how a run came to exist from its ancestry facts.
 *
 * A fork wins over a plain child because a fork records `parent_run_id` too:
 * without the marker every fork would be reported as an ordinary child.
 *
 * @param ancestry the run's recorded ancestry
 * @category projections
 * @since 0.1.0
 */
export const originOf = (ancestry: Ancestry): Origin | undefined => {
  if (ancestry.forked === true) return "fork"
  if (ancestry.roundOrdinal !== undefined && ancestry.roundOrdinal > 0) return "continuation"
  return ancestry.parentRunId === undefined ? undefined : "child"
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined

const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined

const ordinal = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined

/**
 * Derives the ancestry edge one journal entry discloses, if it discloses one.
 *
 * Three entries do, and each names a different pair:
 *
 * | Entry | Ancestor | Descendant |
 * | --- | --- | --- |
 * | `created` naming `parentExecutionId`, at round 0 or with no round | the spawning run | the entry's run |
 * | `handed-off` naming `nextExecutionId` | the entry's run | the next round |
 * | `fork-created` | the forked-from run | the entry's run |
 *
 * The handoff is what carries a trampoline, and a continuation round's own
 * `created` decision is deliberately skipped. The engine journals BOTH in one
 * transaction: `RunDriver` creates the next round with
 * `{decision: "created", lineageId, roundOrdinal, parentExecutionId}` and then
 * records `{decision: "handed-off", nextExecutionId}` on the round that
 * finished. Both name the same pair, so deriving from both would report one
 * run as a `child` of its predecessor on one entry and a `continuation` of it
 * on the other. The handoff is the one kept, because it reaches a consumer
 * watching the run that hands off — which is the run an operator is already
 * following when a trampoline advances.
 *
 * A `created` decision at round 0, or with no round at all, is an ordinary
 * spawn and derives a `child` edge.
 *
 * Everything else derives nothing. This is a projection over entries the
 * control plane did not write, so an entry it does not recognize is not an
 * error.
 *
 * @param event the projected journal entry
 * @category projections
 * @since 0.1.0
 */
export const derive = (event: ControlEvent): ControlEvent | undefined => {
  if (event.runId === undefined) return undefined
  const payload = record(event.payload)
  if (payload === undefined) return undefined
  const edge = event.kind === forkCreatedEventType
    ? { runId: event.runId, parentRunId: text(payload["parentRunId"]), forked: true }
    : event.kind !== runDecisionEventType
    ? undefined
    : payload["decision"] === "created"
    // A continuation round's `created` names its predecessor too. The handoff
    // the previous round journals in the SAME transaction already discloses
    // that edge, so deriving here as well would contradict it.
    ? (ordinal(payload["roundOrdinal"]) ?? 0) > 0
      ? undefined
      : { runId: event.runId, parentRunId: text(payload["parentExecutionId"]), forked: false }
    : payload["decision"] === "handed-off"
    ? {
      runId: text(payload["nextExecutionId"]),
      parentRunId: event.runId,
      forked: false,
      lineageId: text(payload["lineageId"]),
      roundOrdinal: ordinal(payload["roundOrdinal"])
    }
    : undefined
  if (edge === undefined || edge.runId === undefined || edge.parentRunId === undefined) return undefined
  const lineageId = "lineageId" in edge ? edge.lineageId : undefined
  const roundOrdinal = "roundOrdinal" in edge ? edge.roundOrdinal : undefined
  const origin = originOf({
    parentRunId: edge.parentRunId,
    ...(roundOrdinal === undefined ? {} : { roundOrdinal }),
    forked: edge.forked
  })
  return {
    sequence: event.sequence,
    kind: lineageEventType,
    runId: event.runId,
    occurredAt: event.occurredAt,
    payload: {
      runId: edge.runId,
      parentRunId: edge.parentRunId,
      ...(lineageId === undefined ? {} : { lineageId }),
      ...(roundOrdinal === undefined ? {} : { roundOrdinal }),
      /* v8 ignore next -- `originOf` answers nothing only without a parent, and the guard above already refused an edge with no parent */
      ...(origin === undefined ? {} : { origin })
    }
  }
}

/**
 * Expands one projected entry into itself plus any ancestry delta it
 * discloses.
 *
 * @param event the projected journal entry
 * @category projections
 * @since 0.1.0
 */
export const expand = (event: ControlEvent): ReadonlyArray<ControlEvent> => {
  const derived = derive(event)
  return derived === undefined ? [event] : [event, derived]
}
