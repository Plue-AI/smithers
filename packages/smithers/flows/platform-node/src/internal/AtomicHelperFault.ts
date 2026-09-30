/**
 * The atomic helper broke its protocol or its transport failed: a response that
 * is not framed, a field of the wrong shape, an answer over a bound, a helper
 * that never answered, or one that exited. `AtomicFileSystemProtocol.failure`
 * reports one as the `cause` of a `PlatformError`, so a caller classifies it by
 * `_tag` and `code`. {@link AtomicHelperRejection} carries the errno a helper
 * itself reported.
 * @since 1.0.0
 */

import { Schema } from "effect"

/**
 * Which rule of the helper protocol or transport was broken.
 * @category models
 * @since 1.0.0
 */
export const AtomicHelperFaultCode = Schema.Literals([
  "response_unframed",
  "response_tag_unknown",
  "response_length_invalid",
  "response_length_mismatch",
  "envelope_malformed",
  "field_malformed",
  "file_type_unknown",
  "payload_malformed",
  "read_limit_exceeded",
  "entries_malformed",
  "batch_malformed",
  "digest_malformed",
  "result_malformed",
  "operation_unsupported",
  "helper_timeout",
  "response_limit_exceeded",
  "helper_rejected",
  "helper_exited"
])

/**
 * The stable code of an {@link AtomicHelperFault}.
 * @category models
 * @since 1.0.0
 */
export type AtomicHelperFaultCode = typeof AtomicHelperFaultCode.Type

/**
 * The helper's response or process broke the protocol. The helper is treated as
 * untrusted, so the operation fails closed.
 * @category errors
 * @since 1.0.0
 */
export class AtomicHelperFault extends Schema.TaggedError<AtomicHelperFault>()(
  "@smthrs/platform-node/AtomicHelperFault",
  { code: AtomicHelperFaultCode, message: Schema.String }
) {
  override readonly name = "AtomicHelperFault"
}

/**
 * A helper fault with a stable code.
 * @category constructors
 * @since 1.0.0
 */
export const atomicHelperFault = (code: AtomicHelperFaultCode, message: string): AtomicHelperFault =>
  new AtomicHelperFault({ code, message })

/**
 * The errno a helper reported for a syscall it ran, in the shape the native
 * Node adapter's errors carry so callers that read `code` and `syscall` see the
 * same contract.
 * @category errors
 * @since 1.0.0
 */
export class AtomicHelperRejection extends Schema.TaggedError<AtomicHelperRejection>()(
  "@smthrs/platform-node/AtomicHelperRejection",
  {
    code: Schema.String,
    syscall: Schema.optional(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {
  override readonly name = "AtomicHelperRejection"
}
