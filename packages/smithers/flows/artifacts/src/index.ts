/**
 * The content-addressed artifact store: bytes addressed by their own digest.
 *
 * `ArtifactStore` is the byte half of the cache. `@smthrs/step-cache` maps a
 * step key to a recorded result, while large result bytes live here under their
 * digest. The package depends on `effect` and `@smthrs/crypto`, owns no SQL,
 * and bundles for the browser: host access is Effect's `FileSystem` and
 * `HttpClient` tags, both of which the capability kernel decorates in place.
 *
 * ```ts
 * import { ArtifactStore, CombinedArtifacts, RemoteArtifacts } from "@smthrs/artifacts"
 * import * as Effect from "effect/Effect"
 * import * as FileSystem from "effect/FileSystem"
 * import * as Path from "effect/Path"
 *
 * const layer = CombinedArtifacts.layer({
 *   local: Effect.map(Effect.all([FileSystem.FileSystem, Path.Path]), ([fs, path]) =>
 *     ArtifactStore.makeFileSystem(fs, path)),
 *   remote: RemoteArtifacts.make({ endpoint: "https://cache.example.com" })
 * })
 * ```
 *
 * @since 1.0.0-rc.0
 */

/**
 * @category services
 * @since 1.0.0-rc.0
 * @slop
 */
export * as ArtifactStore from "./ArtifactStore.ts"

/**
 * @category metrics
 * @since 1.0.0-rc.0
 * @slop
 */
export * as ArtifactStoreMetrics from "./ArtifactStoreMetrics.ts"

/**
 * @category services
 * @since 1.0.0-rc.0
 */
export * as ArtifactBackupLease from "./ArtifactBackupLease.ts"

/**
 * @category services
 * @since 1.0.0-rc.0
 * @slop
 */
export * as ArtifactSweep from "./ArtifactSweep.ts"

/**
 * @category services
 * @since 1.0.0-rc.0
 * @slop
 */
export * as CombinedArtifacts from "./CombinedArtifacts.ts"

/**
 * @category coordination
 * @since 1.0.0-rc.1
 */
export * as FileLease from "./FileLease.ts"

/**
 * @category services
 * @since 1.0.0-rc.0
 * @slop
 */
export * as RemoteArtifacts from "./RemoteArtifacts.ts"
