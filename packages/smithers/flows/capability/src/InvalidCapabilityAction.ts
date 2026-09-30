/**
 * The failure of rendering a capability with an action outside the vocabulary.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"

/**
 * An action outside the closed vocabulary was handed to {@link format}.
 * `code` is always `invalid_capability_action`.
 *
 * @since 0.1.0
 * @category errors
 */
export class InvalidCapabilityAction extends Schema.TaggedError<InvalidCapabilityAction>()(
  "@smthrs/capability/InvalidCapabilityAction",
  { code: Schema.Literal("invalid_capability_action"), message: Schema.String }
) {}
