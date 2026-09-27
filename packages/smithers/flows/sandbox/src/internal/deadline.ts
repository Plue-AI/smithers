/**
 * Bounds an effect on the wall clock.
 *
 * Both conformance suites bound a check with it, and `RemoteChildProcessSpawner`
 * bounds the signal a closing scope sends, so a provider that never answers
 * cannot hang a caller under any clock.
 *
 * @since 0.1.0
 */

import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"

/**
 * Completes after `duration` on the platform's own timer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const elapsed = (duration: Duration.Input): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(duration))
    return Effect.sync(() => clearTimeout(timer))
  })

/**
 * A deadline on the wall clock, not the ambient `Clock`.
 *
 * Provider test suites commonly run under a frozen test clock (`it.effect`
 * provides one), where a clock-based timeout never fires; a conformance suite
 * whose hang protection depends on the very layer a host may freeze would
 * hang exactly when it is needed. The timer here is the platform's own, so a
 * stuck check is convicted under any clock. `boundedCheck` races observation
 * of the check against this failure and requests cleanup without waiting for
 * uninterruptible provider acquisition or finalizers.
 *
 * @category constructors
 * @since 0.1.0
 */
export const expired = (deadline: Duration.Input): Effect.Effect<never, ProviderError> =>
  Effect.flatMap(elapsed(deadline), () => Effect.fail(timedOut(deadline)))

/**
 * The failure a check that ran out of time reports.
 *
 * Shared with {@link expired} so a suite that abandons a hung check rather
 * than racing it still convicts it with the same sentence an adapter author
 * has learned to read.
 *
 * @category constructors
 * @since 0.1.0
 */
export const timedOut = (deadline: Duration.Input): ProviderError =>
  new ProviderError({
    code: "timeout",
    message: `the check did not finish within ${Duration.toMillis(deadline)} milliseconds`
  })

/**
 * How long any single conformance check may take before it is convicted as
 * hung. Below bundled provider test budgets; slow machine provisioning must
 * opt into a longer deadline and a matching whole-suite test budget.
 *
 * @category models
 * @since 0.1.0
 */
export const defaultCheckTimeout: Duration.Input = Duration.seconds(10)
