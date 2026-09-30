/**
 * The reasons a named Microsandbox machine is not reattached to.
 *
 * `openMachine` raises one inside its attempt, and the provider reports it as
 * the `cause` of a `ProviderError`, so a caller reads the stable `code`
 * instead of parsing the message.
 *
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"

/**
 * Why a reattach was refused.
 *
 * @category models
 * @since 1.0.0
 */
export const MicrosandboxReattachRefusalCode = Schema.Literals([
  "network_mismatch",
  "limits_mismatch",
  "ownership_not_recorded"
])

/**
 * A machine that cannot be reattached to under this session's configuration.
 *
 * @category errors
 * @since 1.0.0
 */
export class MicrosandboxReattachRefusal
  extends Schema.TaggedError<MicrosandboxReattachRefusal>()("@smthrs/sandbox/MicrosandboxReattachRefusal", {
    code: MicrosandboxReattachRefusalCode,
    message: Schema.String
  })
{
  override readonly name = "MicrosandboxReattachRefusal"
}
