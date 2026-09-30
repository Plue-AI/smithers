/**
 * A process cleanup policy that cannot be honoured: a termination signal the
 * platform does not define or cannot deliver, or a grace that overflows a
 * native timer. `policy` reports one as the `cause` of a `PlatformError`.
 *
 * @since 1.0.0
 */

import { Schema } from "effect"

/**
 * Which part of the policy was refused.
 *
 * @category models
 * @since 1.0.0
 */
export const ProcessCleanupPolicyErrorCode = Schema.Literals(["kill_signal_unsupported", "grace_out_of_range"])

/**
 * A cleanup policy outside what a native timer and the platform allow.
 *
 * @category errors
 * @since 1.0.0
 */
export class ProcessCleanupPolicyError extends Schema.TaggedError<ProcessCleanupPolicyError>()(
  "@smthrs/platform-node/ProcessCleanupPolicyError",
  { code: ProcessCleanupPolicyErrorCode, message: Schema.String }
) {
  override readonly name = "ProcessCleanupPolicyError"
}
