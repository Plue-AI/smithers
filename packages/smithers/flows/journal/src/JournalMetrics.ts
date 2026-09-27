/**
 * Standard metric definitions for the journal write path.
 *
 * This module only defines the metric handles, following the shape of Effect's
 * `ClusterMetrics`. `SqlJournal` updates them as emission receipts are
 * produced, so the counters measure admissions on the hot path rather than
 * rows read back. No exporter ships in this package; provide one, for
 * example `@smthrs/observability`, and these counters appear in it.
 *
 * @since 0.1.0
 */

import * as Metric from "effect/Metric"

/**
 * Counter over journal emissions, dimensioned by `channel` (`durable` or
 * `lossy`) and `receipt` (`accepted`, `duplicate`, or `dropped`).
 *
 * **Details**
 *
 * A `durable` emission counts when its receipt is produced, which is after the
 * write transaction returned; under `Journal.transact` that is still inside
 * the caller's transaction, so a receipt that later rolls back with the
 * enclosing transaction has already counted. The counter is throughput
 * evidence, not commit evidence: the journal rows themselves are the latter.
 *
 * @category metrics
 * @since 0.1.0
 */
export const writes = Metric.counter("flows_journal_writes", {
  description: "Journal emissions by channel and receipt"
})

/**
 * `writes` views for the durable channel, keyed by the receipt tag
 * `Journal.emitDurable` resolves to.
 *
 * @category metrics
 * @since 0.1.0
 */
export const durable: {
  readonly [Tag in "Accepted" | "Duplicate"]: Metric.Metric<number, Metric.CounterState<number>>
} = {
  Accepted: Metric.withAttributes(writes, { channel: "durable", receipt: "accepted" }),
  Duplicate: Metric.withAttributes(writes, { channel: "durable", receipt: "duplicate" })
}

/**
 * `writes` views for the lossy channel, keyed by the receipt tag
 * `Journal.emitLossy` resolves to.
 *
 * @category metrics
 * @since 0.1.0
 */
export const lossy: {
  readonly [Tag in "Accepted" | "Duplicate" | "Dropped"]: Metric.Metric<number, Metric.CounterState<number>>
} = {
  Accepted: Metric.withAttributes(writes, { channel: "lossy", receipt: "accepted" }),
  Duplicate: Metric.withAttributes(writes, { channel: "lossy", receipt: "duplicate" }),
  Dropped: Metric.withAttributes(writes, { channel: "lossy", receipt: "dropped" })
}

/**
 * Counter over lossy entries the writer admitted and then failed to commit,
 * dimensioned by `channel` (always `lossy`) and the `code` of the
 * `JournalError` that lost them.
 *
 * **Details**
 *
 * A lossy producer rarely calls `flush`, so the failure `flush` reports is not
 * where an operator learns about a lost batch. This counter moves by the number
 * of entries lost the moment the writer gives them up, whether or not anyone
 * is waiting on them.
 *
 * @category metrics
 * @since 1.0.0-rc.1
 */
export const lostEntries = Metric.counter("flows_journal_lost", {
  description: "Admitted lossy journal entries the writer failed to commit"
})

/**
 * The {@link lostEntries} view for one `JournalError` code.
 *
 * @category metrics
 * @since 1.0.0-rc.1
 */
export const lost = (code: string): Metric.Metric<number, Metric.CounterState<number>> =>
  Metric.withAttributes(lostEntries, { channel: "lossy", code })
