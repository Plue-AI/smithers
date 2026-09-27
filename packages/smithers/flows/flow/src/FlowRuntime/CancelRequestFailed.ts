/**
 * Failure raised when a cancellation request could not be made durable.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * Raised when `interrupt` could not durably record its cancellation request.
 *
 * This is a **typed failure**, never a defect, and never swallowed. A durable
 * runtime records operator intent before it interrupts anything: the record is
 * what tells the interruption handler that a cancellation happened rather than
 * a shutdown (issue #26), what survives the requesting process dying, and what
 * a parked or cross-process run is eventually cancelled by. A durable runtime
 * records the run and all linked descendants in one transaction. A storage
 * failure on any write leaves every request unchanged: the run is still
 * running and still cancellable, so the caller sees this typed failure and can
 * retry instead of receiving false success.
 *
 * A runtime that keeps no durable cancellation record — the in-memory engine —
 * never raises it, so its `Effect<void>` remains assignable to the widened
 * contract and no in-memory caller has to handle anything.
 *
 * The same error carries the durable engine's refusal of `interruptUnsafe`.
 * That port promises forced cancellation without cleanup, and the durable
 * engine has no such path — it has one cancellation path, `interrupt`, which
 * is durable and cascades to linked children. Answering the unsafe request
 * with the safe one silently reinterpreted it, so 1.0.0-rc.0 refuses it with
 * code `unsafe_interrupt_unsupported`. It is the same failure type because it
 * is the same question — "your cancellation request was not carried out" —
 * and the code says which of the two reasons applies.
 *
 * The error is declared here because it is part of the `interrupt` contract
 * this package owns; the durable implementation lives in
 * `@smthrs/engine-store`'s `RunDriver`.
 *
 * @category errors
 * @since 0.1.0
 */
export class CancelRequestFailed extends Schema.TaggedError<CancelRequestFailed>()(
  "@smthrs/flow/CancelRequestFailed",
  {
    /**
     * Stable public error code. `cancel_request_failed` is a storage failure
     * on a supported request; `unsafe_interrupt_unsupported` is the durable
     * engine refusing `interruptUnsafe`, which it does not implement.
     */
    code: Schema.Literals(["cancel_request_failed", "unsafe_interrupt_unsupported"]),
    /** The execution whose cancellation could not be recorded. */
    executionId: Schema.String,
    /** The storage failure, rendered for an operator. */
    reason: Schema.String
  }
) {}
