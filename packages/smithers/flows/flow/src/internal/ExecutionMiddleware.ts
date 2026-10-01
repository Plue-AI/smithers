/**
 * Internal interpreter seam for authoring combinators that retain execution
 * scope state around the ordinary body. No graph or runtime decision lives here.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"

/** Internal execution wrapper.
 * @private
 * @since 1.0.0
 */
export interface ExecutionMiddleware {
  readonly wrap: (
    payload: unknown,
    body: Effect.Effect<unknown, unknown, unknown>
  ) => Effect.Effect<unknown, unknown, unknown>
}

/** Flow-owned wrapper retained across interpreter registrations.
 * @private
 * @since 1.0.0
 */
export const ExecutionMiddleware = Context.Reference<ExecutionMiddleware | undefined>(
  "@smthrs/flow/internal/ExecutionMiddleware",
  { defaultValue: () => undefined }
)
