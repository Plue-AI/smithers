/**
 * Defines the `ConcurrentKeylessDispatch` action failure.
 *
 * The `_tag` string was settled under `@smthrs/flow/` for 1.0.0-rc.0. The RC
 * makes no compatibility promise to 0.x journals, and the tag freezes when
 * the RC ships.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * Two ordinal-keyed invocations of one allocation scope were in flight
 * concurrently, either keyless invocations of one declaration or same-key
 * invocations at a non-sealed tier (issue #130), so their ordinals, and with
 * them their step keys, attempt rows, and recorded outcomes, would be
 * assigned by fiber arrival order. A crash-resume that replays the fibers in
 * the opposite order would silently hand one invocation the other's recorded
 * outcome (issue #111); Temporal fails such replays with a nondeterminism
 * error, and the engine refuses the hazard up front instead of detecting it
 * after the corruption. Declare an `idempotencyKey` *distinguishing* the
 * invocations to dispatch them concurrently; a sealed action with a key
 * takes a pure cache key and is exempt.
 *
 * @category errors
 * @since 0.1.0
 */
export class ConcurrentKeylessDispatch extends Schema.TaggedError<ConcurrentKeylessDispatch>()(
  "@smthrs/flow/ConcurrentKeylessDispatch",
  {
    code: Schema.Literal("concurrent_keyless_dispatch").pipe(
      Schema.withConstructorDefault(Effect.succeed("concurrent_keyless_dispatch"))
    ),
    actionName: Schema.String
  }
) {}
