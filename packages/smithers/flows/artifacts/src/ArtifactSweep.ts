/**
 * The sweep half of artifact garbage collection: enumerate this host's blobs
 * and delete one, fenced by its age.
 *
 * This surface is deliberately NOT part of `ArtifactStore.Service`. The store
 * contract is shared by memory, filesystem, and network tiers, and a remote
 * tier can neither enumerate its address space nor accept a delete — Bazel
 * draws the same line: its disk-cache collector
 * (class `DiskCacheGarbageCollector` in
 * `com.google.devtools.build.lib.remote.disk`) walks the local directory, while
 * the remote tier owns its own retention. Only the
 * host-local filesystem store implements this.
 *
 * The *policy* — which digests are live, how old a dead blob must be before it
 * goes — belongs to the engine composition, which is the only place the
 * durable roots (attempt rows, cache entries) are visible. This module ships
 * mechanics alone; `@smthrs/engine-store` owns the mark policy and grace
 * period.
 *
 * @since 1.0.0-rc.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as ArtifactBackupLease from "./ArtifactBackupLease.ts"
import * as ArtifactStore from "./ArtifactStore.ts"
import * as ArtifactLocks from "./internal/ArtifactLocks.ts"
import * as ArtifactPath from "./internal/ArtifactPath.ts"

/**
 * One enumerated blob: its content address, when it was last written or
 * freshened, and its size.
 *
 * `modifiedAtMs` is the age evidence a sweep fences on — the same signal git
 * (`git prune --expire`) and Bazel's disk-cache collector read, because it is
 * the one timestamp a filesystem maintains without any bookkeeping of ours.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export interface BlobStat {
  readonly digest: string
  readonly modifiedAtMs: number
  readonly sizeBytes: number
}

/**
 * Fencing predicate for a sweep deletion.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export interface RemoveOptions {
  /**
   * Deletes the blob only while its mtime is still at or before this bound.
   * A blob freshened after the caller computed its live set — a concurrent
   * `put` re-referencing the same bytes — fails the fence and survives, the
   * same shape as `CacheStore.evict`'s `ifRecordedBy`: the guard rides in the
   * delete, never in a prior read alone.
   */
  readonly ifUnmodifiedSinceMs?: number | undefined
}

/**
 * Host-local blob enumeration and fenced deletion.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export interface Service {
  /**
   * Every content-addressed blob this host's store currently holds. In-flight
   * `.tmp-*` scratch files, foreign files, and blobs whose age cannot be
   * measured are excluded — what the sweep cannot judge it must not touch.
   */
  readonly inventory: Effect.Effect<Array<BlobStat>, ArtifactStore.ArtifactStoreError>
  /**
   * Deletes the blob at `digest`, returning whether bytes were removed. A
   * missing blob reports `false` rather than failing, so a crashed and
   * re-run sweep converges instead of erroring on its own progress.
   *
   * `false` covers three outcomes a caller cannot tell apart, all of which mean
   * "nothing was reclaimed, and retrying later is safe": the blob was already
   * gone, it failed the `ifUnmodifiedSinceMs` fence, or a live backup lease
   * fenced the deletion (see `ArtifactBackupLease`). The last one is not
   * progress — the blob is still there — so a collector that counts reclaimed
   * bytes must not count it, and the next pass after the backup finishes
   * removes it.
   */
  readonly remove: (
    digest: string,
    options?: RemoveOptions
  ) => Effect.Effect<boolean, ArtifactStore.ArtifactStoreError>
}

/**
 * Service tag for host-local artifact sweeping.
 *
 * The identity string equals this module's package path, per the house rule
 * that a new identity is the defining module path.
 *
 * @category services
 * @since 1.0.0-rc.0
 * @slop
 */
export class ArtifactSweep extends Context.Service<ArtifactSweep, Service>()("@smthrs/artifacts/ArtifactSweep") {}

const error = (message: string, cause?: unknown): ArtifactStore.ArtifactStoreError =>
  new ArtifactStore.ArtifactStoreError({
    code: "unavailable",
    message,
    ...(cause === undefined ? {} : { cause })
  })

const hostFailure = (cause: unknown): ArtifactStore.ArtifactStoreError =>
  error(`the host filesystem refused a sweep operation: ${String(cause)}`, cause)

const isNotFound = (cause: unknown): boolean =>
  cause instanceof PlatformError.PlatformError && cause.reason._tag === "NotFound"

