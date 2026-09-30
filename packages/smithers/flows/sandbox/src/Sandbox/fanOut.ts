/**
 * Forks a bounded set of child machines from one session.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import type { Scope } from "effect/Scope"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "./Session.ts"

/**
 * The most children one fan-out may start, the same hard cap Smithers Cloud
 * puts on a user's live child workspaces.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxFanOut = 128

/**
 * How many children to fork, and how many forks may run at once.
 *
 * @category models
 * @since 1.0.0
 */
export interface FanOutOptions {
  /** Children to fork: an integer from 1 to {@link maxFanOut}. */
  readonly count: number
  /** Forks in flight at once; defaults to 8. */
  readonly concurrency?: number | undefined
}

/**
 * Forks `count` children from `parent`, keyed `<parent id>/child-<n>`.
 *
 * Every child starts from the parent's tree without its credentials and is
 * released when the acquiring scope closes, so a fan-out inside the parent's
 * scope never outlives the parent. A failed fork fails the whole fan-out;
 * children already forked are still released by the scope. A count outside
 * 1..{@link maxFanOut} throws a `RangeError`; a parent whose provider cannot
 * fork fails with `unavailable`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const fanOut = (
  parent: Session,
  options: FanOutOptions
): Effect.Effect<ReadonlyArray<Session>, ProviderError, Scope> => {
  const { count, concurrency = 8 } = options
  if (!Number.isSafeInteger(count) || count < 1 || count > maxFanOut) {
    throw new RangeError(`fanOut: count must be an integer from 1 to ${maxFanOut}`)
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("fanOut: concurrency must be a positive integer")
  }
  const fork = parent.fork
  if (fork === undefined) {
    return Effect.fail(
      new ProviderError({ code: "unavailable", message: `the machine behind session ${parent.id} cannot fork` })
    )
  }
  return Effect.forEach(
    Array.from({ length: count }, (_, index) => `${parent.id}/child-${index}`),
    (key) => fork(key),
    { concurrency }
  )
}
