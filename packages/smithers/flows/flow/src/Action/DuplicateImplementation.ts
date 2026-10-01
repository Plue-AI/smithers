/**
 * Defines the `DuplicateImplementation` action failure.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * Two implementations competed for one action tag without an explicit override.
 * @category errors
 * @since 0.1.0
 */
export class DuplicateImplementation extends Schema.TaggedError<DuplicateImplementation>()(
  "@smthrs/flow/Action/DuplicateImplementation",
  { name: Schema.String }
) {
  // The `name` field shadows `Error.name`, so without a message a recorded
  // defect reads only as the bare action tag.
  /** @since 1.0.0 */
  override get message(): string {
    return `Action "${this.name}" already has an implementation in this registry; provide its layer once, or pass override: true to replace it`
  }
}
