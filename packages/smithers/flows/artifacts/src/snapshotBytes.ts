/**
 * Snapshotting caller-owned artifact bytes, so a caller that reuses its buffer
 * cannot change what is measured or stored.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import { ArtifactStoreError } from "./ArtifactStoreError.ts"

/**
 * A refused byte copy is the host declining an allocation, not a crypto
 * failure: the Crypto service has not been consulted when this fires, so
 * reporting `digest_failed` would point an operator diagnosing memory pressure
 * at the wrong subsystem. The message is constant, and the buffer is never
 * attached.
 */
const snapshotFailure = (cause: unknown): ArtifactStoreError =>
  new ArtifactStoreError({ code: "unavailable", message: "the host could not copy the artifact bytes", cause })

/**
 * Copies a caller-owned buffer when the returned Effect begins.
 *
 * A host that refuses the copy — a detached buffer, an allocation past what the
 * runtime will give — fails as `unavailable`, the code for a host refusal.
 *
 * @category utilities
 * @since 1.0.0-rc.0
 */
export const snapshotBytes = (bytes: Uint8Array): Effect.Effect<Uint8Array, ArtifactStoreError> =>
  Effect.try({
    try: () => new Uint8Array(bytes),
    catch: (cause) => snapshotFailure(cause)
  })
