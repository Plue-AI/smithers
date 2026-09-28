/**
 * HMAC-SHA-256 signing primitives shared by the branch and workspace share
 * authorities.
 *
 * Both authorities sign a length-prefixed encoding of their claims: without
 * length prefixes a field ending in the separator could be re-cut into a
 * different, still-validly-signed claim set. Web Crypto is used directly so
 * the same module runs in the browser and on node, and signature comparison
 * is length-independent so a check leaks no prefix length.
 *
 * @since 0.1.0
 */

import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type { Access } from "../BranchProtocol.ts"
import { SyncError } from "../SyncError.ts"
import { causeText } from "./CauseText.ts"

const encoder = new TextEncoder()

/**
 * Length-prefixes each field so no two distinct field sequences share an
 * encoding.
 *
 * The prefix counts UTF-8 BYTES, not UTF-16 code units, because the bytes are
 * what {@link signHmac} covers. Counting code units let a two-byte field claim
 * length one, so the prefix no longer separated the fields the signature was
 * taken over.
 *
 * @category encoding
 * @since 0.1.0
 */
export const lengthPrefixed = (fields: ReadonlyArray<string>): string =>
  fields.map((field) => `${encoder.encode(field).length}:${field}`).join("")

const decoder = new TextDecoder()

/**
 * Whether a string is exactly what its own UTF-8 bytes decode back to.
 *
 * `TextEncoder` replaces every unpaired surrogate with U+FFFD, so two claim
 * sets differing only in a lone surrogate sign to identical bytes: a
 * capability minted for a lone-surrogate branch id verifies after its
 * `branchId` is rewritten to U+FFFD, which names a different branch. A length
 * prefix cannot separate them either, because both encode to the same three
 * bytes. The only correct answer is to refuse such a claim set before it is
 * signed, and the round trip is the exact question — does this string survive
 * the encoding the signature is taken over — rather than a proxy for it.
 *
 * @category encoding
 * @since 1.0.0-rc.0
 */
export const utf8RoundTrips = (value: string, bytes: Uint8Array): boolean => decoder.decode(bytes) === value

/**
 * Renders signature bytes as lowercase hex.
 *
 * @category encoding
 * @since 0.1.0
 */
export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * Length-independent comparison, so a signature check leaks no prefix length.
 *
 * @category comparison
 * @since 0.1.0
 */
export const constantTimeEquals = (left: string, right: string): boolean => {
  let difference = left.length ^ right.length
  // `charCodeAt` past the end is NaN, and `NaN | 0` is 0, so the loop reads
  // both strings to the longer length without an early return.
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left.charCodeAt(index) | 0) ^ (right.charCodeAt(index) | 0)
  }
  return difference === 0
}

/**
 * The fewest UTF-8 bytes a signing secret may carry: the HMAC-SHA-256 output
 * length, the minimum RFC 2104 section 3 recommends.
 *
 * Every capability carries its claims and their signature in the clear, so one
 * observed capability is an offline oracle for the secret. A short secret such
 * as `a` falls to exhaustive search in seconds, and the attacker then mints
 * branch and workspace capabilities of their own.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const minSecretBytes = 32

/**
 * Imports a raw secret as a non-extractable Web Crypto HMAC-SHA-256 signing
 * key. Fails with `invalid_request` when the secret does not survive UTF-8
 * (an unpaired surrogate) or is shorter than {@link minSecretBytes}, and with
 * a `SyncError` carrying the rejection as `cause` when Web Crypto refuses the
 * import.
 *
 * @category crypto
 * @since 0.1.0
 */
export const importHmacKey = (secret: string): Effect.Effect<CryptoKey, SyncError> => {
  // An unpaired surrogate encodes to U+FFFD's bytes, so two distinct
  // secrets would import the same key and rotating between them revokes
  // nothing. Refused here, as `signHmac` refuses such claims.
  const bytes = encoder.encode(secret)
  if (!utf8RoundTrips(secret, bytes)) {
    return Effect.fail(
      new SyncError({
        code: "invalid_request",
        message: "The HMAC signing secret carries an unpaired surrogate"
      })
    )
  }
  if (bytes.length < minSecretBytes) {
    return Effect.fail(
      new SyncError({
        code: "invalid_request",
        message: `The HMAC signing secret must be at least ${minSecretBytes} bytes of UTF-8`
      })
    )
  }
  return Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
        "sign"
      ]),
    catch: (cause) =>
      new SyncError({
        code: "unknown",
        message: "Web Crypto could not import the HMAC signing key",
        cause: causeText(cause)
      })
  })
}

/**
 * Signs a canonical claim encoding, returning the signature as lowercase hex.
 *
 * @category crypto
 * @since 0.1.0
 */
