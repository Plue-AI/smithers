/**
 * RFC 7636 PKCE parameters for the OAuth authorization-code flow.
 *
 * The GitHub OAuth apps both run the authorization-code flow from a
 * public client, where an intercepted authorization code is otherwise
 * redeemable by whoever caught it. PKCE binds the code to the verifier that
 * requested it: the client sends `S256(verifier)` up front and the verifier
 * itself only at redemption.
 *
 * @since 1.0.0
 */

import { createHash, randomBytes } from "node:crypto"

const UNRESERVED = /^[A-Za-z0-9\-._~]+$/
const MIN_LENGTH = 43
const MAX_LENGTH = 128
const DEFAULT_RANDOM_BYTES = 32
const MIN_RANDOM_BYTES = 32
const MAX_RANDOM_BYTES = 96

const base64UrlNoPadding = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")

/**
 * A complete S256 PKCE parameter set.
 *
 * @category models
 * @since 1.0.0
 */
export interface PkcePair {
  readonly codeVerifier: string
  readonly codeChallenge: string
  readonly codeChallengeMethod: "S256"
}

/**
 * A high-entropy `code_verifier`.
 *
 * `byteLength` is the entropy drawn, not the string length: 32 bytes produce
 * the 43-character minimum and 96 bytes the 128-character maximum RFC 7636
 * allows. Anything outside 32..96 bytes would encode outside that range.
 *
 * @category constructors
 * @since 1.0.0
 */
export const createCodeVerifier = (byteLength: number = DEFAULT_RANDOM_BYTES): string => {
  if (!Number.isInteger(byteLength)) throw new TypeError("PKCE code_verifier byteLength must be an integer")
  if (byteLength < MIN_RANDOM_BYTES || byteLength > MAX_RANDOM_BYTES) {
    throw new RangeError("PKCE code_verifier byteLength must be 32..96 bytes")
  }
  return base64UrlNoPadding(randomBytes(byteLength))
}

/**
 * The S256 `code_challenge` for a verifier: base64url of its SHA-256, unpadded.
 *
 * @category constructors
 * @since 1.0.0
 */
export const deriveCodeChallenge = (codeVerifier: string): string => {
  if (typeof codeVerifier !== "string") throw new TypeError("PKCE code_verifier must be a string")
  if (codeVerifier.length < MIN_LENGTH || codeVerifier.length > MAX_LENGTH) {
    throw new RangeError("PKCE code_verifier must be 43..128 characters")
  }
  if (!UNRESERVED.test(codeVerifier)) {
    throw new TypeError("PKCE code_verifier must contain only RFC 7636 unreserved characters")
  }
  return base64UrlNoPadding(createHash("sha256").update(codeVerifier, "ascii").digest())
}

/**
 * A fresh verifier with its challenge.
 *
 * @category constructors
 * @since 1.0.0
 */
export const createPkcePair = (byteLength: number = DEFAULT_RANDOM_BYTES): PkcePair => {
  const codeVerifier = createCodeVerifier(byteLength)
  return { codeVerifier, codeChallenge: deriveCodeChallenge(codeVerifier), codeChallengeMethod: "S256" }
}
