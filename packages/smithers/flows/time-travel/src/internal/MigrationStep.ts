/**
 * Migration statement diagnostics.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import { error } from "../TimeTravelError.ts"

/**
 * Names the SQL object while retaining the driver failure.
 *
 * @since 0.1.0
 * @private
 */
export const step = <A, E, R>(object: string, statement: Effect.Effect<A, E, R>) =>
  statement.pipe(
    Effect.mapError((cause) => error("unknown", `time-travel migration failed creating ${object}`, cause))
  )
