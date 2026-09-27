/**
 * AES-256-GCM credential encryption over the Web Crypto API.
 *
 * One adapter serves both hosts the project supports: `globalThis.crypto.subtle`
 * is the browser's own API and has been Node's since v19, so this module
 * imports nothing from `node:*` and still runs unmodified on the server. A host
 * without Web Crypto, such as an old runtime or a locked-down worker, fails
 * with the typed `Unavailable`, never a defect. A key that is not 32
 * base64-encoded bytes fails with `InvalidInput`. A record that does not open
 * fails with `PersistenceError` on operation `credential.open`, which names
 * whether the stored nonce was malformed or the ciphertext failed
 * authentication (a different key, changed metadata, or tampered bytes).
 *
 * The key is host-managed and supplied at layer construction. It is held as a
 * non-extractable `CryptoKey`, so it cannot be read back out of the cipher, and
 * it never reaches `CredentialStore`.
 *
 * @since 0.1.0
 */

import { canonicalize } from "@smthrs/canonical"
import { Effect, Layer, Redacted } from "effect"
import { InvalidInput, PersistenceError, type Unavailable } from "./ControlError.ts"
import * as CredentialCipher from "./CredentialCipher.ts"

const algorithm = "AES-GCM"
const nonceBytes = 12
const contextFormatVersion = 1

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const fromBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const subtle = (): Effect.Effect<SubtleCrypto, Unavailable> =>
  Effect.suspend(() => {
    const available = globalThis.crypto as Crypto | undefined
    return available?.subtle === undefined
      ? Effect.fail(CredentialCipher.unavailable())
      : Effect.succeed(available.subtle)
  })

const randomNonce = (): Effect.Effect<Uint8Array<ArrayBuffer>, Unavailable> =>
  Effect.suspend(() => {
    const available = globalThis.crypto as Crypto | undefined
    return available?.getRandomValues === undefined
      ? Effect.fail(CredentialCipher.unavailable())
      : Effect.succeed(available.getRandomValues(new Uint8Array(nonceBytes)))
  })

const encodeContext = (context: CredentialCipher.Context): Effect.Effect<Uint8Array<ArrayBuffer>, Unavailable> =>
  Effect.try({
    try: () => {
      // Canonical JSON names and escapes each field, so embedded delimiters
      // cannot make two metadata tuples authenticate as the same bytes. The
      // explicit format version makes a future byte contract distinguishable.
      const document = canonicalize({
        formatVersion: contextFormatVersion,
        id: context.id,
        name: context.name,
        version: context.version
      })
      return new TextEncoder().encode(document)
    },
    catch: CredentialCipher.unavailable
  })

const invalidKey = (): InvalidInput => new InvalidInput({ issue: "Credential key must be 32 base64-encoded bytes" })

const unopenable = (reason: "malformed_nonce" | "authentication_failed", cause: unknown): PersistenceError =>
  new PersistenceError({
    operation: "credential.open",
    message: reason === "malformed_nonce"
      ? "Stored credential nonce is malformed"
      : "Credential failed authentication: a different key, changed metadata, or tampered ciphertext",
    cause
  })

/**
 * Host-managed key material for the cipher.
 *
 * `key` is 32 raw bytes, base64-encoded, held redacted so it cannot be printed
 * or serialized by accident.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly key: Redacted.Redacted<string>
}

/**
 * Imports the host key and constructs the cipher.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): Effect.Effect<CredentialCipher.Service, Unavailable | InvalidInput> =>
  Effect.gen(function*() {
    const crypto = yield* subtle()
    const raw = yield* Effect.try({
      try: () => fromBase64(Redacted.value(options.key)),
      catch: invalidKey
    })
    if (raw.length !== 32) return yield* Effect.fail(invalidKey())
    const key = yield* Effect.tryPromise({
      try: () => crypto.importKey("raw", raw, algorithm, false, ["encrypt", "decrypt"]),
      catch: CredentialCipher.unavailable
    })

    return CredentialCipher.make({
      seal: Effect.fn("WebCryptoCipher.seal")(function*(plaintext, context) {
        const additionalData = yield* encodeContext(context)
        const nonce = yield* randomNonce()
        const ciphertext = yield* Effect.tryPromise({
          try: () =>
            crypto.encrypt(
              { name: algorithm, iv: nonce, additionalData: additionalData },
              key,
              new TextEncoder().encode(Redacted.value(plaintext))
            ),
          catch: CredentialCipher.unavailable
        })
        return { ciphertext: toBase64(new Uint8Array(ciphertext)), nonce: toBase64(nonce) }
      }),
      open: Effect.fn("WebCryptoCipher.open")(function*(sealed, context) {
        const additionalData = yield* encodeContext(context)
        const plaintext = yield* Effect.try({
          try: () => fromBase64(sealed.nonce),
          catch: (cause) => unopenable("malformed_nonce", cause)
        }).pipe(
          Effect.flatMap((nonce) =>
            Effect.tryPromise({
              try: () =>
                crypto.decrypt(
                  { name: algorithm, iv: nonce, additionalData: additionalData },
                  key,
                  fromBase64(sealed.ciphertext)
                ),
              catch: (cause) => unopenable("authentication_failed", cause)
            })
          ),
          Effect.tapError((error) =>
            Effect.logWarning({ message: error.message, operation: error.operation, credentialId: context.id })
          )
        )
        return Redacted.make(new TextDecoder().decode(plaintext))
      })
    })
  })

/**
 * Provides AES-256-GCM credential encryption under a host-managed key.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options
): Layer.Layer<CredentialCipher.CredentialCipher, Unavailable | InvalidInput> =>
  Layer.effect(CredentialCipher.CredentialCipher)(make(options))
