/**
 * Defines the `InfraInterrupt` action failure.
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
 * Marker an action implementation or adapter raises for an infrastructure
 * event it wants the action's `interruptRetryPolicy` to retry. Shipped engines
 * do not synthesize it from ordinary fiber interruption.
 *
 * @category errors
 * @since 0.1.0
 */
export class InfraInterrupt extends Schema.TaggedError<InfraInterrupt>()(
  "@smthrs/flow/InfraInterrupt",
  {
    code: Schema.Literal("infra_interrupt").pipe(
      Schema.withConstructorDefault(Effect.succeed("infra_interrupt"))
    ),
    reason: Schema.optional(Schema.Unknown)
  }
) {}
