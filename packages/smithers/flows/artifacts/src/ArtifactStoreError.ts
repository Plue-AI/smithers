/**
 * The artifact store's typed failures: a refusal of the store itself, the
 * typed miss, and a digest mismatch, with the stable codes a refusal carries.
 *
 * @since 1.0.0-rc.0
 */

import { Sha256 } from "@smthrs/crypto"
import * as Schema from "effect/Schema"

/**
 * Stable error codes returned by artifact store operations.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export const ArtifactStoreErrorCode = Schema.Literals([
  "digest_failed",
  "invalid_configuration",
  "invalid_digest",
  "unavailable",
  "transport_failed"
])

/**
 * Stable error codes returned by artifact store operations.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export type ArtifactStoreErrorCode = typeof ArtifactStoreErrorCode.Type

/**
 * A typed failure of the store itself: the host or crypto provider refused an
 * operation, the remote tier refused a request, or the caller supplied invalid
 * configuration or an invalid content address.
 *
 * Distinct from {@link ArtifactMissing} and {@link ArtifactCorruption} on
 * purpose. A miss is an ordinary, expected outcome that a second tier may
 * still satisfy; corruption is an integrity violation of the store's strongest
 * invariant. `invalid_configuration` and `invalid_digest` are permanent;
 * retryability of host, crypto, and transport failures depends on the cause.
 *
 * @category errors
 * @since 1.0.0-rc.0
 * @slop
 */
export class ArtifactStoreError extends Schema.TaggedError<ArtifactStoreError>()(
  "@smthrs/artifacts/ArtifactStoreError",
  {
    code: ArtifactStoreErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * The typed miss: this tier holds no bytes at the requested address.
 *
 * A miss is not a failure of the store — it is the answer a read-through
 * composition is built to act on, so it is a distinct tag rather than an
 * `unavailable` code that a caller would have to string-match.
 *
 * @category errors
 * @since 1.0.0-rc.0
 * @slop
 */
export class ArtifactMissing extends Schema.TaggedError<ArtifactMissing>()(
  "@smthrs/artifacts/ArtifactMissing",
  {
    code: Schema.Literal("artifact_missing"),
    digest: Sha256.Digest
  }
) {}

/**
 * Bytes stored at a content address no longer hash to it.
 *
 * Every read is digest-verified, so a truncated blob left by a crashing writer
 * or by disk corruption is refused rather than handed back as if it were the
 * recorded artifact.
 *
 * @category errors
 * @since 1.0.0-rc.0
 * @slop
 */
export class ArtifactCorruption extends Schema.TaggedError<ArtifactCorruption>()(
  "@smthrs/artifacts/ArtifactCorruption",
  {
    code: Schema.Literal("artifact_corruption"),
    recordedDigest: Sha256.Digest,
    measuredDigest: Sha256.Digest
  }
) {}
