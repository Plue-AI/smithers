/**
 * The threshold math behind every `memory` routing decision.
 *
 * Each decision (include a wiki page, descend into a directory, include a
 * file, include a commit, ...) asks Jev one boolean per item. The answer's
 * probability `p` is mapped through a reliability table to a calibrated
 * `p̂`, and the item is included when `p̂ ≥ τ`. `τ` starts from the
 * decision's declared costs: include when `p̂ · miss ≥ (1 − p̂) · extra`, so
 * `τ = extra / (miss + extra)`. A missed file costs more than an extra one,
 * so file inclusion sits on a low bar.
 *
 * {@link refit} is the weekly step `memory/calibrate` runs over labels read
 * from journals and landed fixes. It never moves a threshold more than
 * {@link maxMove} in one fit and never fits on fewer than {@link minLabels}
 * labels; a refused fit is returned with the threshold it proposed, so the
 * caller files it for a person instead of landing it.
 *
 * @since 1.0.0
 */

import * as Digest from "@smthrs/core/Digest"
import * as Schema from "effect/Schema"

/**
 * The routing decisions `memory` makes, each with its own threshold.
 *
 * @category models
 * @since 1.0.0
 */
export const Decision = Schema.Literals(["page", "skill", "dep", "descend", "file", "commit", "fact"])

/**
 * The decoded form of {@link Decision}.
 *
 * @category models
 * @since 1.0.0
 */
export type Decision = typeof Decision.Type

/**
 * What a wrong answer costs, in any common unit: a missed needed item and an
 * included unneeded one.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Costs = Schema.Struct({ miss: Schema.Number, extra: Schema.Number })

/**
 * One decision's current setting: its declared costs, the threshold on the
 * calibrated scale, and the ten-bucket reliability table (`null` until a fit
 * had enough labels, which makes `p̂ = p`).
 *
 * @category schemas
 * @since 1.0.0
 */
export const Decided = Schema.Struct({
  costs: Costs,
  tau: Schema.Number,
  reliability: Schema.NullOr(Schema.Array(Schema.Number))
})

/**
 * The decoded form of {@link Decided}.
 *
 * @category models
 * @since 1.0.0
 */
export type Decided = typeof Decided.Type

/**
 * Every decision's setting, and the Jev model the settings were fitted for.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Thresholds = Schema.Struct({
  version: Schema.Int,
  model: Schema.String,
  decisions: Schema.Struct({
    page: Decided,
    skill: Decided,
    dep: Decided,
    descend: Decided,
    file: Decided,
    commit: Decided,
    fact: Decided
  })
})

/**
 * The decoded form of {@link Thresholds}.
 *
 * @category models
 * @since 1.0.0
 */
export type Thresholds = typeof Thresholds.Type

/**
 * The largest threshold move one fit may land.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxMove = 0.05

/**
 * The fewest labels a fit needs.
 *
 * @category constants
 * @since 1.0.0
 */
export const minLabels = 200

/**
 * The cost-optimal threshold for a calibrated probability.
 *
 * @category math
 * @since 1.0.0
 */
export const tau = (costs: typeof Costs.Type): number => costs.extra / (costs.miss + costs.extra)

const buckets = 10

/** The reliability bucket of a probability; 1 falls in the last bucket. */
const bucketOf = (p: number): number => Math.min(buckets - 1, Math.max(0, Math.floor(p * buckets)))

/**
 * `p` mapped through the decision's reliability table; `p` itself when the
 * table is absent.
 *
 * @category math
 * @since 1.0.0
 */
export const calibrated = (decided: Decided, p: number): number =>
  decided.reliability === null ? p : decided.reliability[bucketOf(p)]!

/**
 * Whether a probability clears the decision's threshold.
 *
 * @category math
 * @since 1.0.0
 */
export const include = (decided: Decided, p: number): boolean => calibrated(decided, p) >= decided.tau

/**
 * One observed outcome: Jev's raw probability for an item and whether the
 * item turned out to be needed. `weight` defaults to 1; a weak label such as
 * "included but never read" carries less.
 *
 * @category models
 * @since 1.0.0
 */
export interface Label {
  readonly p: number
  readonly needed: boolean
  readonly weight?: number | undefined
}

/**
 * Fits a monotone ten-bucket map from raw probability to observed hit rate.
 *
 * Each bucket's weighted hit rate is pooled with its neighbours wherever it
 * would fall below the bucket before it (pool adjacent violators), so a
 * higher raw probability never maps to a lower calibrated one. A bucket with
 * no labels takes its own midpoint before pooling.
 *
 * @category math
 * @since 1.0.0
 */
