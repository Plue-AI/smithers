/**
 * Standard metric definitions for the engine-store hot paths.
 *
 * This module only defines the metric handles, following the shape of
 * `RunStoreMetrics` and Effect's `ClusterMetrics`. The dispatch seam
 * (`internal/ActionPersistence`), the plan scheduler, the workspace sandbox,
 * and the run driver update them as outcomes are decided. No exporter ships in
 * this package; provide one — for example `@smthrs/observability` — and
 * these series appear in it.
 *
 * Counters over an effect's exit are keyed by {@link ExitTag} records, so an
 * update is a lookup rather than a branch, and durations land in
 * `Metric.timer` histograms through Effect's own `Effect.trackDuration`. The
 * same exit observation annotates the operation span with its outcome; none of
 * the instrumentation combinators alters the instrumented effect's result or
 * cause.
 *
 * @since 0.1.0
 */

import * as Cause from "effect/Cause"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import * as Metric from "effect/Metric"

/**
 * How an instrumented effect exited: `Success`, `Failure` (any non-interrupt
 * cause), or `Interrupt` (an interrupt-only cause — in this store that is the
 * fencing self-interruption as well as caller cancellation).
 *
 * @category models
 * @since 0.1.0
 */
export type ExitTag = "Success" | "Failure" | "Interrupt"

/** Rewrites an outcome tag (`HeartbeatFresh`) as an attribute value (`heartbeat_fresh`). */
const attributeValue = (tag: string): string => tag.replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_").toLowerCase()

/** Builds the tag-keyed record of attributed counter views for one operation. */
const byOutcome = <const Tags extends ReadonlyArray<string>>(
  metric: Metric.Metric<number, Metric.CounterState<number>>,
  attributes: Readonly<Record<string, string>>,
  tags: Tags
): { readonly [Tag in Tags[number]]: Metric.Metric<number, Metric.CounterState<number>> } =>
  Object.fromEntries(
    tags.map((tag) => [tag, Metric.withAttributes(metric, { ...attributes, outcome: attributeValue(tag) })])
  ) as { [Tag in Tags[number]]: Metric.Metric<number, Metric.CounterState<number>> }

/**
 * Classifies an exit for an {@link ExitTag}-keyed counter record.
 *
 * @category accessors
 * @since 0.1.0
 */
export const exitTag = <A, E>(exit: Exit.Exit<A, E>): ExitTag =>
  exit._tag === "Success" ? "Success" : Cause.hasInterruptsOnly(exit.cause) ? "Interrupt" : "Failure"

/**
 * Observes an effect with a duration timer and an exit-outcome counter.
 *
 * Composes Effect's own `Effect.trackDuration` (monotonic clock, records on
 * success, failure, and interruption alike) with an `Effect.onExit` counter
 * update and current-span annotation, so the instrumented effect's exit —
 * value, cause, and interruption — propagates byte-identically. This is the
 * dual-instrument shape production Effect services use for hot-path
 * operations.
 *
 * @category combinators
 * @since 0.1.0
 */
export const observe = (instruments: {
  readonly timer: Metric.Histogram<Duration.Duration>
  readonly counter: { readonly [Tag in ExitTag]: Metric.Metric<number, Metric.CounterState<number>> }
}) =>
<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.trackDuration(instruments.timer),
    Effect.onExit((exit) => {
      const tag = exitTag(exit)
      return Effect.annotateCurrentSpan({ outcome: attributeValue(tag) }).pipe(
        Effect.andThen(Metric.update(instruments.counter[tag], 1))
      )
    })
  )

const exitTags = ["Success", "Failure", "Interrupt"] as const

/**
 * Counter over durable action dispatches through
 * `internal/ActionPersistence`, dimensioned by exit `outcome` (`success`,
 * `failure`, or `interrupt`). A cache-served replay and a fresh execution
 * both count: the dispatch is the unit the engine retries and fences.
 *
 * @category metrics
 * @since 0.1.0
 */
