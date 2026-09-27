// Deep reviewed and polished by a human on 2026-08-31.

/**
 * Derivation of the current flow-key format from structured input.
 *
 * @since 0.1.0
 */

import { Canonical } from "@smthrs/canonical"
import { digest as sha256 } from "@smthrs/crypto"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { KeyDerivationError, type KeyDerivationErrorCode } from "./KeyDerivationError.ts"
import type { KeyV1 } from "./KeyV1.ts"

const derivationFailure = (
  code: KeyDerivationErrorCode,
  message: string,
  cause: unknown
): KeyDerivationError => new KeyDerivationError({ code, message, cause })

/**
 * Derives the current flow-key format from structured input.
 *
 * The input is serialized with {@link Canonical}, hashed as UTF-8 SHA-256
 * through the injected Effect `Crypto` service, and prefixed with `key1_`.
 * Callers should include a stable domain and version in structured key
 * material when identities from different protocols must not overlap.
 *
 * @category derivation
 * @since 1.0.0
 */
export const deriveKey = (
  input: unknown
): Effect.Effect<KeyV1, KeyDerivationError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const serialized = yield* Schema.decodeUnknownEffect(Canonical)(input, {
      reportInput: false
    }).pipe(
      Effect.mapError((cause) =>
        derivationFailure(
          "canonicalization_failed",
          "Key input could not be canonicalized",
          cause
        )
      )
    )
    const hash = yield* sha256(serialized).pipe(
      Effect.mapError((cause) =>
        derivationFailure(
          "digest_failed",
          "Canonical key material could not be hashed",
          cause
        )
      )
    )

    return `key1_${hash}` as KeyV1
  })
