/**
 * Bounds provider cleanup independently of the caller's clock.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { elapsed } from "./deadline.ts"

/**
 * Gives one cleanup operation five seconds, then warns with its resource name.
 * Observe a detached fiber: racing the operation itself would await its
 * interruption, including any uninterruptible transport acquisition or release.
 * Interruption is requested without waiting when observation ends.
 *
 * @category constructors
 * @since 0.1.0
 */
export const finalizeWithin = <R>(
  cleanup: Effect.Effect<void, never, R>,
  resource: string
): Effect.Effect<void, never, R> =>
  Effect.uninterruptible(Effect.gen(function*() {
    const running = yield* Effect.forkDetach(Effect.interruptible(cleanup))
    yield* Effect.raceFirst(
      Fiber.join(running),
      Effect.andThen(elapsed(5_000), Effect.logWarning("sandbox teardown timed out", { resource, timeoutMs: 5_000 }))
    ).pipe(Effect.ensuring(Effect.forkDetach(Fiber.interrupt(running), { startImmediately: true })))
  }))
