/**
 * Defines the `IrreversibleRetryRequiresIdempotencyKey` action failure.
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
 * An irreversible action attempted a retry without declaring an
 * idempotency key.
 *
 * @category errors
 * @since 0.1.0
 */
export class IrreversibleRetryRequiresIdempotencyKey
  extends Schema.TaggedError<IrreversibleRetryRequiresIdempotencyKey>()(
    "@smthrs/flow/IrreversibleRetryRequiresIdempotencyKey",
    {
      code: Schema.Literal("irreversible_retry_requires_idempotency_key").pipe(
        Schema.withConstructorDefault(Effect.succeed("irreversible_retry_requires_idempotency_key"))
      ),
      actionName: Schema.String,
      attempt: Schema.Number
    }
  )
{}
