/**
 * Measuring artifact bytes: the SHA-256 content address of one immutable
 * snapshot, computed through the injected `Crypto` service.
 *
 * @since 1.0.0-rc.0
 */

import { Sha256 } from "@smthrs/crypto"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type { Digest } from "./ArtifactStore.ts"
import { ArtifactStoreError } from "./ArtifactStoreError.ts"

const digestFailure = (cause: unknown): ArtifactStoreError =>
  new ArtifactStoreError({
    code: "digest_failed",
    message: "the Crypto service failed to compute an artifact digest",
    cause
  })

/**
 * Measures one immutable byte snapshot without ever retaining it in an error.
 *
 * @category utilities
 * @since 1.0.0-rc.0
 */
export const measureBytes = (bytes: Uint8Array): Effect.Effect<Digest, ArtifactStoreError, Crypto.Crypto> =>
  Sha256.digest(bytes).pipe(Effect.mapError(digestFailure))
