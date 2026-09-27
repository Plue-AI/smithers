/**
 * Mark/sweep garbage collection for the content-addressed artifact store.
 *
 * The artifact tier is the one store in the composition with true *garbage*:
 * every output over the inline bound is spilled to `.flows/objects` by digest
 * (`StepBoundary`), nothing ever deletes a published blob, and a blob whose
 * every referencing row is gone is unreachable forever. The step cache is
 * deliberately NOT collected here — its rows are the *roots* of this graph,
 * they never become unreachable, and removing one is the policy decision
 * `CacheStore.evict` already serves.
 *
 * The design combines the two prior arts on the shelf:
 *
 * - **Reachability from durable roots** — git's `git gc` marks from refs;
 *   Skyframe deletes what a keyed graph walk cannot reach. Here the roots are
 *   every attempt row of every existing (never-deleted) run and every step
 *   cache entry; each carries boundary evidence, and
 *   `StepBoundary.referencedDigests` names the blobs that evidence needs.
 *   Attempt checkpoints are roots too: they are opaque executable state, so
 *   the mark keeps digest-shaped strings found in their JSON.
 * - **A grace period over mtime** — git refuses to prune unreachable objects
 *   younger than `gc.pruneExpire` (two weeks), jj keeps operations newer than
 *   its keep bound, and Bazel's disk-cache collector
 *   (`reference/bazel/.../remote/disk/DiskCacheGarbageCollector.java`) fences
 *   on mtime. The cutoff is the collection start time minus the grace period,
 *   sampled before resolving policy pins or scanning roots and held fixed
 *   through inventory and deletion. Only mtimes strictly before it are
 *   eligible: a blob published — or freshened by a dedupe `put` — at or after
 *   collection start survives, including same-millisecond writes at zero
 *   grace, no lock required.
 *
 * Collection NEVER runs automatically. `gc()` is an explicit verb because
 * deletion is irreversible, and a human approving a plan must approve the
 * deletions too. The opt-in {@link ArtifactGcPolicy} layer
 * configures *how* an invocation collects (grace bound, pinned digests); it
 * does not schedule anything.
 *
 * @since 0.1.0
 */

import * as ArtifactSweep from "@smthrs/artifacts/ArtifactSweep"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as ArtifactRoots from "./internal/ArtifactRoots.ts"

/**
 * Stable error codes returned by artifact garbage collection.
 *
 * @category models
 * @since 0.1.0
 */
export const ArtifactGcErrorCode = Schema.Literals(["invalid_options", "mark_failed", "sweep_failed"])

/**
 * Stable error codes returned by artifact garbage collection.
 *
 * @category models
 * @since 0.1.0
 */
export type ArtifactGcErrorCode = typeof ArtifactGcErrorCode.Type

/**
 * A collection that could not complete. `mark_failed` means the live set
 * could not be computed — nothing was deleted. `sweep_failed` means the live
 * set held but a deletion refused; everything already swept was garbage, so a
 * re-run converges from wherever the failure stopped it.
 *
 * @category errors
 * @since 0.1.0
 */
export class ArtifactGcError extends Schema.TaggedError<ArtifactGcError>()(
  "@smthrs/engine-store/ArtifactGcError",
  {
    code: ArtifactGcErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * The opt-in collection policy. Explicit {@link GcOptions} on a `gc()` call
 * override the installed policy; the policy overrides the defaults.
 *
 * @category models
 * @since 0.1.0
 */
export interface Policy {
  /** Grace bound applied when a `gc()` call does not name one. */
  readonly graceMs?: number | undefined
  /**
   * Digests held live regardless of reachability — the seam for references
   * this composition's tables cannot see (an external index, an export a
   * human wants kept). Resolved fresh on every collection.
   */
  readonly pins?: Effect.Effect<ReadonlyArray<string>> | undefined
}

/**
 * Service tag for the opt-in collection policy.
 *
 * @category services
 * @since 0.1.0
 */
export class ArtifactGcPolicy extends Context.Service<ArtifactGcPolicy, Policy>()(
  "@smthrs/engine-store/ArtifactGcPolicy"
) {}

/**
 * Installs a collection policy.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerPolicy = (policy: Policy): Layer.Layer<ArtifactGcPolicy> => Layer.succeed(ArtifactGcPolicy)(policy)

/**
 * Options for one explicit collection.
 *
 * @category models
 * @since 0.1.0
 */
export interface GcOptions {
  /**
   * How recently a blob must have been written or freshened to survive
   * unreferenced. Defaults to the installed {@link ArtifactGcPolicy}'s bound,
   * then to {@link defaultGraceMs}.
   */
  readonly graceMs?: number | undefined
  /** Digests held live for this collection, unioned with the policy's pins. */
  readonly pins?: ReadonlyArray<string> | undefined
  /** Compute and report without deleting anything. */
  readonly dryRun?: boolean | undefined
}

/**
 * What one collection did.
 *
 * @category models
 * @since 0.1.0
 */
export interface GcReport {
  /** Blobs the inventory enumerated. */
  readonly scannedBlobs: number
  /** Distinct digests the mark phase proved live, pins included. */
  readonly liveDigests: number
  /** Digests deleted — or, under `dryRun`, the ones a real run would delete. */
  readonly sweptDigests: ReadonlyArray<string>
  /** Bytes the swept blobs held. */
  readonly reclaimedBytes: number
  /** Unreferenced blobs retained by the grace bound or a freshen race. */
  readonly keptByGrace: number
  readonly dryRun: boolean
}

/**
 * Explicit artifact garbage collection.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  /**
   * Marks the live set from the durable roots, then sweeps every blob that
   * is both outside it and older than the grace bound. Explicit only —
   * nothing in the engine composition ever calls this.
   */
  readonly gc: (options?: GcOptions) => Effect.Effect<GcReport, ArtifactGcError>
}

/**
 * Service tag for artifact garbage collection.
 *
 * @category services
 * @since 0.1.0
 */
export class ArtifactGc extends Context.Service<ArtifactGc, Service>()("@smthrs/engine-store/ArtifactGc") {}

/**
 * Two weeks, git's `gc.pruneExpire` default. The bound is deliberately far
 * beyond any live attempt's duration: a blob spilled by a running step is
 * unreferenced until its attempt row finishes, and the grace period is the
 * only thing protecting it in that window.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultGraceMs = 14 * 24 * 60 * 60 * 1000

/**
 * Construction options.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  /** Rows per mark-phase page. Defaults to 500. */
  readonly pageSize?: number | undefined
}