/**
 * How the sweep reaches the objects directory.
 *
 * Deliberately not `ArtifactStore.FileSystemOptions`: the sweep never writes a
 * blob, so `durability` would be an accepted argument it ignores. Both fields
 * must match the store built over the same directory — see `coordination`.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface SweepOptions {
  /**
   * The objects directory to enumerate, the one the paired
   * `ArtifactStore.makeFileSystem` publishes into. Defaults to
   * `ArtifactStore.defaultDirectory`.
   */
  readonly directory?: string | undefined
  /**
   * `required` takes the same per-digest lock file a publishing writer takes,
   * and consults the backup lease, before deleting. It fences nothing unless
   * the paired store was built with `required` too: a store on `process` never
   * takes the lock this sweep waits on, so the fence would read as armed while
   * protecting nothing. `process` is the explicit weaker browser/test mode.
   */
  readonly coordination?: "required" | "process" | undefined
}

/**
 * Builds the filesystem-backed sweep surface over the same objects directory
 * an `ArtifactStore.makeFileSystem` publishes into.
 *
 * Enumeration is conservative by construction. Only paths in the store's
 * canonical fanout shape — `xx/<digest>` with `xx` equal to the digest's
 * two-hex prefix — are blobs; anything else in the directory (a temp file, a
 * lock file, a foreign file, a fanout directory itself) is skipped, never
 * deleted. A blob that vanishes between listing and stat was removed by someone
 * else and is likewise skipped.
 *
 * Pair it with the store over the SAME `directory` and the SAME `coordination`.
 * Nothing checks the pairing, and a mismatch is silent: a sweep on `required`
 * beside a store on `process` deletes blobs no writer is fenced against.
 *
 * Under `required`, one deletion costs two lock acquisitions — the per-digest
 * lock, then the workspace-global backup-lease gate — which is roughly ten
 * filesystem operations and two forked heartbeat fibers per blob. The gate is
 * one file for the whole workspace, so concurrent deletions serialize through
 * it. That is the price of never deleting a blob a running backup already
 * recorded; size a collection window with it in mind.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @slop
 */
