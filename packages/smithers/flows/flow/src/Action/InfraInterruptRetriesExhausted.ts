/**
 * Defines the `InfraInterruptRetriesExhausted` action failure.
 *
 * The `_tag` string was settled under `@smthrs/flow/` for 1.0.0-rc.0. The RC
 * makes no compatibility promise to 0.x journals, and the tag freezes when
 * the RC ships.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { InfraInterrupt } from "./InfraInterrupt.ts"

/**
 * An action spent its infrastructure-interrupt retry policy without reaching
 * an ordinary success or failure.
 *
 * @category errors
 * @since 0.1.0
 */
export class InfraInterruptRetriesExhausted extends Schema.TaggedError<InfraInterruptRetriesExhausted>()(
  "@smthrs/flow/InfraInterruptRetriesExhausted",
  {
    code: Schema.Literal("infra_interrupt_retries_exhausted").pipe(
      Schema.withConstructorDefault(Effect.succeed("infra_interrupt_retries_exhausted"))
    ),
    actionName: Schema.String,
    attempts: Schema.Number,
    interrupt: InfraInterrupt,
    /**
     * The sentence an operator reads out of a rendered cause. The typed fields
     * beside it are what a log pipeline keys on.
     */
    message: Schema.String
  }
) {}
