/**
 * Validating a content address before any implementation logs it or
 * interpolates it into a path or URL.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import type { Digest } from "./ArtifactStore.ts"
import { ArtifactStoreError } from "./ArtifactStoreError.ts"

/**
 * Refuses anything other than the canonical SHA-256 address representation.
 *
 * Every implementation validates before logging or interpolating an untrusted
 * value into a path or URL. The failure text is constant and bounded, so even a
 * hostile multi-megabyte value cannot be copied into logs or durable errors.
 *
 * @category predicates
 * @since 1.0.0-rc.0
 * @slop
 */
export const validateDigest = (digest: string): Effect.Effect<Digest, ArtifactStoreError> =>
  typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)
    ? Effect.succeed(digest as Digest)
    : Effect.fail(
      new ArtifactStoreError({
        code: "invalid_digest",
        message: "artifact digest must be exactly 64 lowercase hexadecimal characters"
      })
    )
