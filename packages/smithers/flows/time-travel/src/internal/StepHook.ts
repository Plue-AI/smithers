/**
 * The fault-injection hook fork and rewind run before each named step.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import { error, type TimeTravelError } from "../TimeTravelError.ts"

/**
 * Runs `hook` for `step`, if there is one, reporting its failure as `unknown`
 * with `"<verb> failed at <step>"`.
 *
 * @since 0.1.0
 * @category combinators
 */
export const run = <Step extends string>(
  verb: string,
  hook: ((step: Step) => Effect.Effect<void, unknown>) | undefined,
  step: Step
): Effect.Effect<void, TimeTravelError> =>
  hook === undefined
    ? Effect.void
    : hook(step).pipe(Effect.mapError((cause) => error("unknown", `${verb} failed at ${step}`, cause)))
