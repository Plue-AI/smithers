// Deep reviewed and polished by a human on 2026-08-31.

/**
 * The version-one stored-key representation.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

const keyV1Pattern = /^key1_[0-9a-f]{64}$/

/**
 * The exact persisted representation produced by the version-one derivation.
 *
 * Decoding validates and returns the input unchanged. It performs no hashing
 * and requires no `Crypto` service.
 *
 * @category schemas
 * @since 1.0.0
 */
export const KeyV1 = Schema.String.check(
  Schema.isPattern(keyV1Pattern, {
    expected: "key1_ followed by a 64-character lowercase hexadecimal SHA-256 digest"
  })
).pipe(Schema.brand("@smthrs/keys/Key"))

/**
 * A validated version-one stored key.
 *
 * @category models
 * @since 1.0.0
 */
export type KeyV1 = typeof KeyV1.Type
