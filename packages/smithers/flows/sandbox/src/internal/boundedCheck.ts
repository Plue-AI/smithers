/**
 * Observes one conformance check under a wall-clock deadline.
 *
 * @since 0.1.0
 */

import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import type { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { expired } from "./deadline.ts"

/**
 * Races observation of a detached check, never its resource-owning scope.
 * Acquisition and release can be uninterruptible, so waiting for the check's
 * interruption would let teardown defeat the deadline. On timeout or caller
 * cancellation we initiate interruption in a second detached fiber. That
 * interruption fiber observes the check until cleanup finishes; reporting does
 * not await it.
 * The mask installs cleanup before the observation can be interrupted.
 *
 * @category constructors
 * @since 0.1.0
 */
export const boundedCheck = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  deadline: Duration.Input
): Effect.Effect<Exit.Exit<A, E | ProviderError>, never, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function*() {
      const running = yield* Effect.forkDetach(Effect.exit(restore(effect)))
      return yield* restore(
        Effect.raceFirst(Fiber.join(running), Effect.exit(expired(deadline)))
      ).pipe(Effect.ensuring(Effect.forkDetach(Fiber.interrupt(running), { startImmediately: true })))
    })
  )
