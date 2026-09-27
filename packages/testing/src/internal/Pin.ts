/**
 * The assertion and waiting vocabulary every conformance pin is written in.
 *
 * `fail`, `assert`, and `invoke` were copied verbatim into all four pin
 * modules, and `waitUntil` and `awaitFiber` into two of them. One copy is the
 * source of truth here, so a bound schedule or a span attribute cannot be
 * fixed in one pin and left wrong in the next.
 *
 * This module is internal: `./internal/*` is null-mapped in the export map and
 * carries no compatibility promise.
 *
 * @since 0.0.0
 */

import * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import type * as Fiber from "effect/Fiber"
import * as Schedule from "effect/Schedule"
import * as TestClock from "effect/testing/TestClock"
import { ConformanceViolation } from "../TestingError.ts"

/**
 * Fails a pin with its stable `conformance_violation` code, naming the pin and
 * carrying the expectation and the observation as typed fields.
 *
 * @since 0.0.0
 * @category assertions
 */
export const fail = (
  pin: string,
  message: string,
  expected?: unknown,
  actual?: unknown
): Effect.Effect<never, ConformanceViolation> =>
  Effect.fail(
    new ConformanceViolation({
      pin,
      message,
      ...(expected === undefined ? {} : { expected }),
      ...(actual === undefined ? {} : { actual })
    })
  )

/**
 * Fails with {@link fail} unless `condition` holds.
 *
 * @since 0.0.0
 * @category assertions
 */
export const assert = (
  pin: string,
  condition: boolean,
  message: string,
  expected?: unknown,
  actual?: unknown
): Effect.Effect<void, ConformanceViolation> => condition ? Effect.void : fail(pin, message, expected, actual)

/**
 * Runs one subject operation inside a span named for it, so a failing pin can
 * be attributed to the operation that produced it.
 *
 * @since 0.0.0
 * @category assertions
 */
export const invoke = <A, E>(
  pin: string,
  operation: string,
  evaluate: () => Effect.Effect<A, E>
): Effect.Effect<A, E> =>
  Effect.suspend(evaluate).pipe(Effect.withSpan(`testing.${operation}`, { attributes: { pin } }))

/**
 * Polls `probe` on a bounded live-clock schedule and returns its first defined
 * value, failing the pin rather than hanging when no value arrives.
 *
 * @since 0.0.0
 * @category assertions
 */
export const pollUntil = <A>(
  pin: string,
  probe: () => A | undefined,
  message: string
): Effect.Effect<A, ConformanceViolation> =>
  Effect.suspend(() => {
    const value = probe()
    return value === undefined ? Effect.fail(undefined) : Effect.succeed(value)
  }).pipe(
    Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 99 }),
    TestClock.withLive,
    Effect.catch(() => fail(pin, message, "settlement within one second of live time", "still pending"))
  )

/**
 * Polls `predicate` on the bounded live-clock schedule {@link pollUntil} uses,
 * failing the pin rather than hanging when the condition never holds.
 *
 * @since 0.0.0
 * @category assertions
 */
export const waitUntil = (
  pin: string,
  predicate: () => boolean,
  message: string
): Effect.Effect<void, ConformanceViolation> =>
  pollUntil(pin, () => predicate() ? true : undefined, message).pipe(Effect.asVoid)

/**
 * Waits for `fiber` to settle within the bounded budget {@link waitUntil}
 * uses, and returns its exit.
 *
 * @since 0.0.0
 * @category assertions
 */
export const awaitFiber = <A, E>(
  pin: string,
  fiber: Fiber.Fiber<A, E>,
  message: string
): Effect.Effect<Exit.Exit<A, E>, ConformanceViolation> => pollUntil(pin, () => fiber.pollUnsafe(), message)
