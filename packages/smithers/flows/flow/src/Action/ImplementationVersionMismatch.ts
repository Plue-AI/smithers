/**
 * Defines the `ImplementationVersionMismatch` action failure.
 *
 * The `_tag` string was settled under `@smthrs/flow/` for 1.0.0-rc.0. The RC
 * makes no compatibility promise to 0.x journals, and the tag freezes when
 * the RC ships.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * A handler registration does not attest the declaration's implementation version.
 *
 * @category errors
 * @since 0.1.0
 */
export class ImplementationVersionMismatch extends Schema.TaggedError<ImplementationVersionMismatch>()(
  "@smthrs/flow/ImplementationVersionMismatch",
  {
    actionName: Schema.String,
    declaredVersion: Schema.NullOr(Schema.String),
    registeredVersion: Schema.NullOr(Schema.String),
    message: Schema.String
  }
) {}
