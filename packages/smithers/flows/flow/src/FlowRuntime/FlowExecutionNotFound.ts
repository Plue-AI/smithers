/**
 * Failure raised when `poll` addresses an execution the runtime has no record
 * of.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * Raised when `poll` is asked about an execution id the runtime never
 * recorded.
 *
 * This is a **typed failure**, never a defect, and never folded into the
 * success channel: `poll` answers `Option.none` for a known execution that has
 * not settled yet, so answering it for an unknown id as well would leave the
 * caller unable to distinguish "still running" from "no such execution". A
 * caller holding a stored execution id needs that distinction — a run that is
 * still in flight is waited on, one the runtime has no record of is a wiring
 * or retention problem to surface.
 *
 * The error is declared here because it is part of the `poll` contract this
 * package owns; every runtime — the in-memory engine and the durable
 * `@smthrs/engine-store` driver alike — raises it for an unknown id.
 *
 * @category errors
 * @since 0.1.0
 */
export class FlowExecutionNotFound extends Schema.TaggedError<FlowExecutionNotFound>()(
  "@smthrs/flow/FlowExecutionNotFound",
  {
    /** Stable public error code. */
    // This wire shape freezes at 1.0.0-rc.0.
    code: Schema.Literal("execution_not_found").pipe(
      Schema.withConstructorDefault(Effect.succeed("execution_not_found"))
    ),
    /** The execution id the runtime has no record of. */
    executionId: Schema.String
  }
) {
  /** @since 0.1.0 */
  override get message(): string {
    return `No flow execution is recorded under id "${this.executionId}"`
  }
}
