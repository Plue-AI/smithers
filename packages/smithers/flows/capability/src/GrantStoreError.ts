/**
 * The grant-store failure.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"
import { GrantStoreErrorCode } from "./GrantStoreErrorCode.ts"

/**
 * A failure to register, persist, or resolve a grant request.
 *
 * `message` and `cause` are optional operation context for persistence
 * adapters; callers branch on the stable `code`.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class GrantStoreError extends Schema.TaggedError<GrantStoreError>()(
  "@smthrs/capability/GrantStoreError",
  {
    code: GrantStoreErrorCode,
    message: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect())
  }
) {}
