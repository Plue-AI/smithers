/**
 * Faults of the journal's own background maintenance. They are logged and
 * damped, never surfaced to a caller's write, so a log reader classifies one by
 * `_tag` and `code` instead of a message.
 *
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"

/**
 * Which background step refused.
 *
 * @category models
 * @since 1.0.0
 */
export const JournalInternalFaultCode = Schema.Literals(["compaction_capture_timeout"])

/**
 * The stable code of a {@link JournalInternalFault}.
 *
 * @category models
 * @since 1.0.0
 */
export type JournalInternalFaultCode = typeof JournalInternalFaultCode.Type

/**
 * A post-commit maintenance step that refused.
 *
 * @category errors
 * @since 1.0.0
 */
export class JournalInternalFault
  extends Schema.TaggedError<JournalInternalFault>()("@smthrs/journal/JournalInternalFault", {
    code: JournalInternalFaultCode,
    message: Schema.String
  })
{
  override readonly name = "JournalInternalFault"
}
