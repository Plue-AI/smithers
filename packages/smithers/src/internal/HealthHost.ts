/** Scoped, bounded health observation beside the native control host.
 * @since 1.0.0
 */

import { Control, Health, Monitor } from "@smthrs/control"
import type { Journal } from "@smthrs/journal"
import { Cause, Effect, FiberMap, Metric, type Scope, Semaphore } from "effect"
import { randomUUID } from "node:crypto"

const activeSubjects = Metric.gauge("smithers.health.monitored_subjects")
const refusedSubjects = Metric.counter("smithers.health.capacity_refusals")

/** Run observations only on the host that owns the local journal; no control mutations.
 * Read failures leave the last observation to expire and are retried on the next scan.
 * @since 1.0.0
 * @private
 */
export const watch = (
  registry: Health.Registry
): Effect.Effect<never, never, Control.Control | Journal.Journal | Scope.Scope> =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const gate = yield* Semaphore.make(registry.limits.maxConcurrentProbes)
    const active = yield* FiberMap.make<string, Monitor.Report, never>()
    const monitorId = `host-${randomUUID()}`
    const scan = Effect.gen(function*() {
      let admitted = 0
      for (const status of ["running", "accepted", "waiting-approval", "parked"] as const) {
        const listed = yield* control.list({ _tag: "runs", filters: { status }, limit: 500 })
        if (listed._tag !== "runs") continue
        for (const run of listed.items) {
          if (yield* FiberMap.has(active, run.runId)) continue
          if ((yield* FiberMap.size(active)) >= registry.limits.maxSubjects) {
            yield* Metric.update(refusedSubjects, 1)
            continue
          }
          const healthCheck = registry.resolve(run.flowId)
          yield* Monitor.run({
            runId: run.runId,
            monitorId,
            healthCheck,
            stallBeats: Math.ceil(healthCheck.policy.stallAfterMs / healthCheck.policy.intervalMs),
            withProbePermit: gate.withPermits(1),
            maxChecks: Number.MAX_SAFE_INTEGER,
            retainBeats: 1,
            recordBeats: false,
            // A health check never authorizes lifecycle changes.
            autoHeal: []
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause) ?
                Effect.interrupt :
                Effect.logWarning("Health observation stopped; its last reading will expire", {
                  operation: "health-monitor",
                  runId: run.runId
                })
                  .pipe(Effect.as({ runId: run.runId, beats: [], health: "unknown" as const }))
            ),
            FiberMap.run(active, run.runId, { onlyIfMissing: true })
          )
          admitted += 1
        }
      }
      yield* Metric.update(activeSubjects, yield* FiberMap.size(active))
      return admitted
    }).pipe(Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ?
        Effect.interrupt :
        Effect.logWarning("Health subject discovery failed; retrying", { operation: "health-discovery" }).pipe(
          Effect.as(0)
        )
    ))
    while (true) {
      yield* scan
      yield* Effect.sleep(5_000)
    }
  })

/** Validate trusted configuration before forking the lifetime-bound observer.
 * @since 1.0.0
 * @private
 */
export const start = (config?: Health.HealthConfig) =>
  Effect.gen(function*() {
    const registry = yield* Effect.sync(() => Health.makeRegistry(config, "run"))
    yield* Effect.forkScoped(watch(registry))
  })
