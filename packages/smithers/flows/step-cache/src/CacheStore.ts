/**
 * Durable content-addressed step result storage.
 *
 * This store receives already-computed digests and recorded results. It does
 * not interpret step layers, capabilities, or result metadata: `result` and
 * `meta` are admitted as bounded, inert JSON and stored verbatim.
 *
 * This module owns the service contract and its tag. The entry model, the
 * admission policy every tier shares, and the SQL implementation live in
 * `internal/` modules that depend on the contract and never on another tier.
 * The export list below re-exports them, so this subpath stays the one import
 * for the whole public surface.
 *
 * See the {@link https://smithers.sh/docs/concepts/content-addressing | step-key contract}
 * and {@link https://smithers.sh/docs/concepts/durable-execution | journal architecture}.
 *
 * @since 0.1.0
 */

import type { DurableWriter } from "@smthrs/database/DurableWriter"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import type { CacheEntry, RecordedBy } from "./internal/CacheEntry.ts"
import { type CacheStoreError, error } from "./internal/CacheStoreError.ts"
import * as SqlCacheStore from "./internal/SqlCacheStore.ts"

export {
  encodeCanonical,
  encodeEntryCanonical,
  maximumJsonBytes,
  maximumJsonDepth,
  maximumJsonMembers,
  maximumJsonNodes,
  snapshotEntry,
  validateAge,
  validateFence,
  validateKey,
  validateRecordedBy
} from "./internal/CacheAdmission.ts"
export {
  CacheEntry,
  KeyDigest,
  maximumKeyDigestLength,
  maximumRecordedRunIdLength,
  RecordedBy,
  RecordedRunId
} from "./internal/CacheEntry.ts"
export { CacheStoreError, CacheStoreErrorCode } from "./internal/CacheStoreError.ts"
export { make } from "./internal/SqlCacheStore.ts"

/**
 * Provenance selector for a lookup.
 *
 * @category models
 * @since 0.1.0
 */
export type GetOptions = {
  /**
   * Prefers the entry as it was recorded by this `(runId, eventSeq)` pair —
   * the append-only `flows_step_cache_recorded` ledger row a `put` lands
   * beside the head — falling back to the mutable head when no recorded
   * version under that provenance exists. Replay reads through this fence so
   * an old frame's projection stays a function of durable state: evicting or
   * replacing the head never changes what that event recorded.
   */
  readonly recordedBy?: RecordedBy
  /**
   * Refuses an entry recorded more than `maxAgeMs` before the current clock
   * reading, so a caller that declared a time-to-live reads a miss instead of
   * a stale result. The bound applies to the recorded ledger and to the head
   * alike: both carry the `createdAtMs` the age is measured from.
   *
   * The bound is a read policy, never a deletion. An expired row stays on
   * disk until {@link Service.sweepExpired} removes it, so a second caller
   * declaring a longer bound still reads it.
   */
  readonly maxAgeMs?: number
}

/**
 * Fencing predicate for an eviction.
 *
 * @category models
 * @since 0.1.0
 */
export type EvictOptions = {
  /**
   * Deletes the row only while it is still the one recorded by this
   * `(runId, eventSeq)` pair. Omitting the predicate deletes unconditionally.
   */
  readonly ifRecordedBy?: RecordedBy
}

/**
 * Optional collection policy for ledger evidence, including remote imports.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface SweepOptions {
  /**
   * Authorizes deleting one old provenance only after every local journal,
   * fork, and run reference has been released. Omitting the policy preserves
   * all rows.
   * A foreign run id alone does not prove the absence of local references.
   *
   * Runs as a local read inside the sweep's writer transaction. Failure rolls
   * back the entire sweep. The host must quiesce execution and replay across
   * all database users before checking references and until the sweep commits:
   * a write lock alone cannot protect a lookup not yet journalled. Do not
   * perform network I/O or mutate the store from this callback.
   */
  readonly canReclaimRecorded?: (
    reference: Pick<CacheEntry, "keyDigest" | "recordedRunId" | "recordedEventSeq">
  ) => Effect.Effect<boolean, CacheStoreError>
}

