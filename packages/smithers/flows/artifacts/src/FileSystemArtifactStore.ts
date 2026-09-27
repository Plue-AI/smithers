/**
 * The filesystem-backed artifact store: blobs in a workspace-relative objects
 * directory under a two-hex-prefix fanout, published atomically, coordinated
 * across processes, and digest-verified on every read.
 *
 * @since 1.0.0-rc.0
 */

import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Random from "effect/Random"
import type { Service } from "./ArtifactStore.ts"
import { ArtifactCorruption, ArtifactMissing, ArtifactStoreError } from "./ArtifactStoreError.ts"
import * as ArtifactStoreMetrics from "./ArtifactStoreMetrics.ts"
import * as ArtifactLocks from "./internal/ArtifactLocks.ts"
import * as ArtifactPath from "./internal/ArtifactPath.ts"
import { measureBytes } from "./measureBytes.ts"
import { snapshotBytes } from "./snapshotBytes.ts"
import { validateDigest } from "./validateDigest.ts"

const hostFailure = (cause: unknown): ArtifactStoreError =>
  cause instanceof ArtifactStoreError ? cause : new ArtifactStoreError({
    code: "unavailable",
    message: `the host filesystem refused an artifact operation: ${String(cause)}`,
    cause
  })

/**
 * Where the filesystem-backed store keeps its blobs.
 *
 * The directory is workspace-relative rather than absolute so a workspace can
 * be moved or copied whole and still resolve its own artifacts.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export interface FileSystemOptions {
  /**
   * Where blobs are stored, content-addressed by digest. Workspace-relative;
   * defaults to {@link defaultDirectory}. An `ArtifactSweep` over the same
   * store must be built with this same directory, or it enumerates somewhere
   * the store never publishes.
   */
  readonly directory?: string | undefined
  /** New payload mode, default `0600`, restricted by the umask. Existing blobs are unchanged. */
  readonly fileMode?: number | undefined
  /** New objects and fanout directory mode, default `0700`. Existing directories are unchanged. */
  readonly directoryMode?: number | undefined
  /**
   * `required` reports success only after syncing the blob, its fanout,
   * the objects directory, and every ancestor. `best-effort` is the explicit weaker
   * capability for hosts that cannot sync file or directory handles.
   * Both modes require exclusive writable handles and symlink inspection.
   */
  readonly durability?: "required" | "best-effort" | undefined
  /**
   * `required` uses an atomic lock file to coordinate writers and sweepers
   * across processes. `process` is the explicit weaker browser/test mode.
   *
   * The fence bounds the race rather than eliminating it: the lock is
   * heartbeated every 10 seconds, another process reclaims it once it is 60
   * seconds stale, and acquisition itself gives up after 2 minutes. A holder
   * whose host stalls past the stale bound can therefore be reaped while it is
   * still running.
   *
   * Contenders that measure the same lock as stale race for a claim file named
   * after its owner token, so each lock generation is moved away at most once
   * and a fresh replacement is never displaced by a late stale verdict.
   * Neither the mtime check nor the backup lease independently protects
   * against a reaped stalled holder: the check precedes a separate delete, and
   * the gate uses this same protocol.
   *
   * It also only fences parties that agree. An `ArtifactSweep` over the same
   * directory must be built with the same `coordination`: a store on `process`
   * paired with a sweep on `required` takes lock files no writer observes, so
   * the fence reads as armed and protects nothing.
   */
  readonly coordination?: "required" | "process" | undefined
}

/**
 * The default objects directory. Workspace-relative, so a workspace carries
 * its own artifacts and a sandbox that mounts the workspace inherits them.
 *
 * Exported because the store and its sweep must name the same directory, and a
 * second private copy of the literal is exactly how they would drift apart.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultDirectory = ".flows/objects"

/**
 * How old a scratch file must be before the sweep treats it as a crash orphan
 * rather than a live writer's in-flight file. A publication writes and renames
 * within one `put`, so an hour is far beyond any live writer's window, and it
 * is sixty times the 60-second bound after which a lock file's own contention
 * path reclaims it, so a lock this old belongs to no living holder either.
 */