export const dispatches = Metric.counter("flows_engine_dispatches", {
  description: "Durable action dispatches by exit outcome"
})

/**
 * Latency histogram over durable action dispatches, from admission through
 * settlement (cache verification, execution, copy-back, and the terminal
 * row included).
 *
 * @category metrics
 * @since 0.1.0
 */
export const dispatchDuration = Metric.timer("flows_engine_dispatch_duration", {
  description: "Durable action dispatch duration"
})

/**
 * `dispatches` views keyed by {@link ExitTag}.
 *
 * @category metrics
 * @since 0.1.0
 */
export const dispatch = byOutcome(dispatches, {}, exitTags)

/**
 * Counter over scheduler admission passes that launched work. The
 * completion-driven scheduler re-computes the ready set after every terminal
 * event; only a pass that admits at least one node counts, so the series
 * reads as "how many times the scheduler opened dispatch permits", not as
 * event-loop noise.
 *
 * @category metrics
 * @since 0.1.0
 */
export const schedulerAdmissions = Metric.counter("flows_engine_scheduler_admissions", {
  description: "Plan scheduler admission passes that launched at least one dispatch"
})

/**
 * Latency histogram over one scheduler dispatch, admission through terminal
 * event: measurement, keying, the durable-action seam, and every rebase turn
 * of the same node's loop land in a single observation.
 *
 * @category metrics
 * @since 0.1.0
 */
export const schedulerDispatchDuration = Metric.timer("flows_engine_scheduler_dispatch_duration", {
  description: "Duration of one scheduler dispatch, admission through terminal event"
})

/**
 * Counter over plan node settlements, dimensioned by the scheduler `outcome`
 * (`built`, `clean`, `failed`, `skipped`, or `deferred`) — the per-node
 * evaluation vocabulary `PlanScheduler` journals.
 *
 * @category metrics
 * @since 0.1.0
 */
export const schedulerNodes = Metric.counter("flows_engine_scheduler_nodes", {
  description: "Plan node settlements by evaluation outcome"
})

/**
 * `schedulerNodes` views keyed by `PlanScheduler.Outcome`.
 *
 * @category metrics
 * @since 0.1.0
 */
export const node = byOutcome(
  schedulerNodes,
  {},
  ["built", "clean", "failed", "skipped", "deferred"] as const
)

/**
 * Counter over isolated workspace executions (`WorkspaceSandbox.execute`),
 * dimensioned by exit `outcome`. An `Invalidated` verdict is a `success`
 * exit — the transaction ran and answered; the verdict itself is journaled.
 *
 * @category metrics
 * @since 0.1.0
 */
export const sandboxExecutions = Metric.counter("flows_engine_sandbox_executions", {
  description: "Isolated workspace executions by exit outcome"
})

/**
 * `sandboxExecutions` views keyed by {@link ExitTag}.
 *
 * @category metrics
 * @since 0.1.0
 */
export const sandboxExecution = byOutcome(sandboxExecutions, {}, exitTags)

/**
 * Latency histogram over isolated workspace executions.
 *
 * @category metrics
 * @since 0.1.0
 */
export const sandboxExecutionDuration = Metric.timer("flows_engine_sandbox_execution_duration", {
  description: "Isolated workspace execution duration"
})

/**
 * Counter over sandbox materializations (`WorkspaceSandbox.materialize` —
 * the one host write), dimensioned by exit `outcome`.
 *
 * @category metrics
 * @since 0.1.0
 */
export const sandboxMaterializations = Metric.counter("flows_engine_sandbox_materializations", {
  description: "Sandbox copy-back materializations by exit outcome"
})

/**
 * `sandboxMaterializations` views keyed by {@link ExitTag}.
 *
 * @category metrics
 * @since 0.1.0
 */
export const materialization = byOutcome(sandboxMaterializations, {}, exitTags)

/**
 * Latency histogram over sandbox materializations.
 *
 * @category metrics
 * @since 0.1.0
 */