const markFailed = (message: string, cause: unknown): ArtifactGcError =>
  new ArtifactGcError({ code: "mark_failed", message, cause })

const sweepFailed = (message: string, cause: unknown): ArtifactGcError =>
  new ArtifactGcError({ code: "sweep_failed", message, cause })

const invalidOptions = (message: string): ArtifactGcError => new ArtifactGcError({ code: "invalid_options", message })

/**
 * Extracts the digests one root row keeps live, FAIL-SAFE: a row whose
 * metadata carries a `boundary` this build cannot decode aborts the
 * collection rather than contributing nothing. Silently reading such a row as
 * "references no artifacts" is exactly how a live blob gets collected; a
 * metadata shape with no `boundary` key at all is the ordinary
 * foreign-evidence case `referencedDigests` already defines as empty.
 */
const rootDigests = (table: string, metaJson: string): Effect.Effect<ReadonlyArray<string>, ArtifactGcError> =>
  ArtifactRoots.rootDigests(table, metaJson).pipe(
    Effect.mapError((cause) => markFailed(cause.message, cause.cause))
  )

const checkpointDigests = (checkpointJson: string | null): Effect.Effect<ReadonlyArray<string>, ArtifactGcError> =>
  ArtifactRoots.checkpointDigests(checkpointJson).pipe(
    Effect.mapError((cause) => markFailed(cause.message, cause.cause))
  )

