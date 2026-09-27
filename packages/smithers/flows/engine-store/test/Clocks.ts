/**
 * Wall clocks for tests that have to observe a moment the ambient clock is not
 * at.
 *
 * `@smthrs/run-store` decides lease staleness and stamps ownership from the
 * injected Effect `Clock`, never from the caller's `nowMs` argument, so a test
 * that needs a lease to look expired has to move the clock the store reads
 * rather than pass a later number. `TestClock` only moves forward and most of
 * these suites run against the real clock, so the reading is supplied
 * directly.
 */
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"

/**
 * A clock fixed at `millis`, with monotonic readings derived from the same
 * value so an elapsed-time measurement taken under it is zero rather than
 * arbitrary.
 */
export const clockAt = (millis: number): Clock.Clock => {
  const nanos = BigInt(millis) * 1_000_000n
  return {
    currentTimeMillisUnsafe: () => millis,
    currentTimeMillis: Effect.succeed(millis),
    currentTimeNanosUnsafe: () => nanos,
    currentTimeNanos: Effect.succeed(nanos),
    monotonicTimeNanosUnsafe: () => nanos,
    monotonicTimeNanos: Effect.succeed(nanos),
    sleep: (duration) => Clock.Clock.defaultValue().sleep(duration)
  }
}

/**
 * Runs `effect` as if the wall clock read `millis`.
 *
 * Use it around one store call, never around a whole scenario: everything
 * inside sees a frozen clock, which is exactly what makes it a statement about
 * the moment the store observes and nothing else.
 */
export const at = <A, E, R>(millis: number, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Clock.Clock, clockAt(millis))