export const materializationDuration = Metric.timer("flows_engine_sandbox_materialization_duration", {
  description: "Sandbox copy-back materialization duration"
})

/**
 * Counter over copy-back compare-and-set refusals: the preflight found host
 * state that moved after the transaction's base snapshot. The engine answers
 * one with a rebase or a conflict strategy, so the rate is contention
 * evidence, not an error rate.
 *
 * @category metrics
 * @since 0.1.0
 */
export const materializationConflicts = Metric.counter("flows_engine_sandbox_conflicts", {
  description: "Sandbox copy-back compare-and-set refusals"
})

/**
 * Counter over step-boundary settlements at the dispatch seam, dimensioned by
 * `outcome`: `clean` evidence, an `expected`-mode `deviation`, or a hard
 * `violation` (undeclared write, missing declared output, surviving declared
 * removal), with `refused` for a host that could not settle at all.
 *
 * @category metrics
 * @since 0.1.0
 */
export const boundarySettlements = Metric.counter("flows_engine_boundary_settlements", {
  description: "Step boundary settlements by outcome"
})

/**
 * `boundarySettlements` views keyed by settlement classification.
 *
 * @category metrics
 * @since 0.1.0
 */
export const boundarySettlement = byOutcome(
  boundarySettlements,
  {},
  ["Clean", "Deviation", "Violation", "Refused"] as const
)

/**
 * Counter over the EFFECTIVE step-boundary cache decisions at the dispatch
 * seam, dimensioned by `outcome`. `flows_step_cache_lookups` counts raw row
 * presence at `CacheStore.get`; this series records what the dispatch
 * actually did with the row after read-set verification and output
 * materialization — `verified_hit` served the cached result, and every other
 * outcome fell through to a real execution (`miss` no row,
 * `unverifiable_evidence` a row whose recorded evidence cannot justify reuse,
 * `unmeasurable` a host that could not re-measure the read set,
 * `stale_read_set` a measured mismatch, `replay_failed` verified evidence the
 * host could not re-materialize). Each decision is counted where it takes
 * effect: `verified_hit` as the cached result is returned, a fall-through
 * outcome as the dispatch proceeds past its refusal handling — so a
 * cache-consulting dispatch that fails or is fenced out mid-decision (a
 * journal failure on the provenance emit, a strict corruption verdict)
 * records no decision, and its exit lands in {@link dispatches}. At most one
 * decision is counted per cache-consulting dispatch.
 *
 * @category metrics
 * @since 0.1.0
 */
export const stepCacheDecisions = Metric.counter("flows_engine_step_cache_decisions", {
  description: "Effective step-boundary cache decisions at the dispatch seam"
})

/**
 * `stepCacheDecisions` views keyed by decision.
 *
 * @category metrics
 * @since 0.1.0
 */
export const stepCacheDecision = byOutcome(
  stepCacheDecisions,
  {},
  ["VerifiedHit", "Miss", "UnverifiableEvidence", "Unmeasurable", "StaleReadSet", "ReplayFailed"] as const
)

/**
 * Counter over the run driver's claim-and-activate decisions, dimensioned by
 * `outcome`. These are the engine-level decisions taken BEFORE or AFTER the
 * store-level compare-and-swaps `RunStoreMetrics` counts: a `terminal` or
 * `heartbeat_fresh` refusal never reaches the store, `steal_refused_owner_alive`
 * is the liveness probe declining, and `claim_lost`/`activation_lost` are the
 * driver observing a lost store CAS.
 *
 * @category metrics
 * @since 0.1.0
 */
export const claims = Metric.counter("flows_engine_claims", {
  description: "Run driver claim-and-activate decisions by outcome"
})

/**
 * `claims` views keyed by driver decision.
 *
 * @category metrics
 * @since 0.1.0
 */
export const claim = byOutcome(
  claims,
  {},
  ["Activated", "Terminal", "HeartbeatFresh", "StealRefusedOwnerAlive", "ClaimLost", "ActivationLost"] as const
)
