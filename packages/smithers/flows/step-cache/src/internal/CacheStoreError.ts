/**
 * The error every cache tier reports, and its stable codes.
 *
 * It lives beneath the service module so the admission policy, the SQL tier,
 * and the HTTP tier can all raise it without importing one another.
 * `@smthrs/step-cache/CacheStore` re-exports it as part of the public contract.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * Stable error codes returned by cache persistence operations.
 *
 * @category models
 * @since 0.1.0
 */
export const CacheStoreErrorCode = Schema.Literals([
  "invalid_cache",
  "constraint",
  "decode_failed",
  "persistence_failed",
  "unknown"
])

/**
 * Stable error codes returned by cache persistence operations.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheStoreErrorCode = typeof CacheStoreErrorCode.Type

/**
 * Error raised by cache persistence operations.
 *
 * The identity names the package and the error, the convention
 * `@smthrs/database`'s `DatabaseError` follows, so it stays fixed wherever the
 * class is defined and no persisted or journaled tag changes with a move.
 *
 * @category errors
 * @since 0.1.0
 */
export class CacheStoreError extends Schema.TaggedError<CacheStoreError>()(
  "@smthrs/step-cache/CacheStoreError",
  {
    code: CacheStoreErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Builds a {@link CacheStoreError}, omitting `cause` when there is none.
 *
 * @private
 * @since 0.1.0
 */
export const error = (code: CacheStoreErrorCode, message: string, cause?: unknown): CacheStoreError =>
  new CacheStoreError({ code, message, ...(cause === undefined ? {} : { cause }) })
