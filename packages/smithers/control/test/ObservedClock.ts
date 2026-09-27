import { Clock, Duration, Effect } from "effect"

/** Observe timer registration before advancing a test clock past remote SQL. */
export const make = Effect.map(Clock.Clock, (clock) => {
  const deadlines = new Set<number>()
  return {
    scheduled: (deadline: number) => Effect.sync(() => deadlines.has(deadline)),
    clock: {
      ...clock,
      sleep: (duration: Duration.Duration) =>
        Effect.suspend(() => {
          const deadline = clock.currentTimeMillisUnsafe() + Duration.toMillis(duration)
          deadlines.add(deadline)
          return clock.sleep(duration).pipe(Effect.ensuring(Effect.sync(() => deadlines.delete(deadline))))
        })
    }
  }
})