/**
 * Builds the collector over the composition's own durable tables and the
 * host-local sweep surface.
 *
 * The mark phase reads `flows_step_cache` and `flows_attempts` directly, the
 * same way `DurableEngineState` range-scans `flows_runs`: this package
 * composes every one of those migrations, so the schema is its own. Every run
 * present in `flows_runs` is a live root — there is no deleted state, and the
 * attempt table's foreign key guarantees each attempt's run exists — so the
 * scan is simply *all* attempt rows plus *all* cache entries, paged by
 * primary key so no page holds more than `pageSize` rows in memory.
 *
 * Ordering is the safety argument. The live set is computed BEFORE the
 * inventory, so a root recorded during the sweep can only be missed, never
 * half-seen — and the blob such a root references is protected anyway: a
 * fresh publication carries a fresh mtime, a re-publication of existing bytes
 * freshens the blob's mtime (`ArtifactStore.put`), and the sweep's deletion
 * is fenced on that mtime (`ArtifactSweep.remove`'s `ifUnmodifiedSinceMs`).
 * A crash mid-sweep deletes some garbage and no live blobs; re-running
 * converges.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: MakeOptions = {}
): Effect.Effect<Service, never, SqlClient.SqlClient | ArtifactSweep.ArtifactSweep> =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const sweeper = yield* ArtifactSweep.ArtifactSweep
    const policy = yield* Effect.serviceOption(ArtifactGcPolicy)
    const pageSize = options.pageSize ?? 500

    const markCacheEntries = (live: Set<string>) =>
      Effect.gen(function*() {
        let after = ""
        for (;;) {
          const rows = yield* sql<{ readonly key_digest: string; readonly meta_json: string }>`
            SELECT key_digest, meta_json FROM flows_step_cache
            WHERE key_digest > ${after}
            ORDER BY key_digest
            LIMIT ${pageSize}
          `.pipe(Effect.mapError((cause) => markFailed("the step cache could not be scanned", cause)))
          for (const row of rows) {
            for (const digest of yield* rootDigests("flows_step_cache", row.meta_json)) {
              live.add(digest)
            }
          }
          if (rows.length < pageSize) return
          after = rows[rows.length - 1]!.key_digest
        }
      })

    const markAttempts = (live: Set<string>) =>
      Effect.gen(function*() {
        let after = { runId: "", stepKeyDigest: "", attempt: -1 }
        for (;;) {
          const rows = yield* sql<{
            readonly run_id: string
            readonly step_key_digest: string
            readonly attempt: number
            readonly checkpoint_json: string | null
            readonly meta_json: string
          }>`
            SELECT run_id, step_key_digest, attempt, checkpoint_json, meta_json FROM flows_attempts
            WHERE (run_id, step_key_digest, attempt) > (${after.runId}, ${after.stepKeyDigest}, ${after.attempt})
            ORDER BY run_id, step_key_digest, attempt
            LIMIT ${pageSize}
          `.pipe(Effect.mapError((cause) => markFailed("the attempt table could not be scanned", cause)))
          for (const row of rows) {
            for (const digest of yield* rootDigests("flows_attempts", row.meta_json)) {
              live.add(digest)
            }
            for (const digest of yield* checkpointDigests(row.checkpoint_json)) {
              live.add(digest)
            }
          }
          if (rows.length < pageSize) return
          const last = rows[rows.length - 1]!
          after = { runId: last.run_id, stepKeyDigest: last.step_key_digest, attempt: last.attempt }
        }
      })

    const gc: Service["gc"] = Effect.fn("ArtifactGc.gc")((gcOptions) =>
      Effect.gen(function*() {
        if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
          return yield* Effect.fail(invalidOptions("artifact GC pageSize must be a positive safe integer"))
        }
        const grace = gcOptions?.graceMs ??
          (Option.isSome(policy) ? policy.value.graceMs : undefined) ??
          defaultGraceMs
        if (!Number.isSafeInteger(grace) || grace < 0) {
          return yield* Effect.fail(invalidOptions("artifact GC graceMs must be a non-negative safe integer"))
        }
        const startedAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
        const bound = startedAtMs - grace
        const live = new Set<string>(gcOptions?.pins ?? [])
        if (Option.isSome(policy) && policy.value.pins !== undefined) {
          for (const digest of yield* policy.value.pins) live.add(digest)
        }
        yield* markCacheEntries(live)
        yield* markAttempts(live)
        const blobs = yield* sweeper.inventory.pipe(
          Effect.mapError((cause) => sweepFailed(`the blob inventory refused: ${cause.message}`, cause))
        )
        const swept: Array<string> = []
        let reclaimedBytes = 0
        let keptByGrace = 0
        for (const blob of blobs) {
          if (live.has(blob.digest)) continue
          if (blob.modifiedAtMs >= bound) {
            keptByGrace++
            continue
          }
          if (gcOptions?.dryRun === true) {
            swept.push(blob.digest)
            reclaimedBytes += blob.sizeBytes
            continue
          }
          // The fence re-reads the blob's age inside the deletion: an
          // unreferenced-at-mark blob a concurrent `put` freshened since the
          // inventory fails the fence and is retained, exactly as a fresher
          // cache row survives a laggard's fenced evict (issue #119).
          // remove's fence is inclusive; mtimes have millisecond resolution,
          // so exclude cutoff equality there just as in the inventory check.
          const removed = yield* sweeper.remove(blob.digest, { ifUnmodifiedSinceMs: bound - 1 }).pipe(
            Effect.mapError((cause) => sweepFailed(`sweeping ${blob.digest} refused: ${cause.message}`, cause))
          )
          if (removed) {
            swept.push(blob.digest)
            reclaimedBytes += blob.sizeBytes
          } else {
            keptByGrace++
          }
        }
        return {
          scannedBlobs: blobs.length,
          liveDigests: live.size,
          sweptDigests: swept,
          reclaimedBytes,
          keptByGrace,
          dryRun: gcOptions?.dryRun === true
        }
      })
    )

    return { gc }
  })

/**
 * Provides the artifact garbage collector. Install {@link layerPolicy} into
 * this layer's inputs to configure collection; nothing schedules `gc()` —
 * invoking it stays an explicit caller decision.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: MakeOptions = {}
): Layer.Layer<ArtifactGc, never, SqlClient.SqlClient | ArtifactSweep.ArtifactSweep> =>
  Layer.effect(ArtifactGc)(make(options))

/**
 * Provides the artifact garbage collector over a filesystem objects directory:
 * {@link layer} with `ArtifactSweep.layerFileSystem` beneath it. Pass the same
 * `directory` and `coordination` the paired `ArtifactStore.layerFileSystem`
 * publishes with.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerFileSystem = (
  options: MakeOptions & ArtifactSweep.SweepOptions = {}
): Layer.Layer<ArtifactGc, never, SqlClient.SqlClient | FileSystem.FileSystem> =>
  layer(options).pipe(
    Layer.provide(ArtifactSweep.layerFileSystem({ directory: options.directory, coordination: options.coordination }))
  )