export const makeFileSystem = (
  fs: FileSystem.FileSystem,
  options: SweepOptions = {}
): Service => {
  const directory = (options.directory ?? ArtifactStore.defaultDirectory).replace(/([^/])\/+$/, "$1")
  const coordination = options.coordination ?? "required"
  const blobPath = (digest: string): string => `${directory}/${digest.slice(0, 2)}/${digest}`

  const inventory: Service["inventory"] = Effect.gen(function*() {
    // A store that never published anything has no directory; that is an
    // empty inventory, not a failure.
    const checkRoot = yield* ArtifactPath.guard(fs, directory).pipe(Effect.mapError(hostFailure))
    const parents = yield* fs.readDirectory(directory).pipe(
      Effect.catch((cause) => isNotFound(cause) ? Effect.succeed([] as Array<string>) : Effect.fail(hostFailure(cause)))
    )
    const entries: Array<string> = []
    for (const parent of parents) {
      if (!/^[0-9a-f]{2}$/.test(parent)) continue
      yield* checkRoot.pipe(Effect.mapError(hostFailure))
      const safe = yield* ArtifactPath.guard(fs, `${directory}/${parent}`).pipe(Effect.option)
      if (Option.isNone(safe)) continue
      const children = yield* fs.readDirectory(`${directory}/${parent}`).pipe(
        Effect.orElseSucceed(() => [] as Array<string>)
      )
      for (const child of children) entries.push(`${parent}/${child}`)
    }
    const candidates = entries.filter((entry) => {
      if (entry.includes(".tmp-")) return false
      const separator = entry.indexOf("/")
      const fan = entry.slice(0, separator)
      const digest = entry.slice(separator + 1)
      return /^[0-9a-f]{64}$/.test(digest) && fan === digest.slice(0, 2)
    })
    const blobs = yield* Effect.forEach(candidates, (entry) =>
      Effect.gen(function*() {
        const separator = entry.indexOf("/")
        const fan = entry.slice(0, separator)
        const digest = entry.slice(separator + 1)
        // The stat is per-candidate and tolerant: a blob another process
        // removed between the listing and here simply is not in the
        // inventory, and one whose mtime the host cannot report offers no
        // age evidence, so the sweep must never judge it.
        const info = yield* Effect.gen(function*() {
          yield* checkRoot
          yield* ArtifactPath.guard(fs, `${directory}/${fan}`)
          yield* ArtifactPath.guard(fs, `${directory}/${entry}`, "File")
          return yield* fs.stat(`${directory}/${entry}`)
        }).pipe(Effect.option)
        if (Option.isNone(info) || info.value.type !== "File") return undefined
        const mtime = Option.getOrUndefined(info.value.mtime)
        if (mtime === undefined) return undefined
        return {
          digest,
          modifiedAtMs: mtime.getTime(),
          sizeBytes: Number(info.value.size)
        }
      }), { concurrency: 16 })
    return blobs.filter((blob) => blob !== undefined)
  })

  const remove: Service["remove"] = Effect.fn("ArtifactSweep.remove")((digest, removeOptions) =>
    Effect.gen(function*() {
      const validated = yield* ArtifactStore.validateDigest(digest)
      yield* Effect.annotateCurrentSpan({ digest: validated })
      const checkRoot = yield* ArtifactPath.guard(fs, directory).pipe(Effect.mapError(hostFailure))
      const checkParent = yield* ArtifactPath.guard(fs, `${directory}/${validated.slice(0, 2)}`).pipe(
        Effect.mapError(hostFailure)
      )
      if (coordination === "required") {
        yield* ArtifactPath.guard(fs, `${directory}/${ArtifactLocks.directoryName}`).pipe(Effect.mapError(hostFailure))
      }
      return yield* ArtifactLocks.withDigest(
        fs,
        directory,
        validated,
        coordination === "process"
          ? removeBlob()
          : ArtifactBackupLease.unlessActive(fs, directory, removeBlob(), hostFailure).pipe(
            Effect.map(Option.getOrElse(() => false))
          ),
        hostFailure,
        coordination
      )

      function removeBlob(): Effect.Effect<boolean, ArtifactStore.ArtifactStoreError> {
        return Effect.gen(function*() {
          const path = blobPath(validated)
          yield* checkRoot.pipe(Effect.mapError(hostFailure))
          yield* checkParent.pipe(Effect.mapError(hostFailure))
          const checkBlob = yield* ArtifactPath.guard(fs, path, "File").pipe(Effect.mapError(hostFailure))
          const bound = removeOptions?.ifUnmodifiedSinceMs
          if (bound !== undefined) {
            const info = yield* fs.stat(path).pipe(Effect.option)
            // Already gone is a completed deletion, and an unmeasurable mtime is
            // no proof of age: both refuse rather than delete.
            if (Option.isNone(info)) return false
            const mtime = Option.getOrUndefined(info.value.mtime)
            if (mtime === undefined || mtime.getTime() > bound) return false
          }
          yield* checkRoot.pipe(Effect.mapError(hostFailure))
          yield* checkParent.pipe(Effect.mapError(hostFailure))
          yield* checkBlob.pipe(Effect.mapError(hostFailure))
          return yield* fs.remove(path).pipe(
            Effect.as(true),
            // The blob may have been removed between the fence and here; only a
            // refusal over bytes that still exist is a host failure.
            Effect.catch((cause) =>
              fs.exists(path).pipe(
                Effect.mapError((probeCause) => hostFailure({ remove: cause, existenceProbe: probeCause })),
                Effect.flatMap((present) => present ? Effect.fail(hostFailure(cause)) : Effect.succeed(false))
              )
            )
          )
        })
      }
    })
  )

  return { inventory, remove }
}

/**
 * Provides the filesystem-backed sweep surface.
 *
 * Give it the same `directory` and `coordination` as the `ArtifactStore` layer
 * it sweeps behind; see {@link makeFileSystem}.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export const layerFileSystem = (
  options: SweepOptions = {}
): Layer.Layer<ArtifactSweep, never, FileSystem.FileSystem> =>
  Layer.effect(ArtifactSweep)(Effect.map(FileSystem.FileSystem, (fs) => makeFileSystem(fs, options)))

/**
 * Builds a sweep surface whose every operation fails as unavailable, with
 * per-method overrides.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => ({
  inventory: Effect.fail(error("inventory is unavailable")),
  remove: Effect.fn("ArtifactSweep.remove")(() => Effect.fail(error("remove is unavailable"))),
  ...overrides
})

/**
 * Provides a no-op sweep surface.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<ArtifactSweep> =>
  Layer.succeed(ArtifactSweep)(makeNoop(overrides))