const staleScratchMs = 60 * 60 * 1000

/** Whether an entry is scratch the sweep may reclaim once it is stale. */
const isScratch = (entry: string): boolean =>
  entry.includes(".tmp-") || entry.startsWith(`${ArtifactLocks.directoryName}/`)

const isNotFound = (cause: unknown): boolean =>
  cause instanceof PlatformError.PlatformError && cause.reason._tag === "NotFound"

/**
 * Bazel's `DiskCacheClient.toPath` layout: a two-hex-prefix subdirectory
 * "to bypass possible folder file count limits"
 * (class `DiskCacheClient` in `com.google.devtools.build.lib.remote.disk`). The
 * store moved out of `StepBoundary` with a flat `${dir}/${digest}` layout, which puts every
 * artifact a workspace ever spilled into one directory. The rc.0 contract has
 * no compatibility shim for the provisional flat layout; old addresses are
 * cache misses that re-publish.
 */
const fanout = (directory: string, digest: string): { readonly parent: string; readonly path: string } => {
  const parent = `${directory}/${digest.slice(0, 2)}`
  return { parent, path: `${parent}/${digest}` }
}

/**
 * Builds the filesystem-backed artifact store.
 *
 * Host access arrives through Effect's `FileSystem` tag. Persistence needs a
 * trusted host with exclusive writable handles, symlink inspection and, for
 * required durability, file and directory syncing. Build this service before
 * decorating the workflow filesystem with the capability kernel, as native
 * `layerHost` does. The guarded native filesystem deliberately refuses open
 * handles and cannot back this store; best-effort durability does not lift
 * that requirement. A browser host can instead use the memory store.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @slop
 */
