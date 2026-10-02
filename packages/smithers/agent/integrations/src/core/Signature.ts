/**
 * Constant-time HMAC-SHA256 webhook verification.
 *
 * A webhook signature is attacker-supplied, so the digest comparison must not
 * return early on the first differing byte: an early return turns the endpoint
 * into an oracle that leaks the expected digest one byte at a time.
 * {@link constantTimeEqual} therefore always scans the longer of the two
 * inputs and folds the length difference into the result, and it is the only
 * comparison {@link verifySignature} performs on digest material.
 *
 * The header formats every provider in this package uses are accepted:
 * GitHub's `sha256=<hex>` in `X-Hub-Signature-256`, bare hex digests,
 * and standard-base64 digests.
 *
 * @since 1.0.0
 */

import { createHmac } from "node:crypto"

const HEX = /^[0-9a-f]+$/i
// Standard base64, supported alongside hex digests.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * The prefix GitHub puts in front of its hex digest.
 *
 * @category constants
 * @since 1.0.0
 */
export const GITHUB_SIGNATURE_PREFIX = "sha256="

/**
 * Compares two byte strings without returning early on a mismatch.
 *
 * The loop always examines the longer input, and the length difference is
 * folded into the accumulator, so neither the position of the first differing
 * byte nor a length mismatch changes how much work the comparison does.
 *
 * @category verification
 * @since 1.0.0
 */
export const constantTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  let difference = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

/**
 * The lowercase hex HMAC-SHA256 of `payload` under `secret`.
 *
 * @category verification
 * @since 1.0.0
 */
export const computeHmacSha256Hex = (payload: string | Uint8Array, secret: string): string =>
  createHmac("sha256", secret).update(payload).digest("hex")

/**
 * What {@link verifySignature} needs to check one delivery.
 *
 * @category models
 * @since 1.0.0
 */
export interface VerifyOptions {
  /** The exact bytes the provider signed. Never the re-serialized JSON. */
  readonly payload: string | Uint8Array
  readonly secret: string
  readonly signature: string | null | undefined
  /**
   * A required prefix on the supplied signature, stripped before decoding.
   * Omit it to strip an optional `sha256=` and otherwise accept a bare digest.
   */
  readonly prefix?: string | undefined
}

const decodeHex = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "hex"))

const decodeBase64 = (value: string): Uint8Array | undefined => {
  try {
    return Uint8Array.from(Buffer.from(value, "base64"))
  } catch {
    return undefined
  }
}

/**
 * Whether `options.signature` is a valid HMAC-SHA256 of `options.payload`.
 *
 * Returns `false`, and never throws, for a missing signature, an empty secret, a
 * wrong prefix, an undecodable digest, and a digest that does not match.
 *
 * @category verification
 * @since 1.0.0
 */
export const verifySignature = (options: VerifyOptions): boolean => {
  const { payload, prefix, secret, signature } = options
  if (typeof signature !== "string" || signature.length === 0 || !secret) return false
  let provided = signature.trim()
  if (prefix !== undefined) {
    if (!provided.toLowerCase().startsWith(prefix.toLowerCase())) return false
    provided = provided.slice(prefix.length)
  } else if (provided.toLowerCase().startsWith(GITHUB_SIGNATURE_PREFIX)) {
    provided = provided.slice(GITHUB_SIGNATURE_PREFIX.length)
  }
  if (provided.length === 0) return false
  const expected = Uint8Array.from(createHmac("sha256", secret).update(payload).digest())
  if (provided.length === expected.length * 2 && HEX.test(provided)) {
    if (constantTimeEqual(expected, decodeHex(provided))) return true
  }
  if (BASE64.test(provided)) {
    const decoded = decodeBase64(provided)
    if (decoded !== undefined && constantTimeEqual(expected, decoded)) return true
  }
  return false
}
