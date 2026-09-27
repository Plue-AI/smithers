/**
 * Standard metric definitions for content-addressed artifact storage.
 *
 * This module only defines the metric handles, following the shape of Effect's
 * `ClusterMetrics`. No exporter ships in this package; provide one — for
 * example `@smthrs/observability` — and these counters appear in it.
 *
 * Only the local `ArtifactStore` implementations, filesystem and memory, update
 * them. `RemoteArtifacts` is deliberately uninstrumented, and the counters carry
 * no tier attribute, so read them as *local artifact store traffic* rather than
 * as artifact operations:
 *
 * - a `CombinedArtifacts` read the local tier serves counts one get;
 * - a read the shared tier serves counts NO get, because no local store
 *   answered it;
 * - the write-back that materializes such a read counts a put, indistinguishable
 *   from a producer publishing new bytes.
 *
 * Attributing operations per tier needs the tier in the metric, which would
 * change the published counter shape; until then this is what the numbers mean.
 *
 * The one shared-tier signal is {@link remoteFailure}: a `CombinedArtifacts`
 * upload or write-back that was refused, or abandoned at its deadline.
 *
 * @since 1.0.0-rc.0
 */

import * as Metric from "effect/Metric"

/**
 * Counter over successful artifact puts. A put that deduplicated against an
 * existing verified blob still counts: the caller stored bytes and received
 * an address either way.
 *
 * @category metrics
 * @since 1.0.0-rc.0
 * @slop
 */
export const puts = Metric.counter("flows_artifact_puts", {
  description: "Successful artifact puts, including deduplicated ones"
})

/**
 * Counter over successful artifact gets. Missing and corrupt reads fail with
 * their typed errors and are deliberately not counted here; they are error
 * evidence, not throughput.
 *
 * @category metrics
 * @since 1.0.0-rc.0
 * @slop
 */
export const gets = Metric.counter("flows_artifact_gets", {
  description: "Successful artifact gets"
})

/**
 * Counter over opportunistic `CombinedArtifacts` transfers that failed or hit
 * their deadline and were dropped: `put`'s upload to the shared tier and
 * `get`'s write-back into the local tier.
 *
 * Read the attributed views on {@link remoteFailure}: every update carries an
 * `operation` attribute, so this bare handle aggregates nothing and always
 * reads zero.
 *
 * @category metrics
 * @since 1.0.0-rc.1
 */
export const remoteFailures = Metric.counter("flows_artifact_remote_failures", {
  description: "Dropped combined-artifact transfers by operation"
})

/**
 * `remoteFailures` views keyed by the dropped transfer.
 *
 * @category metrics
 * @since 1.0.0-rc.1
 */
export const remoteFailure: {
  readonly [Operation in "put" | "write_back"]: Metric.Metric<number, Metric.CounterState<number>>
} = {
  put: Metric.withAttributes(remoteFailures, { operation: "put" }),
  write_back: Metric.withAttributes(remoteFailures, { operation: "write_back" })
}
