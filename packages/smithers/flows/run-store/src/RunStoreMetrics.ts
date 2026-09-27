/**
 * Standard metric definitions for fenced run persistence.
 *
 * This module only defines the metric handles, following the shape of Effect's
 * `ClusterMetrics`. `RunStore` updates them as compare-and-swap outcomes are
 * decided, so every driver that persists through the store — the engine, a
 * sweeper, a foreign process — lands in the same counters. No exporter ships
 * in this package; provide one — for example `@smthrs/observability` —
 * and these counters appear in it.
 *
 * Each exported record maps an outcome's `_tag` to an attributed view of the
 * counter, so an update is a lookup rather than a branch:
 * `Metric.update(RunStoreMetrics.claim[outcome._tag], 1)`.
 *
 * @since 0.1.0
 */

import * as Metric from "effect/Metric"

/**
 * Counter over ownership claim compare-and-swaps, dimensioned by `op`
 * (`claim`, `claim_and_own`, `activate`, `abandon_claim`, `recover_claim`, or
 * `steal`) and `outcome` (the
 * operation's result tag in snake case, or `failure` or `interrupt` when the
 * call did not return one).
 *
 * @category metrics
 * @since 0.1.0
 */
export const claims = Metric.counter("flows_run_claims", {
  description: "Ownership claim compare-and-swaps by operation and outcome"
})

/**
 * Counter over fenced run state transitions, dimensioned by `outcome`
 * (`transitioned`, `fence_lost`, `not_found`, `guard_failed`, `failure`, or
 * `interrupt`) and `to` (the requested target status).
 *
 * @category metrics
 * @since 0.1.0
 */
export const transitions = Metric.counter("flows_run_transitions", {
  description: "Fenced run state transitions by outcome and target status"
})

/**
 * Counter over fenced ownership heartbeats, dimensioned by `outcome`
 * (`updated`, `fence_lost`, `not_found`, `failure`, or `interrupt`). A
 * `fence_lost` heartbeat is the fencing event: the writer discovered another
 * owner holds the run.
 *
 * @category metrics
 * @since 0.1.0
 */
export const heartbeats = Metric.counter("flows_run_heartbeats", {
  description: "Fenced ownership heartbeats by outcome"
})

/** Rewrites an outcome tag (`AlreadyClaimed`) as an attribute value (`already_claimed`). */
const attributeValue = (tag: string): string => tag.replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_").toLowerCase()

/** Builds the `_tag`-keyed record of attributed counter views for one operation. */
const byOutcome = <const Tags extends ReadonlyArray<string>>(
  metric: Metric.Metric<number, Metric.CounterState<number>>,
  attributes: Readonly<Record<string, string>>,
  tags: Tags
): { readonly [Tag in Tags[number]]: Metric.Metric<number, Metric.CounterState<number>> } =>
  Object.fromEntries(
    tags.map((tag) => [tag, Metric.withAttributes(metric, { ...attributes, outcome: attributeValue(tag) })])
  ) as { [Tag in Tags[number]]: Metric.Metric<number, Metric.CounterState<number>> }

const claimTags = ["Claimed", "NotFound", "AlreadyClaimed", "HeartbeatFresh", "SnapshotChanged"] as const

/**
 * `claims` views for `RunStore.claim`, keyed by `ClaimOutcome` tag.
 *
 * @category metrics
 * @since 0.1.0
 */
export const claim = byOutcome(claims, { op: "claim" }, claimTags)

/**
 * `claims` views for `RunStore.claimAndOwn`, keyed by `ClaimAndOwnOutcome`
 * tag.
 *
 * @category metrics
 * @since 0.1.0
 */
export const claimAndOwn = byOutcome(
  claims,
  { op: "claim_and_own" },
  ["Activated", "NotFound", "AlreadyClaimed", "HeartbeatFresh", "SnapshotChanged", "EvidenceRequired"] as const
)

/**
 * `claims` views for `RunStore.activate`, keyed by `ActivateOutcome` tag. A
 * `claim_lost` activation is a fencing event: the held claim was recovered or
 * replaced before the activation ran.
 *
 * @category metrics
 * @since 0.1.0
 */
export const activate = byOutcome(
  claims,
  { op: "activate" },
  ["Activated", "ClaimLost", "SnapshotChanged"] as const
)

/**
 * `claims` views for `RunStore.abandonClaim`, keyed by outcome tag.
 *
 * @category metrics
 * @since 1.0.0-rc.0
 */
export const abandonClaim = byOutcome(
  claims,
  { op: "abandon_claim" },
  ["Abandoned", "ClaimLost"] as const
)

/**
 * `claims` views for `RunStore.recoverClaim`, keyed by outcome tag.
 *
 * @category metrics
 * @since 1.0.0-rc.0
 */
export const recoverClaim = byOutcome(
  claims,
  { op: "recover_claim" },
  ["Recovered", "NotFound", "ClaimFresh", "ClaimChanged", "LivenessUnconfirmed"] as const
)

/**
 * `claims` views for `RunStore.steal`, keyed by `StealOutcome` tag.
 *
 * @category metrics
 * @since 0.1.0
 */
export const steal = byOutcome(
  claims,
  { op: "steal" },
  ["Claimed", "NotFound", "AlreadyClaimed", "HeartbeatFresh", "SnapshotChanged", "LivenessUnconfirmed"] as const
)

/**
 * `heartbeats` views keyed by `HeartbeatOutcome` tag.
 *
 * @category metrics
 * @since 0.1.0
 */
export const heartbeat = byOutcome(heartbeats, {}, ["Updated", "FenceLost", "NotFound"] as const)

/**
 * `transitions` views keyed by `TransitionOutcome` tag. `RunStore` adds the
 * `to` attribute at the update site, because the target status is call input
 * rather than a closed set this module should restate.
 *
 * @category metrics
 * @since 0.1.0
 */
export const transition = byOutcome(
  transitions,
  {},
  ["Transitioned", "FenceLost", "NotFound", "GuardFailed"] as const
)
