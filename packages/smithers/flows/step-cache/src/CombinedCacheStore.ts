/**
 * Two step-result tiers composed into one: local first, remote second, with
 * write-back into the local SQL store.
 *
 * The shape is Bazel's `CombinedCache.downloadActionResult`, from
 * `src/main/java/com/google/devtools/build/lib/remote/CombinedCache.java` in
 * {@link https://github.com/bazelbuild/bazel | bazelbuild/bazel}: consult the
 * disk cache, fall back to the remote cache only on a miss, and write what the
 * remote returned back into the disk cache so the next lookup is local. An
 * exact local provenance record refused by age stops the lookup with a miss;
 * it never falls through to the shared head.
 *
 * **Publication order is the caller's job, not this store's.** A cache entry
 * must never be observable in the shared tier while an artifact it references
 * is missing from the shared artifact tier. That is Bazel's REAPI ordering
 * constraint, stated in that repository's `remote/UploadManifest.java` as
 * "action results may fail to validate server-side if they are accessed before
 * all blobs they refer to are present". `@smthrs/engine-store`'s
 * `ArtifactSync` enforces it around `put`. This module cannot: it does not
 * know what an entry references.
 *
 * *When* the shared copy is written is configurable for the same reason — see
 * {@link Options.publication}. A caller holding a write transaction takes
 * `"deferred"` and publishes afterwards.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as CacheStore from "./CacheStore.ts"
import * as CacheStoreMetrics from "./CacheStoreMetrics.ts"
import * as CacheAdmission from "./internal/CacheAdmission.ts"

/**
 * The two tiers to compose.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** The machine-local, durable tier. Every lookup tries this one first. */
  readonly local: CacheStore.Service
  /** The shared tier. Consulted on a local miss unless an exact record expired; written through on put. */
  readonly remote: CacheStore.Service
  /**
   * When the shared tier's copy of an entry is written.
   *
   * - `"inline"` (the default): `put` writes both tiers before it returns.
   * - `"deferred"`: `put` writes the **local tier only**, and publishing to the
   *   shared tier belongs to the caller.
   *
   * `"deferred"` exists for one caller: `@smthrs/engine-store` commits the
   * cache row and the journal record that explains it inside a single
   * `DurableWriter` transaction, and a host call must never be held across a
   * write transaction — an inline `put` would hold a network round trip inside
   * it. That engine composes this store in `"deferred"` mode and publishes
   * through its own `CacheSync` seam once the transaction has committed.
   * Lookups stay read-through in both modes.
   */
  readonly publication?: "inline" | "deferred" | undefined
}