export const makeFileSystem = (fs: FileSystem.FileSystem, options: FileSystemOptions = {}): Service => {
  const directory = (options.directory ?? defaultDirectory).replace(/([^/])\/+$/, "$1")
  const durability = options.durability ?? "required"
  const coordination = options.coordination ?? "required"
  const fileMode = options.fileMode ?? 0o600
  const directoryMode = options.directoryMode ?? 0o700
  // Every attempt draws a new token; exclusivity, not unpredictability, protects
  // an existing entry. Bound retries so a hostile directory cannot hang put.
  const freshTempToken = Effect.map(
    Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER, { halfOpen: true }),
    (drawn) => drawn.toString(36)
  )
  /**
   * Best-effort reclamation of scratch files orphaned by a crash: `.tmp-*`
   * payloads left between the temp write and the rename, and `.locks/*` files
   * left by a holder that was hard-killed. Nothing else ever observes either —
   * reads resolve only canonical paths, and a lock is reclaimed on contention
   * alone, so a digest nobody publishes again keeps its lock file forever —
   * which is how the objects directory would accumulate dead files unboundedly.
   * The sweep runs once per store, on the first publication, and is
   * conservative: a scratch file younger than the stale bound may belong to a
   * live writer or lock holder in another process, and one whose age cannot be
   * measured says nothing about its owner, so both survive. Every step is
   * best-effort — a missing directory or failing host never fails the
   * publication.
   *
   * It measures and then removes, which is not atomic, so a lock file replaced
   * between those two steps is removed on the strength of its predecessor's
   * age. The hour-long threshold is what keeps that narrow: a live holder
   * heartbeats its lock every 10 seconds, so only a path abandoned for an hour
   * is ever a candidate, and only a reclaim landing inside that one gap loses
   * its lock. It is the same non-atomic reclamation `FileSystemOptions`'
   * `coordination` documents, applied to the files that reclamation leaves
   * behind.
   *
   * This is a sweep of scratch files, not garbage collection. Reclaiming
   * *published* artifacts is `ArtifactSweep` driven by an explicit
   * `ArtifactGc.gc()` call in `@smthrs/engine-store`, never folded in here.
   */
  let sweepDone = false
  const sweepOrphanedTemps = Effect.gen(function*() {
    if (sweepDone) return
    sweepDone = true
    const checkRoot = yield* ArtifactPath.guard(fs, directory)
    const parents = yield* fs.readDirectory(directory)
    const now = yield* Clock.currentTimeMillis
    for (const parent of parents) {
      if (!/^[0-9a-f]{2}$/.test(parent) && parent !== ArtifactLocks.directoryName) continue
      const parentPath = `${directory}/${parent}`
      yield* checkRoot
      const checkParent = yield* ArtifactPath.guard(fs, parentPath).pipe(Effect.option)
      if (Option.isNone(checkParent)) continue
      const entries = yield* fs.readDirectory(parentPath).pipe(Effect.orElseSucceed(() => [] as Array<string>))
      for (const entry of entries) {
        if (entry.includes("/") || entry.includes("\\") || !isScratch(`${parent}/${entry}`)) continue
        const orphanPath = `${parentPath}/${entry}`
        yield* Effect.gen(function*() {
          const checkFile = yield* ArtifactPath.guard(fs, orphanPath, "File")
          const info = yield* fs.stat(orphanPath)
          const mtime = Option.getOrUndefined(info.mtime)
          if (mtime === undefined || now - mtime.getTime() < staleScratchMs) return
          yield* checkRoot
          yield* checkParent.value
          yield* checkFile
          yield* fs.remove(orphanPath)
        }).pipe(Effect.ignore)
      }
    }
  }).pipe(Effect.ignore)

  /**
   * Flushes a freshly written temp file before it is renamed into place.
   *
   * Bazel does exactly this in `DiskCacheClient.saveFile`: "fsync temp before
   * we rename it to avoid data loss in the case of machine crashes (the OS may
   * reorder the writes and the rename)". Scratch files sync on their retained
   * handle; this helper syncs published blobs and directories. Best-effort
   * durability tolerates sync refusals, but still requires exclusive creation.
   */
  const syncPath = (path: string, flag: "r" | "r+"): Effect.Effect<void, ArtifactStoreError> => {
    const sync = Effect.scoped(Effect.flatMap(fs.open(path, { flag }), (file) => file.sync)).pipe(
      Effect.mapError(hostFailure)
    )
    return durability === "best-effort" ? Effect.ignore(sync) : sync
  }
  // A directory sync persists its children, not its own name in its parent.
  // Repeat the whole ancestry even on dedupe: an existing directory may have
  // been created by an interrupted publication in another store or process.
  // Syncing objects also persists the lock directory created by withDigest.
  const syncDirectoryAncestry = Effect.gen(function*() {
    const path = yield* Path.Path
    let current = directory
    while (true) {
      yield* syncPath(current, "r")
      const parent = path.dirname(current)
      if (parent === current) return
      current = parent
    }
  }).pipe(Effect.provide(Path.layer))

  const put: Service["put"] = Effect.fn("ArtifactStore.put")((bytes: Uint8Array) =>
    Effect.flatMap(
      snapshotBytes(bytes),
      (snapshot) =>
        Effect.flatMap(measureBytes(snapshot), (digest) =>
          Effect.gen(function*() {
            yield* ArtifactPath.guard(fs, directory).pipe(Effect.mapError(hostFailure))
            yield* fs.makeDirectory(directory, { recursive: true, mode: directoryMode }).pipe(
              Effect.mapError(hostFailure)
            )
            const checkRoot = yield* ArtifactPath.guard(fs, directory).pipe(Effect.mapError(hostFailure))
            if (coordination === "required") {
              yield* ArtifactPath.guard(fs, `${directory}/${ArtifactLocks.directoryName}`).pipe(
                Effect.mapError(hostFailure)
              )
            }
            return yield* ArtifactLocks.withDigest(
              fs,
              directory,
              digest,
              Effect.gen(function*() {
                yield* Effect.annotateCurrentSpan({ digest })
                const blob = fanout(directory, digest)
                yield* checkRoot.pipe(Effect.mapError(hostFailure))
                yield* ArtifactPath.guard(fs, blob.parent).pipe(Effect.mapError(hostFailure))
                yield* fs.makeDirectory(blob.parent, { mode: directoryMode, recursive: true }).pipe(
                  Effect.mapError(hostFailure)
                )
                const checkParent = yield* ArtifactPath.guard(fs, blob.parent).pipe(Effect.mapError(hostFailure))
                const checkBlob = yield* ArtifactPath.guard(fs, blob.path, "File").pipe(Effect.mapError(hostFailure))
                const stored = yield* fs.exists(blob.path).pipe(Effect.mapError(hostFailure))
                // Existence alone is not validity: a truncated blob left by a crashing
                // writer or by disk corruption would otherwise be trusted forever at
                // write time while `get` digest-verifies and refuses — a permanent
                // failure with no repair path even though this process holds the correct
                // bytes. The existing blob is digest-verified on EVERY put (an
                // unreadable blob counts as corrupt), and only a verified match skips
                // the write; a mismatch falls through to the atomic rewrite below,
                // healing the address. Verification is deliberately not memoized: the
                // objects directory is workspace-shared, so a blob can change behind
                // this store's back, and a remembered proof let a later `put` report
                // success over corrupt bytes without repairing them — `get` would then
                // refuse the digest forever even though every `put` held the cure.
                // Re-verifying costs a constant factor, never a new asymptote: a `put`
                // already pays one O(blob size) hash to measure its own input.
                let verified = stored &&
                  (yield* fs.readFile(blob.path).pipe(
                    Effect.flatMap((existing) => Effect.map(measureBytes(existing), (measured) => measured === digest)),
                    Effect.catch(() => Effect.succeed(false))
                  ))
                if (verified) {
                  // Freshen the blob's mtime on a dedupe hit — git's loose-object
                  // freshening, and the touch Bazel's `DiskCacheClient` performs on a
                  // cache hit. The mtime is the age evidence a mark/sweep collector
                  // fences its deletions on (`ArtifactSweep`), so a re-publication of
                  // old bytes must read as a recent reference or the grace period
                  // cannot protect the entry recorded moments later. Best-effort on
                  // hosts without `utimes` (the browser filesystem): a failed freshen
                  // over a blob that still exists keeps the dedupe skip and accepts
                  // git's freshen-versus-prune race; a failed freshen over a blob that
                  // VANISHED — a sweep won it — falls through to the atomic rewrite
                  // below, healing the address.
                  const now = yield* Clock.currentTimeMillis
                  const timestamp = new Date(now)
                  yield* checkRoot.pipe(Effect.mapError(hostFailure))
                  yield* checkParent.pipe(Effect.mapError(hostFailure))
                  yield* checkBlob.pipe(Effect.mapError(hostFailure))
                  const alive = yield* fs.utimes(blob.path, timestamp, timestamp).pipe(
                    Effect.as(true),
                    Effect.catch(() => fs.exists(blob.path).pipe(Effect.catch(() => Effect.succeed(true))))
                  )
                  if (!alive) {
                    verified = false
                  }
                  if (verified) {
                    yield* syncPath(blob.path, "r+")
                    yield* syncPath(blob.parent, "r")
                  }
                }
                if (!verified) {
                  // Atomic publication: a plain write to the canonical address could be
                  // observed — or survive a crash — as a partial file that every later
                  // read of this digest would trust. The payload lands at a temp path in
                  // the same fanout directory (so the rename never crosses a filesystem)
                  // and is renamed into place; an existing blob is rewritten only when
                  // its bytes no longer match its address.
                  yield* sweepOrphanedTemps
                  yield* Effect.scoped(Effect.gen(function*() {
                    for (let attempt = 0; attempt < 16; attempt++) {
                      yield* checkRoot
                      yield* checkParent
                      const tempPath = `${blob.path}.tmp-${yield* freshTempToken}-${attempt}`
                      const file = yield* fs.open(tempPath, { flag: "wx", mode: fileMode }).pipe(
                        Effect.map(Option.some),
                        Effect.catch((cause) =>
                          cause.reason._tag === "AlreadyExists"
                            ? Effect.succeed(Option.none())
                            : Effect.fail(cause)
                        )
                      )
                      if (Option.isNone(file)) continue
                      // Install cleanup only after exclusive acquisition. Never unlink
                      // a colliding entry, which may belong to another writer.
                      const checkTemp = yield* ArtifactPath.guard(fs, tempPath, "File", yield* file.value.stat)
                      yield* Effect.gen(function*() {
                        if (snapshot.byteLength > 0) yield* file.value.writeAll(snapshot)
                        yield* durability === "best-effort" ? Effect.ignore(file.value.sync) : file.value.sync
                        yield* checkRoot
                        yield* checkParent
                        yield* checkTemp
                        yield* fs.rename(tempPath, blob.path)
                        yield* syncPath(blob.parent, "r")
                      }).pipe(Effect.onError(() =>
                        Effect.gen(function*() {
                          yield* checkRoot
                          yield* checkParent
                          yield* checkTemp
                          yield* fs.remove(tempPath)
                        }).pipe(Effect.ignore)
                      ))
                      return
                    }
                    return yield* Effect.fail(
                      new ArtifactStoreError({
                        code: "unavailable",
                        message: "artifact scratch creation exhausted collision retries"
                      })
                    )
                  })).pipe(Effect.mapError(hostFailure))
                }
                yield* syncDirectoryAncestry
                yield* Metric.update(ArtifactStoreMetrics.puts, 1)
                return digest
              }),
              hostFailure,
              coordination
            )
          }))
    )
  )

  const get: Service["get"] = Effect.fn("ArtifactStore.get")((digest: string) =>
    Effect.gen(function*() {
      const validated = yield* validateDigest(digest)
      yield* Effect.annotateCurrentSpan({ digest: validated })
      const blob = fanout(directory, validated)
      const bytes = yield* fs.readFile(blob.path).pipe(
        Effect.catch((cause): Effect.Effect<Uint8Array, ArtifactMissing | ArtifactStoreError> => {
          const missing = new ArtifactMissing({ code: "artifact_missing", digest: validated })
          if (isNotFound(cause)) return Effect.fail(missing)
          return fs.exists(blob.path).pipe(
            Effect.mapError((probeCause) => hostFailure({ read: cause, existenceProbe: probeCause })),
            Effect.flatMap((present): Effect.Effect<Uint8Array, ArtifactMissing | ArtifactStoreError> =>
              Effect.fail(present ? hostFailure(cause) : missing)
            )
          )
        })
      )
      const measured = yield* measureBytes(bytes)
      if (measured !== validated) {
        return yield* Effect.fail(
          new ArtifactCorruption({
            code: "artifact_corruption",
            recordedDigest: validated,
            measuredDigest: measured
          })
        )
      }
      yield* Metric.update(ArtifactStoreMetrics.gets, 1)
      return bytes
    })
  )

  const has: Service["has"] = Effect.fn("ArtifactStore.has")((digest: string) =>
    Effect.gen(function*() {
      const validated = yield* validateDigest(digest)
      yield* Effect.annotateCurrentSpan({ digest: validated })
      return yield* fs.exists(fanout(directory, validated).path).pipe(Effect.mapError(hostFailure))
    })
  )

  const findMissing: Service["findMissing"] = Effect.fn("ArtifactStore.findMissing")((digests: Iterable<string>) =>
    Effect.gen(function*() {
      const requested = [...new Set(digests)]
      yield* Effect.annotateCurrentSpan({ count: requested.length })
      yield* Effect.forEach(requested, validateDigest, { discard: true })
      const present = yield* Effect.forEach(requested, has, { concurrency: 16 })
      return requested.filter((_, index) => !present[index])
    })
  )

  return { put, get, has, findMissing }
}