/**
 * Result of recording an entry under a content digest.
 *
 * @category models
 * @since 0.1.0
 */
export type PutResult =
  | { readonly _tag: "Inserted" }
  | { readonly _tag: "ExistingSame" }
  | { readonly _tag: "Conflict" }

/**
 * Content-addressed cache persistence operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  /**
   * The entry under `keyDigest`: the mutable head by default, or — with
   * `recordedBy` — the durable recorded version that exact event landed,
   * falling back to the head only when the ledger holds no row for that
   * provenance. A recorded row the {@link GetOptions.maxAgeMs} bound refuses
   * is a miss, never a fall-through to the head.
   */
  readonly get: (
    keyDigest: string,
    options?: GetOptions
  ) => Effect.Effect<Option.Option<CacheEntry>, CacheStoreError>
  readonly put: (entry: CacheEntry) => Effect.Effect<PutResult, CacheStoreError>
  /**
   * Removes the row for `keyDigest`, returning whether a row was deleted.
   * With `ifRecordedBy` the delete is a single fenced compare-and-swap, so a
   * fresher row landed by a foreign process is never deleted with the poison
   * (issue #119).
   */
  readonly evict: (
    keyDigest: string,
    options?: EvictOptions
  ) => Effect.Effect<boolean, CacheStoreError>
  /**
   * Removes every head row recorded more than `olderThanMs` before the
   * current clock reading, returning how many were deleted.
   *
   * The sweep is the collection half of {@link GetOptions.maxAgeMs}: the
   * bound decides what a read serves, this decides what the database keeps.
   * The immutable `flows_step_cache_recorded` ledger is preserved unless
   * {@link SweepOptions.canReclaimRecorded} explicitly authorizes collecting
   * an old row. Both checks and deletion share the writer transaction. The
   * return value counts heads only, even when ledger rows are reclaimed.
   *
   * Whole-run reclamation remains `@smthrs/engine-store`'s Retention, which
   * deletes ledger rows with the run's journal. Foreign imports cannot match
   * that run-scoped delete; a host composing a shared tier must schedule a
   * reference-aware sweep to bound unreferenced imported evidence.
   */
  readonly sweepExpired: (olderThanMs: number, options?: SweepOptions) => Effect.Effect<number, CacheStoreError>
}

/**
 * Service tag for content-addressed recorded step results.
 *
 * The identity string equals the defining module path, like every other
 * service identity in this repository. The pre-split `flows/journal/CacheStore`
 * identity was retired before rc.0, while no persisted journal or step-key
 * digest named it. See the
 * {@link https://smithers.sh/docs/concepts/durable-execution | journal architecture}.
 *
 * @category services
 * @since 0.1.0
 */
export class CacheStore extends Context.Service<CacheStore, Service>()("@smthrs/step-cache/CacheStore") {}

/**
 * Creates a cache store whose every operation fails as unavailable, with
 * optional per-method overrides. This is the test and {@link layerNoop} seam:
 * a caller that reaches an operation the test did not supply is told which one
 * it was, instead of reading a silent miss.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => {
  const unavailable = (method: string) => Effect.fail(error("unknown", `${method} is unavailable`))
  return CacheStore.of({
    get: Effect.fn("CacheStore.get")(() => unavailable("get")),
    put: Effect.fn("CacheStore.put")(() => unavailable("put")),
    evict: Effect.fn("CacheStore.evict")(() => unavailable("evict")),
    sweepExpired: Effect.fn("CacheStore.sweepExpired")(() => unavailable("sweepExpired")),
    ...overrides
  })
}

/**
 * Provides a no-op cache store.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<CacheStore> =>
  Layer.succeed(CacheStore)(makeNoop(overrides))

/**
 * Provides the SQL-backed cache store.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<CacheStore, never, DurableWriter | SqlClient.SqlClient> = Layer.effect(CacheStore)(
  SqlCacheStore.make
)