export const fit = (labels: ReadonlyArray<Label>): ReadonlyArray<number> => {
  const hits = Array.from({ length: buckets }, () => 0)
  const weights = Array.from({ length: buckets }, () => 0)
  for (const label of labels) {
    const at = bucketOf(label.p)
    const weight = label.weight ?? 1
    weights[at]! += weight
    if (label.needed) hits[at]! += weight
  }
  const blocks: Array<{ value: number; weight: number; size: number }> = []
  for (let at = 0; at < buckets; at++) {
    const weight = weights[at]!
    const value = weight === 0 ? (at + 0.5) / buckets : hits[at]! / weight
    blocks.push({ value, weight: Math.max(weight, 1e-9), size: 1 })
    while (blocks.length > 1 && blocks[blocks.length - 2]!.value > blocks[blocks.length - 1]!.value) {
      const last = blocks.pop()!
      const previous = blocks.pop()!
      const total = previous.weight + last.weight
      blocks.push({
        value: (previous.value * previous.weight + last.value * last.weight) / total,
        weight: total,
        size: previous.size + last.size
      })
    }
  }
  return blocks.flatMap((block) => Array.from({ length: block.size }, () => Number(block.value.toFixed(4))))
}

/**
 * The weighted cost of deciding `labels` at threshold `t` on the scale
 * `table` gives.
 *
 * @category math
 * @since 1.0.0
 */
export const expectedCost = (
  labels: ReadonlyArray<Label>,
  table: ReadonlyArray<number> | null,
  t: number,
  costs: typeof Costs.Type
): number =>
  labels.reduce((total, label) => {
    const p = table === null ? label.p : table[bucketOf(label.p)]!
    const weight = label.weight ?? 1
    if (label.needed && p < t) return total + weight * costs.miss
    if (!label.needed && p >= t) return total + weight * costs.extra
    return total
  }, 0)

/**
 * The threshold in steps of 0.01 with the least {@link expectedCost}; on a
 * tie, the one closest to the cost-optimal {@link tau}.
 *
 * @category math
 * @since 1.0.0
 */
export const bestTau = (
  labels: ReadonlyArray<Label>,
  table: ReadonlyArray<number> | null,
  costs: typeof Costs.Type
): number => {
  const ideal = tau(costs)
  let best = ideal
  let bestCost = expectedCost(labels, table, ideal, costs)
  for (let step = 0; step <= 100; step++) {
    const t = step / 100
    const cost = expectedCost(labels, table, t, costs)
    if (cost < bestCost || (cost === bestCost && Math.abs(t - ideal) < Math.abs(best - ideal))) {
      best = t
      bestCost = cost
    }
  }
  return Number(best.toFixed(2))
}

/**
 * The outcome of one fit: a setting to land, or a refusal naming why and
 * what the fit proposed.
 *
 * @category models
 * @since 1.0.0
 */
export type Refit =
  | { readonly _tag: "Refit"; readonly decided: Decided; readonly labels: number }
  | {
    readonly _tag: "Refused"
    readonly reason: "too_few_labels" | "move_too_large"
    readonly proposed: number
    readonly labels: number
  }

/**
 * Fits one decision's reliability table and threshold from `labels`.
 *
 * Refuses under {@link minLabels} labels, and refuses a threshold that would
 * move more than {@link maxMove} from `current.tau`.
 *
 * @category math
 * @since 1.0.0
 */
export const refit = (current: Decided, labels: ReadonlyArray<Label>): Refit => {
  const table = fit(labels)
  const proposed = bestTau(labels, table, current.costs)
  if (labels.length < minLabels) {
    return { _tag: "Refused", reason: "too_few_labels", proposed, labels: labels.length }
  }
  if (Math.abs(proposed - current.tau) > maxMove + 1e-9) {
    return { _tag: "Refused", reason: "move_too_large", proposed, labels: labels.length }
  }
  return { _tag: "Refit", decided: { costs: current.costs, tau: proposed, reliability: table }, labels: labels.length }
}

/**
 * The digest a `memory` step key carries, so a new fit never replays an old
 * selection.
 *
 * @category math
 * @since 1.0.0
 */
export const digest = (thresholds: Thresholds): string => Digest.digest(Digest.canonical(thresholds))

const declared = (miss: number, extra: number): Decided => ({
  costs: { miss, extra },
  tau: Number(tau({ miss, extra }).toFixed(2)),
  reliability: null
})

/**
 * Where a repository's landed fit lives, relative to its root. `memory` reads
 * it with `Memory.thresholds`.
 *
 * @category constants
 * @since 1.0.0
 */
export const file = ".smithers/memory-thresholds.json"

/**
 * The thresholds `memory` decides with until `memory/calibrate` lands a fit.
 *
 * Costs are declared per decision; each `τ` is the cost-optimal threshold:
 * include a page, skill or file at 0.35, descend at 0.30, include a commit
 * or dependency page at 0.50, accept a mined fact at 0.70.
 *
 * @category constants
 * @since 1.0.0
 */
export const initial: Thresholds = {
  version: 1,
  model: "typesafe-ai/jev",
  decisions: {
    page: declared(13, 7),
    skill: declared(13, 7),
    dep: declared(1, 1),
    descend: declared(7, 3),
    file: declared(13, 7),
    commit: declared(1, 1),
    fact: declared(3, 7)
  }
}
