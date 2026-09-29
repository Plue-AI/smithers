import { Effect, Metric } from "effect"
import { describe, expect, it } from "vitest"
import * as FlowsMetric from "../src/Metric.ts"

describe("Metric registry", () => {
  it("declares the run, seat, and quota metrics updated by producer seams", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Metric.update(FlowsMetric.runThroughput, 1)
        yield* Metric.update(FlowsMetric.activeSeats, 3)
        yield* Metric.update(FlowsMetric.quotaParks, 2)
        return {
          throughput: yield* Metric.value(FlowsMetric.runThroughput),
          seats: yield* Metric.value(FlowsMetric.activeSeats),
          parks: yield* Metric.value(FlowsMetric.quotaParks)
        }
      }).pipe(Effect.provideService(Metric.MetricRegistry, new Map()))
    )
    expect(result.throughput.count).toBe(1)
    expect(result.seats.value).toBe(3)
    expect(result.parks.count).toBe(2)
  })

  it("names every metric in the Prometheus-safe flows_<area>_<name> form the other flows packages use", () => {
    for (const handle of Object.values(FlowsMetric.registry)) {
      expect(handle.id).toMatch(/^flows_[a-z0-9]+(_[a-z0-9]+)+$/)
    }
  })

  /**
   * The identifiers are the dashboard contract: the handles are updated at
   * producer seams in `@smthrs/agent` and `@smthrs/run-store`, so a rename that
   * only the value assertions covered would ship silently.
   */
  it("publishes the exact metric identifiers and no others", () => {
    expect(
      Object.fromEntries(
        Object.entries(FlowsMetric.registry).map(([name, handle]) => [name, handle.id])
      )
    ).toEqual({
      runThroughput: "flows_run_throughput",
      activeSeats: "flows_seat_active",
      quotaParks: "flows_quota_park",
      structuredOutputRejections: "flows_agent_structured_output_rejections",
      structuredOutputExhausted: "flows_agent_structured_output_exhausted",
      droppedLogRecords: "flows_observability_log_dropped"
    })
    expect(Object.keys(FlowsMetric.registry)).toHaveLength(6)
  })
})
