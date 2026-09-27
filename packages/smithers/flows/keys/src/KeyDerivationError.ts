// Deep reviewed and polished by a human on 2026-08-31.

/**
 * The typed failure key derivation reports, and its stable codes.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * Stable failure codes returned by `deriveKey`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const KeyDerivationErrorCode = Schema.Literals([
  "canonicalization_failed",
  "digest_failed"
])

/**
 * Stable failure codes returned by `deriveKey`.
 *
 * @category models
 * @since 1.0.0
 */
export type KeyDerivationErrorCode = typeof KeyDerivationErrorCode.Type

/**
 * A safe, typed failure from canonicalization or injected hashing.
 *
 * `message` never contains the input. `cause` retains the original schema or
 * crypto failure for diagnostics.
 *
 * @category errors
 * @since 1.0.0
 */
export class KeyDerivationError extends Schema.TaggedError<KeyDerivationError>()(
  "@smthrs/keys/KeyDerivationError",
  {
    code: KeyDerivationErrorCode,
    message: Schema.String,
    cause: Schema.Unknown
  }
) {}
