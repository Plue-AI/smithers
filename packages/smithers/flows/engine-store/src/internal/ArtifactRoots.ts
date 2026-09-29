/**
 * Shared fail-closed decoding of artifact addresses held by durable engine
 * rows.
 *
 * @since 1.0.0
 */

import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as StepBoundary from "../StepBoundary.ts"

const RootMeta = Schema.Struct({ boundary: StepBoundary.BoundaryEvidence })
const MetaJson = Schema.fromJsonString(Schema.Unknown)
// The store's own address schema is the one rule for what counts as a digest;
// reimplementing it here is how the two drift apart.
const isDigest = Schema.is(ArtifactStore.Digest)

/**
 * A durable root row this build cannot interpret safely.
 *
 * @category errors
 * @since 1.0.0
 */
export class ArtifactRootDecodeError extends Schema.TaggedError<ArtifactRootDecodeError>()(
  "@smthrs/engine-store/ArtifactRootDecodeError",
  { table: Schema.String, cause: Schema.Unknown }
) {
  override readonly name = "ArtifactRootDecodeError"
  override get message(): string {
    return `a ${this.table} row carries artifact evidence this build cannot decode`
  }
}

/**
 * Extracts referenced boundary digests from one metadata column.
 *
 * @category decoding
 * @since 1.0.0
 */
export const rootDigests = (
  table: string,
  metaJson: string
): Effect.Effect<ReadonlyArray<string>, ArtifactRootDecodeError> =>
  Effect.gen(function*() {
    const meta = yield* Schema.decodeUnknownEffect(MetaJson)(metaJson).pipe(
      Effect.mapError((cause) => new ArtifactRootDecodeError({ table, cause }))
    )
    if (meta === null || typeof meta !== "object" || !("boundary" in meta)) return []
    const decoded = Schema.decodeUnknownResult(RootMeta)(meta)
    if (decoded._tag === "Failure") {
      return yield* Effect.fail(new ArtifactRootDecodeError({ table, cause: decoded.failure }))
    }
    return StepBoundary.referencedDigests(decoded.success.boundary)
  })

const collectArtifactDigests = (root: unknown): ReadonlyArray<string> => {
  const digests = new Set<string>()
  const pending: Array<unknown> = [root]
  while (pending.length > 0) {
    const next = pending.pop()
    if (typeof next === "string") {
      if (isDigest(next)) digests.add(next)
      continue
    }
    if (Array.isArray(next)) {
      pending.push(...next)
      continue
    }
    if (next !== null && typeof next === "object") {
      pending.push(...Object.values(next as Readonly<Record<string, unknown>>))
    }
  }
  return [...digests]
}

/**
 * Extracts digest-shaped addresses from one opaque attempt checkpoint.
 *
 * @category decoding
 * @since 1.0.0
 */
export const checkpointDigests = (
  checkpointJson: string | null
): Effect.Effect<ReadonlyArray<string>, ArtifactRootDecodeError> =>
  Effect.gen(function*() {
    if (checkpointJson === null) return []
    const checkpoint = yield* Schema.decodeUnknownEffect(MetaJson)(checkpointJson).pipe(
      Effect.mapError((cause) => new ArtifactRootDecodeError({ table: "flows_attempts.checkpoint_json", cause }))
    )
    return collectArtifactDigests(checkpoint)
  })
