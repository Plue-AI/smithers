/**
 * Standard metric definitions for the content-addressed step result cache.
 *
 * This module only defines the metric handles, following the shape of Effect's
 * `ClusterMetrics`. `CacheStore` updates them as lookups and recordings
 * resolve. No exporter ships in this package; provide one — for example
 * `@smthrs/observability` — and these counters appear in it.
 *
 * @since 0.1.0
 */

import * as Metric from "effect/Metric"

/**
 * Counter over cache lookups, dimensioned by `outcome` (`hit` or `miss`).
 *
 * Read the attributed views, {@link hit} and {@link miss}: every update
 * carries an `outcome` attribute, so this bare handle aggregates nothing and
 * always reads zero.
 *
 * These are one host's durable-tier counts. `RemoteCacheStore` updates no
 * counters, so a lookup that `CombinedCacheStore` serves from the shared tier
 * registers one `miss` for the local tier that did not hold it, plus the
 * write-back's {@link put} outcome. A two-tier deployment's hit rate is
 * therefore the rate at which this machine already held the entry, not the
 * rate at which a result was reused.
 *
 * @category metrics
 * @since 0.1.0
 */
export const lookups = Metric.counter("flows_step_cache_lookups", {
  description: "Step cache lookups by outcome"
})

/**
 * `lookups` view counting hits: a row existed for the key digest.
 *
 * @category metrics
 * @since 0.1.0
 */
export const hit: Metric.Metric<number, Metric.CounterState<number>> = Metric.withAttributes(lookups, {
  outcome: "hit"
})

/**
 * `lookups` view counting misses: the lookup had no entry it could serve.
 *
 * That covers a key digest with no row at all and a row the caller's
 * `maxAgeMs` bound refused, which is a miss rather than a stale hit.
 *
 * @category metrics
 * @since 0.1.0
 */
export const miss: Metric.Metric<number, Metric.CounterState<number>> = Metric.withAttributes(lookups, {
  outcome: "miss"
})

/**
 * Counter over cache recordings, dimensioned by `outcome` (`inserted`,
 * `existing_same`, or `conflict`). A `conflict` is the signal
 * `Inconsistency` receivers act on: the same key digest recorded a different
 * result.
 *
 * Read the attributed views on {@link put}: every update carries an `outcome`
 * attribute, so this bare handle aggregates nothing and always reads zero.
 *
 * One `CombinedCacheStore.put` can register two outcomes. The local tier
 * records its own, and a shared tier answering `Conflict` adds a `conflict`,
 * because a differing result under one digest on another machine is
 * cross-host divergence that reaches an operator nowhere else. That extra count
 * assumes the shared tier keeps no counters, which is true of the tier this
 * package ships: a `RemoteCacheStore` updates none. Composing a second
 * counter-keeping store as the shared tier instead records the same conflict
 * twice, once from that store's own `put` and once from the composition.
 *
 * @category metrics
 * @since 0.1.0
 */
export const puts = Metric.counter("flows_step_cache_puts", {
  description: "Step cache recordings by outcome"
})

/**
 * `puts` views keyed by the `PutResult` tag `CacheStore.put` resolves to.
 *
 * @category metrics
 * @since 0.1.0
 */
export const put: {
  readonly [Tag in "Inserted" | "ExistingSame" | "Conflict"]: Metric.Metric<number, Metric.CounterState<number>>
} = {
  Inserted: Metric.withAttributes(puts, { outcome: "inserted" }),
  ExistingSame: Metric.withAttributes(puts, { outcome: "existing_same" }),
  Conflict: Metric.withAttributes(puts, { outcome: "conflict" })
}

/**
 * Counter over shared-tier refusals, dimensioned by `operation` (`get` or
 * `put`). A combined store degrades these refusals to a miss or a successful
 * local recording because the shared tier is only an accelerator.
 *
 * Read the attributed views on {@link remoteFailure}: every update carries an
 * `operation` attribute, so this bare handle aggregates nothing and always
 * reads zero.
 *
 * @category metrics
 * @since 1.0.0-rc.0
 */
export const remoteFailures = Metric.counter("flows_step_cache_remote_failures", {
  description: "Shared step cache refusals by operation"
})

/**
 * `remoteFailures` views keyed by the refused shared-tier operation.
 *
 * @category metrics
 * @since 1.0.0-rc.0
 */
export const remoteFailure: {
  readonly [Operation in "get" | "put"]: Metric.Metric<number, Metric.CounterState<number>>
} = {
  get: Metric.withAttributes(remoteFailures, { operation: "get" }),
  put: Metric.withAttributes(remoteFailures, { operation: "put" })
}
