/**
 * Closes every store operation span with an `outcome` attribute, so a trace
 * viewer never sees a span that ended without saying how. `RunStore` and
 * `AttemptStore` share these observers so the guide can describe one rule.
 *
 * @since 1.0.0-rc.0
 * @private
 */

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"

/** Maps a PascalCase outcome tag to its snake_case span attribute. */
const outcomeValue = (tag: string): string => tag.replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_").toLowerCase()

/** Classifies a non-success exit for the span `outcome` attribute. */
const causeOutcome = <E>(cause: Cause.Cause<E>): "failure" | "interrupt" =>
  Cause.hasInterruptsOnly(cause) ? "interrupt" : "failure"

/**
 * Observes a store operation's exit onto its span, and, when the operation
 * has an outcome-keyed counter, updates it in the same observation: the
 * domain tag (`claimed`, `fence_lost`) on success, `failure` or `interrupt`
 * otherwise, so a span never closes without saying how and a failed write
 * still lands in the counter. `exitMetric` is the counter view carrying every
 * attribute but `outcome`, which this observer adds for a non-success exit.
 * `Effect.onExit` only reads the exit; the value, cause, and interruption
 * propagate byte-identically.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const observeOutcome = <A extends { readonly _tag: string }>(
  metricOf?: ((outcome: A) => Metric.Metric<number, Metric.CounterState<number>>) | undefined,
  exitMetric?: Metric.Metric<number, Metric.CounterState<number>> | undefined
) =>
<E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.onExit((exit) => {
      if (exit._tag === "Success") {
        return Effect.annotateCurrentSpan({ outcome: outcomeValue(exit.value._tag) }).pipe(
          Effect.andThen(metricOf === undefined ? Effect.void : Metric.update(metricOf(exit.value), 1))
        )
      }
      const outcome = causeOutcome(exit.cause)
      return Effect.annotateCurrentSpan({ outcome }).pipe(
        Effect.andThen(
          exitMetric === undefined ? Effect.void : Metric.update(Metric.withAttributes(exitMetric, { outcome }), 1)
        )
      )
    })
  )

/**
 * `observeOutcome` for operations whose success carries no domain outcome
 * tag: `create` inserts or fails, `get` returns the row or fails, and
 * `acknowledgeCancel` reports whether the guarded update matched. The span
 * still closes with `success`, `failure`, or `interrupt`.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const observeExit = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.onExit((exit) =>
      Effect.annotateCurrentSpan({
        outcome: exit._tag === "Success" ? "success" : causeOutcome(exit.cause)
      })
    )
  )
