/// <reference lib="es2024.string" />
/**
 * Total SHA-256 digests over JavaScript strings.
 *
 * @since 0.1.0
 */

import * as CoreDigest from "@smthrs/core/Digest"

/**
 * Replaces every unpaired UTF-16 surrogate with U+FFFD.
 *
 * @category normalization
 * @since 0.1.0
 */
export const wellFormed = (value: string): string => value.isWellFormed() ? value : value.toWellFormed()

/**
 * Returns the full lowercase SHA-256 digest of a JavaScript string.
 *
 * Unpaired UTF-16 surrogates are replaced with U+FFFD before delegating to
 * `Digest.digest`, making this helper total for every JavaScript string.
 *
 * @category hashing
 * @since 0.1.0
 */
export const digest = (text: string): string => CoreDigest.digest(wellFormed(text))
