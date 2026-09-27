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
) {}
