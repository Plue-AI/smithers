// Deep reviewed and polished by a human on 2026-08-31.

/**
 * Every stored-key representation this release understands.
 *
 * @since 0.1.0
 */

import { KeyV1 } from "./KeyV1.ts"

/**
 * Every stored-key representation this release understands.
 *
 * This is intentionally equal to {@link KeyV1}. A future format joins this
 * schema only when its complete representation and derivation are supported;
 * unknown `key<n>_` prefixes are rejected instead of guessed.
 *
 * @category schemas
 * @since 1.0.0
 */
export const StoredKey = KeyV1

/**
 * A stored key supported by this release.
 *
 * @category models
 * @since 1.0.0
 */
export type StoredKey = typeof StoredKey.Type
