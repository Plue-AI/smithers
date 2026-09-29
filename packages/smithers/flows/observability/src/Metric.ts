/**
 * Effect metric registry for flows runtime signals.
 *
 * @since 0.1.0
 */

import * as Metric from "effect/Metric"

const prefix = "flows_"

/**
 * Counts flow runs that reached a terminal state.
 *
 * @category metrics
 * @since 0.1.0
 */
export const runThroughput = Metric.counter(`${prefix}run_throughput`, {
  description: "Completed flow runs"
})

/**
 * The number of execution seats currently held.
 *
 * @category metrics
 * @since 0.1.0
 */
export const activeSeats = Metric.gauge(`${prefix}seat_active`, {
  description: "Currently active execution seats"
})

/**
 * Counts runs parked because a quota was exhausted.
 *
 * @category metrics
 * @since 0.1.0
 */
export const quotaParks = Metric.counter(`${prefix}quota_park`, {
  description: "Runs parked by quota enforcement"
})

/**
 * Counts agent answers refused by their declared output schema.
 *
 * @category metrics
 * @since 1.0.0-rc.1
 */
export const structuredOutputRejections = Metric.counter(`${prefix}agent_structured_output_rejections`, {
  description: "Agent answers refused by their declared output schema"
})

/**
 * Counts agent steps that failed after spending every output correction.
 *
 * @category metrics
 * @since 1.0.0-rc.1
 */
export const structuredOutputExhausted = Metric.counter(`${prefix}agent_structured_output_exhausted`, {
  description: "Agent steps whose output corrections were exhausted"
})

/**
 * Counts operational log records lost before durable delivery.
 *
 * Advances once per record dropped by a saturated forwarding queue, once per
 * journal delivery failure, and once per defect the forwarding worker recovers
 * from, so telemetry loss is distinguishable from an idle logger.
 *
 * @category metrics
 * @since 1.0.0-rc.0
 */
export const droppedLogRecords = Metric.counter(`${prefix}observability_log_dropped`, {
  description: "Operational log records dropped before durable delivery"
})

/**
 * All metrics declared by this package.
 *
 * @category registry
 * @since 0.1.0
 */
export const registry = {
  runThroughput,
  activeSeats,
  quotaParks,
  structuredOutputRejections,
  structuredOutputExhausted,
  droppedLogRecords
} as const
