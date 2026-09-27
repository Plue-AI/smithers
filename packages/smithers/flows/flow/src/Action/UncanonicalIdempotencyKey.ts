/**
 * Defines the `UncanonicalIdempotencyKey` action failure.
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
 * A caller-declared object-form `idempotencyKey` carried material canonical
 * serialization rejects. The declaration can be fixed, and the error is
 * non-retryable: the same declaration
 * derives the same rejection on every attempt, so the body never runs.
 *
 * @category errors
 * @since 0.1.0
 */
export class UncanonicalIdempotencyKey extends Schema.TaggedError<UncanonicalIdempotencyKey>()(
  "@smthrs/flow/UncanonicalIdempotencyKey",
  {
    code: Schema.Literal("uncanonical_idempotency_key").pipe(
      Schema.withConstructorDefault(Effect.succeed("uncanonical_idempotency_key"))
    ),
    actionName: Schema.String,
    /** Stable reason identifying an RFC 8785 canonicalization failure. */
    reason: Schema.String,
    /** The path of the offending value inside the declared identity. */
    path: Schema.String,
    message: Schema.String
  }
) {}
