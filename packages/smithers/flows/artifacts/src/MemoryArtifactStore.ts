/**
 * The in-memory artifact store: a private map from digest to a defensive copy
 * of the bytes, for tests and hosts with no durable filesystem.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import type { Service } from "./ArtifactStore.ts"
import { ArtifactMissing } from "./ArtifactStoreError.ts"
import * as ArtifactStoreMetrics from "./ArtifactStoreMetrics.ts"
import { measureBytes } from "./measureBytes.ts"
import { snapshotBytes } from "./snapshotBytes.ts"
import { validateDigest } from "./validateDigest.ts"

/**
 * Builds an in-memory artifact store, for tests and for a browser host with no
 * durable filesystem yet.
 *
 * Reads are not digest-verified here, and that is not an oversight: the map is
 * keyed by the digest this store measured when it accepted the bytes, and both
 * boundaries copy — `put` stores a copy of the caller's array and `get` hands
 * out a copy of the stored one — so no reference a caller can still mutate
 * aliases the stored content, and there is no window in which the address and
 * the content can disagree. The filesystem and remote implementations verify
 * because their address spaces are genuinely shared.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @slop
 */
export const makeMemory = (): Service => {
  const blobs = new Map<string, Uint8Array>()
  const has: Service["has"] = Effect.fn("ArtifactStore.has")((digest: string) =>
    Effect.flatMap(validateDigest(digest), (validated) =>
      Effect.annotateCurrentSpan({ digest: validated }).pipe(
        Effect.as(blobs.has(validated))
      ))
  )
  return {
    put: Effect.fn("ArtifactStore.put")((bytes: Uint8Array) =>
      Effect.flatMap(snapshotBytes(bytes), (snapshot) =>
        Effect.map(measureBytes(snapshot), (digest) => {
          // A defensive copy, never the caller's reference: the caller is free
          // to reuse its buffer after `put` returns, and an aliased array would
          // let that mutation corrupt the stored content for its digest.
          blobs.set(digest, snapshot)
          return digest
        })).pipe(
          Effect.tap((digest) => Effect.annotateCurrentSpan({ digest })),
          Effect.tap(() => Metric.update(ArtifactStoreMetrics.puts, 1))
        )
    ),
    get: Effect.fn("ArtifactStore.get")((digest: string) =>
      Effect.gen(function*() {
        const validated = yield* validateDigest(digest)
        yield* Effect.annotateCurrentSpan({ digest: validated })
        const bytes = blobs.get(validated)
        if (bytes === undefined) {
          return yield* Effect.fail(new ArtifactMissing({ code: "artifact_missing", digest: validated }))
        }
        yield* Metric.update(ArtifactStoreMetrics.gets, 1)
        // A copy for the same reason `put` stores one: handing out the stored
        // array would let one reader's mutation corrupt every later read of
        // the digest.
        return bytes.slice()
      })
    ),
    has,
    findMissing: Effect.fn("ArtifactStore.findMissing")((digests: Iterable<string>) =>
      Effect.gen(function*() {
        const requested = [...new Set(digests)]
        yield* Effect.annotateCurrentSpan({ count: requested.length })
        const missing: Array<string> = []
        for (const digest of requested) {
          if (!(yield* has(digest))) missing.push(digest)
        }
        return missing
      })
    )
  }
}
