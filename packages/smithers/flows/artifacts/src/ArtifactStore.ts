/**
 * The content-addressed artifact store: bytes addressed by their own SHA-256
 * digest.
 *
 * It is deliberately *not* the step cache: the step cache maps a step key to a
 * recorded result, while large result bytes live here under their digest. The
 * two tiers remain separate because artifacts must be published before a cache
 * record may reference them. See the package README and
 * {@link https://smithers.sh/docs/concepts/content-addressing | step-key documentation}.
 *
 * This module defines the contract: the address schema, the service interface
 * and tag, and one layer per local implementation. The errors, byte helpers,
 * and implementations are defined in the modules named for them and re-exported
 * here unchanged, so this subpath and the root `ArtifactStore` namespace keep
 * their whole surface.
 *
 * @since 1.0.0-rc.0
 */

import { Sha256 } from "@smthrs/crypto"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import type { ArtifactCorruption, ArtifactMissing, ArtifactStoreError } from "./ArtifactStoreError.ts"
import { type FileSystemOptions, makeFileSystem } from "./FileSystemArtifactStore.ts"
import { makeMemory } from "./MemoryArtifactStore.ts"
import { makeNoop } from "./NoopArtifactStore.ts"

export {
  ArtifactCorruption,
  ArtifactMissing,
  ArtifactStoreError,
  ArtifactStoreErrorCode
} from "./ArtifactStoreError.ts"
export { defaultDirectory, type FileSystemOptions, makeFileSystem } from "./FileSystemArtifactStore.ts"
export { measureBytes } from "./measureBytes.ts"
export { makeMemory } from "./MemoryArtifactStore.ts"
export { makeNoop } from "./NoopArtifactStore.ts"
export { snapshotBytes } from "./snapshotBytes.ts"
export { validateDigest } from "./validateDigest.ts"

/**
 * Schema for a content address: exactly 64 lowercase hexadecimal SHA-256
 * characters, branded by `@smthrs/crypto`. Re-exported so a consumer never has
 * to reach past this package for the address type it stores under.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 * @slop
 */
export const Digest = Sha256.Digest

/**
 * A content address produced by this store.
 *
 * Read operations accept a plain `string` rather than this brand on purpose: a
 * digest read back out of a durable row is untrusted input, so the store
 * validates it (see {@link ArtifactStoreError}'s `invalid_digest` code) instead
 * of asking every caller to re-brand a persisted column. `put` returns the
 * brand, because it measured the bytes itself.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export type Digest = typeof Sha256.Digest.Type

/**
 * Content-addressed blob storage.
 *
 * The contract's ergonomics follow Effect's own `KeyValueStore`
 * (`effect/unstable/persistence/KeyValueStore`): a small set of total
 * operations over one address space, with a single typed error family, so a
 * memory, filesystem, or network implementation is the same shape.
 * `findMissing` is Bazel's `MissingDigestsFinder` — one batched round trip
 * whose result is guaranteed to be a subset of its input — because a
 * per-digest existence probe over a network tier is the wrong shape entirely.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export interface Service {
  /**
   * Stores `bytes` under their own SHA-256 digest and returns that address.
   * Storing the same bytes twice is idempotent.
   */
  readonly put: (bytes: Uint8Array) => Effect.Effect<Digest, ArtifactStoreError, Crypto.Crypto>
  /**
   * Reads the bytes stored at `digest`, verifying that they still hash to it.
   */
  readonly get: (
    digest: string
  ) => Effect.Effect<Uint8Array, ArtifactMissing | ArtifactCorruption | ArtifactStoreError, Crypto.Crypto>
  /** Whether this tier holds an artifact at `digest`. */
  readonly has: (digest: string) => Effect.Effect<boolean, ArtifactStoreError>
  /**
   * Which of `digests` this tier does not hold. The returned array is
   * guaranteed to be a subset of the input and free of duplicates.
   */
  readonly findMissing: (
    digests: Iterable<string>
  ) => Effect.Effect<Array<string>, ArtifactStoreError>
}

/**
 * Service tag for the content-addressed artifact store.
 *
 * The identity string equals this module's package path, per the house rule
 * that an identity is the defining module path.
 *
 * @category services
 * @since 1.0.0-rc.0
 * @slop
 */
export class ArtifactStore extends Context.Service<ArtifactStore, Service>()("@smthrs/artifacts/ArtifactStore") {}

/**
 * Provides the filesystem-backed artifact store.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export const layerFileSystem = (
  options: FileSystemOptions = {}
): Layer.Layer<ArtifactStore, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(ArtifactStore)(Effect.gen(function*() {
    return makeFileSystem(yield* FileSystem.FileSystem, yield* Path.Path, options)
  }))

/**
 * Provides an in-memory artifact store.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export const layerMemory: Layer.Layer<ArtifactStore> = Layer.effect(ArtifactStore)(Effect.sync(makeMemory))

/**
 * Provides a no-op artifact store.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<ArtifactStore> =>
  Layer.succeed(ArtifactStore)(makeNoop(overrides))