export const signHmac = (key: CryptoKey, canonical: string): Effect.Effect<string, SyncError> => {
  const bytes = encoder.encode(canonical)
  if (!utf8RoundTrips(canonical, bytes)) {
    return Effect.fail(
      new SyncError({
        code: "invalid_request",
        message: "Share claims carry an unpaired surrogate and cannot be signed"
      })
    )
  }
  return Effect.map(
    Effect.tryPromise({
      try: () => crypto.subtle.sign("HMAC", key, bytes),
      catch: (cause) =>
        new SyncError({
          code: "unknown",
          message: "Web Crypto could not sign the share claims",
          cause: causeText(cause)
        })
    }),
    (signature) => hex(new Uint8Array(signature))
  )
}

/**
 * The refusal both authorities issue. Declared once so a message added to one
 * authority's verification cannot land under a different error code in the
 * other.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export const unauthorized = (message: string): SyncError => new SyncError({ code: "unauthorized", message })

/**
 * One named signing key. The secret is `Redacted` so a keyring never renders
 * it into logs or inspection output.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Key {
  readonly kid: string
  readonly secret: Redacted.Redacted<string>
}

/**
 * A keyring: the key that signs new capabilities plus every key still
 * accepted for verification. Rotation adds a new active key and keeps the
 * retired one in `keys` until its outstanding capabilities expire.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Keyring {
  readonly activeKid: string
  readonly keys: ReadonlyArray<Key>
}

/**
 * A keyring whose every secret is already an imported Web Crypto key: the
 * signer for new capabilities, and the map a verifier selects a retired key
 * from by `kid`.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ImportedKeyring {
  readonly activeKid: string
  readonly active: CryptoKey
  readonly verification: ReadonlyMap<string, CryptoKey>
}

/**
 * Imports every key in a keyring, so a misconfigured ring — an unknown active
 * kid, a duplicate kid, or a key Web Crypto refuses — fails at construction
 * rather than at the first request. `subject` names the authority in the
 * refusal ("branch", "workspace").
 *
 * @category crypto
 * @since 1.0.0-rc.0
 */
export const importKeyring = (keyring: Keyring, subject: string): Effect.Effect<ImportedKeyring, SyncError> =>
  Effect.gen(function*() {
    // Copied BEFORE the first import, for the reason snapshots exist on the
    // verify path: the keyring belongs to the caller and every import below is
    // an await, so a `for..of` over the caller's own array re-reads it between
    // them. A splice landing in that window changed which keys the authority
    // ended up holding, and reading `activeKid` only after the loop let it name
    // a key the ring was validated with rather than the one the caller passed.
    const activeKid = keyring.activeKid
    const keys = keyring.keys.map((key): Key => ({ kid: key.kid, secret: key.secret }))
    const verification = new Map<string, CryptoKey>()
    for (const key of keys) {
      if (verification.has(key.kid)) {
        return yield* Effect.fail(
          new SyncError({ code: "invalid_request", message: `The ${subject} keyring names kid ${key.kid} twice` })
        )
      }
      verification.set(key.kid, yield* importHmacKey(Redacted.value(key.secret)))
    }
    const active = verification.get(activeKid)
    if (active === undefined) {
      return yield* Effect.fail(
        new SyncError({
          code: "invalid_request",
          message: `The ${subject} keyring's active kid names no key in the ring`
        })
      )
    }
    return { activeKid, active, verification }
  })

/**
 * The authorization both capability authorities run once their signing key is
 * selected: the signature, then the expiry, then the requested access.
 *
 * The order is the contract. A capability is authenticated before anything it
 * claims is reported back, so a forged claim set is refused as a bad signature
 * and never as a scope or an expiry. `scope` is the one check an authority
 * adds for itself — the branch authority's cross-branch refusal — and it runs
 * after the signature for exactly that reason.
 *
 * Both authorities called this sequence out by hand, which left a fix to the
 * expiry boundary or the read-only refusal landing in one and not the other.
 *
 * @category crypto
 * @since 1.0.0-rc.0
 */
export const verifyClaims = (options: {
  readonly key: CryptoKey
  readonly canonical: string
  readonly signature: string
  readonly expiresAtMs: number
  readonly granted: Access
  readonly requested: Access
  /** The refused thing, named as it appears in the message: "The share capability". */
  readonly subject: string
  readonly scope?: Effect.Effect<void, SyncError>
}): Effect.Effect<void, SyncError> =>
  Effect.gen(function*() {
    const expected = yield* signHmac(options.key, options.canonical)
    if (!constantTimeEquals(expected, options.signature)) {
      return yield* Effect.fail(unauthorized(`${options.subject} signature is invalid`))
    }
    if (options.scope !== undefined) yield* options.scope
    const nowMs = yield* Clock.currentTimeMillis
    if (nowMs >= options.expiresAtMs) {
      return yield* Effect.fail(unauthorized(`${options.subject} has expired`))
    }
    if (options.requested === "write" && options.granted !== "write") {
      return yield* Effect.fail(unauthorized(`${options.subject} is read-only`))
    }
  })
