/**
 * A process supervision failure that is not a native errno: a supervisor that
 * broke its status protocol, a bound that was exceeded, or a cleanup that could
 * not be verified. `ProcessSupervisor` and `WindowsProcessJob` report one as the
 * `cause` of a `PlatformError`, so a caller classifies it by `_tag` and `code`.
 * @since 1.0.0
 */

import { Schema } from "effect"

/**
 * Which supervision rule failed.
 * @category models
 * @since 1.0.0
 */
export const ProcessFaultCode = Schema.Literals([
  "supervisor_timeout",
  "runtime_unsupported",
  "identity_mismatch",
  "control_channel_closed",
  "configuration_too_large",
  "outcome_missing",
  "status_too_large",
  "status_invalid",
  "status_unknown",
  "cleanup_unverified",
  "owner_identity_missing"
])

/**
 * The stable code of a {@link ProcessFault}.
 * @category models
 * @since 1.0.0
 */
export type ProcessFaultCode = typeof ProcessFaultCode.Type

/**
 * A supervision failure with a stable code.
 * @category errors
 * @since 1.0.0
 */
export class ProcessFault extends Schema.TaggedError<ProcessFault>()("@smthrs/platform-node/ProcessFault", {
  code: ProcessFaultCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {
  override readonly name = "ProcessFault"
}

/**
 * A process fault with a stable code.
 * @category constructors
 * @since 1.0.0
 */
export const processFault = (
  code: ProcessFaultCode,
  message: string,
  detail: { readonly cause?: unknown } = {}
): ProcessFault => new ProcessFault({ ...detail, code, message })

/**
 * A native process failure as data: the errno (`code`), `syscall`, `path` or
 * `signal` the platform or the isolated owner reported, kept as fields of the
 * `PlatformError` cause so callers read the platform's own vocabulary.
 * `reason` is the stable code the owner program gave its own fault.
 * @category errors
 * @since 1.0.0
 */
export class NativeProcessError extends Schema.TaggedError<NativeProcessError>()(
  "@smthrs/platform-node/NativeProcessError",
  {
    message: Schema.String,
    code: Schema.optional(Schema.String),
    errno: Schema.optional(Schema.Number),
    reason: Schema.optional(Schema.String),
    syscall: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
    signal: Schema.optional(Schema.String)
  }
) {
  override readonly name = "NativeProcessError"
}