/**
 * Composes a local and a remote cache store.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): CacheStore.Service => {
  const { local, remote } = options
  const deferred = options.publication === "deferred"

  // A bounded miss hides whether the exact ledger row is absent or expired.
  // Resolve that distinction before either fallback to a shared entry. An
  // unbounded read can itself fall back to the head, so both provenance fields
  // must match before the miss is treated as a refusal.
  const refusedLocally = (keyDigest: string, options: CacheStore.GetOptions) =>
    Effect.gen(function*() {
      const { recordedBy, maxAgeMs } = options
      if (recordedBy === undefined || maxAgeMs === undefined) return false
      const recorded = yield* local.get(keyDigest, { recordedBy })
      return Option.isSome(recorded) &&
        recorded.value.recordedRunId === recordedBy.runId &&
        recorded.value.recordedEventSeq === recordedBy.eventSeq
    })

  const get: CacheStore.Service["get"] = Effect.fn("CombinedCacheStore.get")((keyDigest, options) =>
    Effect.gen(function*() {
      yield* CacheAdmission.validateKey(keyDigest)
      yield* Effect.annotateCurrentSpan({ keyDigest })
      // One decode for the whole operation. Every tier and guard below reads
      // this detached, frozen selector, never the caller's object: an accessor
      // or a mutation during an asynchronous tier must not drop the fence
      // after the local tier refused an expired exact record.
      const maxAgeMs = yield* CacheAdmission.validateAge("maxAgeMs", options?.maxAgeMs)
      const recordedBy = yield* CacheAdmission.validateRecordedBy(options?.recordedBy)
      const selector: CacheStore.GetOptions = Object.freeze({
        ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
        ...(recordedBy === undefined ? {} : { recordedBy: Object.freeze({ ...recordedBy }) })
      })
      // The provenance fence travels with the lookup: each tier answers with
      // its recorded version when it holds one and its head otherwise.
      const cached = yield* local.get(keyDigest, selector)
      if (Option.isSome(cached)) return cached
      if (yield* refusedLocally(keyDigest, selector)) return cached
      // A shared cache is an accelerator. Its refusal is observable, but it
      // cannot replace the executable miss path with a failed run.
      const shared = yield* remote.get(keyDigest, selector).pipe(
        Effect.catch(() =>
          Metric.update(CacheStoreMetrics.remoteFailure.get, 1).pipe(
            Effect.as(Option.none<CacheStore.CacheEntry>())
          )
        )
      )
      if (Option.isNone(shared)) return shared
      // Write-back, exactly as `downloadActionResultFromRemote` does: the
      // shared entry becomes a local row so this machine's next lookup — and
      // every sibling run on it — is a local hit. Its original provenance must
      // survive for local replay; reference-aware sweeps reclaim it once the
      // host has released all frames that could read it.
      const written = yield* local.put(shared.value)
      if (written._tag === "Inserted") return shared
      // The write-back lost: a sibling run recorded its own row under the key
      // while this lookup was inside the remote tier. The durable local row is
      // the one this machine replays from and the one a fenced eviction must
      // name, so the caller is served that row — handing out the remote entry
      // over a local `Conflict` would be a cache collision the caller cannot
      // detect. If the winner is already gone again, the remote entry is the
      // only row anyone holds and stands.
      const durable = yield* local.get(keyDigest, selector)
      if (Option.isSome(durable)) return durable
      if (yield* refusedLocally(keyDigest, selector)) return durable
      return shared
    })
  )

  const put: CacheStore.Service["put"] = Effect.fn("CombinedCacheStore.put")((candidate: CacheStore.CacheEntry) =>
    Effect.gen(function*() {
      // One detachment for both tiers, taken before any field is read. Each
      // tier snapshots when its own `put` begins, so forwarding the caller's
      // object let a mutation between the two writes persist one value locally
      // and publish a different one under the same digest, with `Inserted`
      // answered for both. Reading `keyDigest` off the argument first had the
      // same shape of problem: a throwing accessor became a defect instead of
      // the `invalid_cache` this package promises.
      const entry = yield* CacheAdmission.snapshotEntry(candidate)
      yield* Effect.annotateCurrentSpan({ keyDigest: entry.keyDigest })
      // Local first, and the local outcome is the answer: first-writer-wins
      // conflict detection is what drives the `Inconsistency` receiver, and it
      // has to be decided against the durable row this machine will actually
      // replay from.
      const outcome = yield* local.put(entry)
      // A local `Conflict` means this machine already holds a *different*
      // result under the key. Publishing to the shared tier anyway would push
      // a result the caller is about to fail the run over.
      if (outcome._tag === "Conflict") return outcome
      // In `"deferred"` mode the shared write is the caller's, precisely so it
      // can happen outside whatever transaction this `put` runs in.
      if (!deferred) {
        // The local row is already the durable answer. A refused publication
        // leaves another host without this acceleration; it does not revoke
        // the successful local recording.
        const published = yield* remote.put(entry).pipe(
          Effect.catch(() =>
            Metric.update(CacheStoreMetrics.remoteFailure.put, 1).pipe(
              Effect.as(undefined)
            )
          )
        )
        // The shared outcome is deliberately not the caller's answer: this
        // machine replays from its own row, and `@smthrs/engine-store`'s
        // `CacheSync` makes the same call for the deferred path. But a shared
        // `Conflict` is not the harmless "another machine got there first"
        // that an `ExistingSame` is: by `RemoteCacheStore`'s status mapping it
        // means the shared tier holds a *different* result under this digest,
        // which is cross-host determinism divergence and the very thing
        // `CacheStoreMetrics.put.Conflict` exists to surface. Counting it is
        // the only way an operator ever sees it, because nothing else on this
        // path returns, fails, or records it.
        if (published?._tag === "Conflict") yield* Metric.update(CacheStoreMetrics.put.Conflict, 1)
      }
      return outcome
    })
  )

  const evict: CacheStore.Service["evict"] = Effect.fn("CombinedCacheStore.evict")((keyDigest, evictOptions) =>
    // Eviction is deliberately local-only. Every eviction in the engine is a
    // *this host observed this row to be poison* judgement — a stale read set,
    // corrupt evidence this host could not materialize — and none of those
    // observations generalize to the shared tier, where another machine may
    // hold the artifacts this one lost. Reclaiming shared entries is an
    // explicit retention operation, never a side effect of one host's failed
    // replay.
    CacheAdmission.validateKey(keyDigest).pipe(
      Effect.andThen(Effect.annotateCurrentSpan({ keyDigest })),
      Effect.andThen(local.evict(keyDigest, evictOptions))
    )
  )

  const sweepExpired: CacheStore.Service["sweepExpired"] = Effect.fn("CombinedCacheStore.sweepExpired")(
    (olderThanMs, options) =>
      // Local-only for the same reason eviction is: retention on this machine
      // says nothing about what a sibling machine still needs, and the shared
      // tier owns its own collection policy.
      local.sweepExpired(olderThanMs, options)
  )

  return { get, put, evict, sweepExpired }
}

/**
 * Provides a combined cache store as the `CacheStore` tag.
 *
 * Both tiers are supplied as *effects* rather than layers because they inhabit
 * the same tag: composing two `Layer<CacheStore>` would just shadow one with
 * the other.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = <EL, RL, ER, RR>(options: {
  readonly local: Effect.Effect<CacheStore.Service, EL, RL>
  readonly remote: Effect.Effect<CacheStore.Service, ER, RR>
  readonly publication?: Options["publication"]
}): Layer.Layer<CacheStore.CacheStore, EL | ER, RL | RR> =>
  Layer.effect(CacheStore.CacheStore)(
    Effect.map(
      Effect.all({ local: options.local, remote: options.remote }),
      ({ local, remote }) =>
        make({
          local,
          remote,
          ...(options.publication === undefined ? {} : { publication: options.publication })
        })
    )
  )
