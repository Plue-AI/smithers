/** Whole-tree exclusion for target execution.
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import * as Semaphore from "effect/Semaphore"

/**
 * Whole-tree snapshots exclude every peer. Admission stays held while a
 * writer waits for all work permits, so later readers cannot overtake it.
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const make = (jobs: number) =>
  Effect.gen(function*() {
    const admission = yield* Semaphore.make(1)
    const work = yield* Semaphore.make(jobs)
    return <A, E, R>(exclusive: boolean, body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
      const permits = exclusive ? jobs : 1
      return Effect.uninterruptibleMask((restore) =>
        Effect.acquireUseRelease(
          restore(admission.withPermit(work.take(permits))),
          () => restore(body),
          () => Effect.asVoid(work.release(permits))
        )
      )
    }
  })
