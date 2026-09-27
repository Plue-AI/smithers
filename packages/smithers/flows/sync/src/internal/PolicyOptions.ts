/**
 * Execution-time validation of the numeric policies this package's
 * constructors accept.
 *
 * Every `Options` field is typed `number`, and TypeScript admits `NaN`,
 * `Infinity`, zero, and a negative under that type. Each of them disables the
 * thing it configures rather than tightening it: `maxFrameBytes: NaN` makes
 * every `bytes > maxFrameBytes` comparison false, so the ceiling silently
 * stops existing; `concurrency: 0` reaches a bounded `Stream.flatMap`
 * unchecked. A policy is checked once, where it enters, and a bad one is a
 * typed refusal rather than a bound that quietly does nothing.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import { SyncError } from "../SyncError.ts"

/**
 * The caller's value when it is a positive safe integer, the fallback when the
 * caller supplied none, and a typed `invalid_request` refusal otherwise. The
 * message names the option so the offending field is identifiable without the
 * error carrying anything but the scalar it was given.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const positiveInt = (
  name: string,
  value: number | undefined,
  fallback: number
): Effect.Effect<number, SyncError> => {
  if (value === undefined) return Effect.succeed(fallback)
  return Number.isSafeInteger(value) && value > 0 ? Effect.succeed(value) : Effect.fail(
    new SyncError({
      code: "invalid_request",
      message: `${name} must be a positive safe integer, not ${value}`
    })
  )
}

/**
 * A count carried by a REQUEST rather than by a policy: floored at one,
 * ceilinged at what the wire schema allows, and refused otherwise.
 *
 * `SyncProtocol` already bounds `limit` and `credit` on both sides, so a
 * decoded request cannot carry a bad one. An in-process caller that builds the
 * request value directly never meets that schema, and the TypeScript type it
 * does meet is `number`: `NaN`, zero, and a negative all satisfy it. Each of
 * them disables the bound instead of tightening it — `Math.min(NaN, ceiling)`
 * is `NaN`, every `length >= NaN` comparison answers false, and the value
 * reaches the journal as a page size — so the floor is checked here, where
 * both callers share one refusal and one sentence.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const requestCount = (
  name: string,
  value: number,
  ceiling: number
): Effect.Effect<number, SyncError> =>
  Number.isSafeInteger(value) && value > 0 ? Effect.succeed(Math.min(value, ceiling)) : Effect.fail(
    new SyncError({
      code: "invalid_request",
      message: `${name} must be a positive safe integer, not ${value}`
    })
  )

/**
 * {@link positiveInt} plus a ceiling, for a policy the WIRE also bounds.
 *
 * A value the local schema would accept and the wire schema would refuse is
 * not a transport failure, but that is what it looked like: the RPC client's
 * own decode failure arrived through the same channel a dropped connection
 * does, and the follow retried it under backoff forever. The refusal belongs
 * here, before a request is built.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const boundedInt = (
  name: string,
  value: number | undefined,
  fallback: number,
  maximum: number
): Effect.Effect<number, SyncError> =>
  Effect.flatMap(
    positiveInt(name, value, fallback),
    (accepted) =>
      accepted <= maximum ? Effect.succeed(accepted) : Effect.fail(
        new SyncError({
          code: "invalid_request",
          message: `${name} must be at most ${maximum}, not ${accepted}`
        })
      )
  )
