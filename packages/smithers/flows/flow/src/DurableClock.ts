// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Durable timers for flow sleeps.
 *
 * `make` creates a `DurableClock` with a name, duration, and deferred wake-up
 * signal. `sleep` ignores zero durations, runs short sleeps through an
 * in-memory action, and schedules longer sleeps through the `FlowRuntime`
 * before awaiting the durable deferred tied to the clock.
 *
 * @since 0.1.0
 */

import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import * as Action from "./Action/index.ts"
import * as DurableDeferred from "./DurableDeferred.ts"
import { FlowInstance } from "./FlowRuntime/FlowInstance.ts"
import { FlowRuntime } from "./FlowRuntime/FlowRuntime.ts"

const TypeId = "@smthrs/flow/DurableClock"

/**
 * Represents a durable flow timer with a name, duration, and deferred
 * completed when the timer wakes.
 *
 * @category models
 * @since 0.1.0
 */
export interface DurableClock {
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly duration: Duration.Duration
  readonly deferred: DurableDeferred.DurableDeferred<typeof Schema.Void>
}

/**
 * Parses one author-supplied duration and requires it to be finite and
 * nonnegative. Invalid input throws `RangeError` so the authoring mistake is
 * caught at declaration time, matching `Flow.make` and `Poll.make`.
 *
 * @private
 */
const durationFromInput = (input: Duration.Input, field: string): Duration.Duration => {
  const parsed = Duration.fromInput(input)
  if (Option.isNone(parsed)) {
    throw new RangeError(`DurableClock: "${field}" must be a valid finite duration that is not negative.`)
  }
  const millis = Duration.toMillis(parsed.value)
  if (!Duration.isFinite(parsed.value) || !Number.isFinite(millis) || millis < 0) {
    throw new RangeError(`DurableClock: "${field}" must be a valid finite duration that is not negative.`)
  }
  return parsed.value
}

const makeClock = (name: string, duration: Duration.Duration): DurableClock => ({
  [TypeId]: TypeId,
  name,
  duration,
  deferred: DurableDeferred.make(`DurableClock/${name}`)
})

/**
 * Declares one durable clock after validating its finite nonnegative duration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: {
  readonly name: string
  readonly duration: Duration.Input
}): DurableClock => makeClock(options.name, durationFromInput(options.duration, "duration"))

/**
 * Waits inside a flow, using an in-memory action for durations at or
 * below the threshold and scheduling a durable clock for longer durations.
 *
 * @category sleeping
 * @since 0.1.0
 */
export const sleep = (
  options: {
    readonly name: string
    readonly duration: Duration.Input
    /**
     * If the duration is less than or equal to this threshold, the clock will
     * be executed in memory.
     *
     * @default 60 seconds
     */
    readonly inMemoryThreshold?: Duration.Input | undefined
  }
): Effect.Effect<
  void,
  never,
  Crypto.Crypto | FlowRuntime | FlowInstance
> => {
  const name = options.name
  const duration = durationFromInput(options.duration, "duration")
  const inMemoryThreshold = durationFromInput(
    options.inMemoryThreshold ?? defaultInMemoryThreshold,
    "inMemoryThreshold"
  )

  // Untraced because durable sleeps are recursively resumed by the engine.
  return Effect.fnUntraced(function*() {
    if (Duration.isZero(duration)) {
      return
    }

    if (Duration.isLessThanOrEqualTo(duration, inMemoryThreshold)) {
      return yield* Action.make({
        name: `DurableClock/${name}`,
        tier: "sealed",
        execute: Effect.sleep(duration)
      })
    }

    const engine = yield* FlowRuntime
    const instance = yield* FlowInstance
    const clock = makeClock(name, duration)
    yield* engine.scheduleClock(instance.flow, {
      executionId: instance.executionId,
      clock
    })
    return yield* DurableDeferred.await(clock.deferred)
  })()
}

const defaultInMemoryThreshold = Duration.seconds(60)
