/**
 * The shared step-result tier's publication seam: the remote half of a cache
 * `put`, run *after* the transaction that made the local row durable.
 *
 * `ArtifactSync` is the same idea for the artifact tier, and the two together
 * are the REAPI ordering constraint
 * (`reference/bazel/.../remote/UploadManifest.java:630-633`): blobs first, the
 * entry that references them last.
 *
 * This tag exists because of *where* the local row is written.
 * `ActionPersistence` commits the cache row and the journal record that
 * explains it in one `DurableWriter` transaction, and nothing that is not
 * storage work may be held across one — the action body, the Jj snapshot, and
 * the boundary prepare/settle all already stay outside. A `CacheStore` whose
 * `put` also writes a shared HTTP tier would put a network round trip inside
 * that transaction, blocking every other writer for its duration and rolling
 * the local row back when a *shared cache* is unreachable. So the local put
 * stays inside and the shared put becomes this service, invoked once the
 * transaction has committed. Compose it with
 * `CombinedCacheStore` in `"deferred"` publication mode, which is the mode that
 * leaves the shared write to this seam.
 *
 * Publication is **best-effort by construction**. A shared cache is an
 * accelerator, and the work it would have shared is already durably recorded on
 * this host: failing a completed run because an optional tier is unreachable
 * trades a real result for an unavailable one. A refused publication is
 * journaled by the caller instead, which is the same treatment an unverified
 * read set gets — visible, not silent.
 *
 * Governing design: `packages/smithers/flows/step-cache/docs/api.md`.
 *
 * @since 0.1.0
 */

import type { CacheStore } from "@smthrs/step-cache"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"

/**
 * The one operation the shared-cache publication seam exposes.
 *
 * It is a single method rather than a store interface on purpose: everything
 * about reading, keying, and invalidating a cache entry belongs to
 * `CacheStore`, and all this seam does is take an already-durable local entry
 * and try to share it.
 *
 * @since 0.1.0
 * @category services
 */
export interface Service {
  /**
   * Publishes a cache entry to the shared tier, reporting the refusal rather
   * than failing: `Option.none()` means the entry is now shared, and
   * `Option.some(error)` means it is not and why.
   *
   * Callers must only reach here once every artifact the entry references is
   * durable in the shared artifact tier — that is `ArtifactSync.publish`'s job,
   * and it runs first.
   */
  readonly publishEntry: (
    entry: CacheStore.CacheEntry
  ) => Effect.Effect<Option.Option<CacheStore.CacheStoreError>>
}

/**
 * Service tag for the shared step-result publication seam.
 *
 * @since 0.1.0
 * @category services
 */
export class CacheSync extends Context.Service<CacheSync, Service>()("@smthrs/engine-store/CacheSync") {}

/**
 * The single-tier implementation: there is no shared step-result tier, so a
 * recorded entry is already everywhere it will ever be.
 *
 * This is the default `ActionPersistence` falls back to when the tag is
 * absent, which is what keeps a purely local composition free of any
 * remote-cache machinery.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeLocal = (): Service => ({
  publishEntry: Effect.fn("CacheSync.publishEntry")(() => Effect.succeed(Option.none()))
})

/**
 * Provides the single-tier (no shared step-result store) publication seam.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerLocal: Layer.Layer<CacheSync> = Layer.succeed(CacheSync)(makeLocal())

/**
 * Builds the publication seam over a shared step-result store — typically
 * `RemoteCacheStore`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (options: { readonly remote: CacheStore.Service }): Service => ({
  publishEntry: Effect.fn("CacheSync.publishEntry")((entry: CacheStore.CacheEntry) =>
    // A `Conflict` from the shared tier is not a refusal to report: it means
    // another machine recorded the key first, which is exactly the
    // first-writer-wins outcome the shared tier exists to arbitrate. Only a
    // genuine failure — the tier is down, refused the body, answered with a
    // status this client cannot classify — is worth journaling.
    options.remote.put(entry).pipe(
      Effect.as(Option.none<CacheStore.CacheStoreError>()),
      Effect.catch((error) => Effect.succeed(Option.some(error)))
    )
  )
})

/**
 * Provides the publication seam over the supplied shared store.
 *
 * The shared store arrives as an *effect* rather than a layer because it
 * inhabits the same `CacheStore` tag as the local one: composing both as layers
 * would shadow one with the other.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = <E, R>(
  remote: Effect.Effect<CacheStore.Service, E, R>
): Layer.Layer<CacheSync, E, R> => Layer.effect(CacheSync)(Effect.map(remote, (shared) => make({ remote: shared })))
