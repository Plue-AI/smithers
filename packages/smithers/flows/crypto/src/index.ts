// Deep reviewed and polished by a human on 2026-08-31.

/**
 * Strict SHA-256 hashing through injected and synchronous entry points.
 *
 * Use `digest` for a direct Effect with typed `Sha256Error` failures,
 * `digestSync` for synchronous identity construction, `Digest` to validate an
 * existing digest, and `Sha256` where schema composition is the natural
 * boundary. Use `Identity` where the thing being digested is a function rather
 * than bytes.
 *
 * @since 0.1.0
 */

export * from "./Sha256.ts"

/**
 * Content identity for a plan-time function, digested from its source and its
 * declared inert captures.
 *
 * @category identity
 * @since 1.0.0
 */
export * as Identity from "./Identity.ts"
