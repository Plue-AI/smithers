/**
 * Standard metric definitions for the durable write boundary.
 *
 * This module only defines the metric handles, following the shape of Effect's
 * `ClusterMetrics`. `DurableWriter`'s retry policy updates them, so every
 * store that writes through the boundary — journal, run store, step cache,
 * engine state — lands in the same counter. No exporter ships in this
 * package; provide one — for example `@smthrs/observability` — and the
 * counter appears in it.
 *
 * @since 0.1.0
 */

import * as Metric from "effect/Metric"

/**
 * Counter over write transaction replays. Incremented once per scheduled
 * retry of a recognized transient conflict (`SQLITE_BUSY`, serialization
 * failure, deadlock), so a quiet system reads zero and a rising rate reads as
 * write contention. The attempt that finally fails past the retry budget is
 * not counted; it surfaces on the error channel instead.
 *
 * @category metrics
 * @since 0.1.0
 */
export const writeRetries = Metric.counter("flows_db_write_retries", {
  description: "Durable write transaction replays after transient conflicts"
})
