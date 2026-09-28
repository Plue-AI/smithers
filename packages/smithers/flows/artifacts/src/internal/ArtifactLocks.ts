/**
 * Per-digest coordination for filesystem publication and removal.
 *
 * The semaphore is the cheap in-process path. A `FileLease` lock file is the
 * actual workspace-wide fence: every process that can mutate the object
 * directory observes it, and a crashed owner is recovered after its heartbeat
 * expires.
 *
 * @since 1.0.0-rc.0
 */

import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Semaphore from "effect/Semaphore"
import * as FileLease from "../FileLease.ts"
import * as ArtifactPath from "./ArtifactPath.ts"

interface Entry {
  readonly semaphore: Semaphore.Semaphore
  users: number
}

const locks = new WeakMap<FileSystem.FileSystem, Map<string, Entry>>()

/**
 * The subdirectory of the objects directory that holds lock files and their
 * stale-owner tombstones. Named here rather than spelled in each caller so the
 * store's crash-orphan sweep reclaims exactly what this module creates.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const directoryName = ".locks"

/**
 * Coordinates publication, freshening, and sweep deletion for one digest.
 * `process` is the explicit weaker mode for hosts without atomic create.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const withDigest = <A, E, R, E2>(
  fs: FileSystem.FileSystem,
  directory: string,
  digest: string,
  effect: Effect.Effect<A, E, R>,
  failure: (cause: unknown) => E2,
  coordination: "required" | "process" = "required"
): Effect.Effect<A, E | E2, R> =>
  // Every execution of the returned effect claims its own share of the entry,
  // which is why the whole body is suspended rather than run when `withDigest`
  // is called. A count taken at construction is wrong in both directions: an
  // effect built and discarded pins an entry nothing will ever release, and one
  // built once and run repeatedly — `ArtifactBackupLease` builds its gate once
  // and runs it on every heartbeat — retires the entry underneath a live holder,
  // so the next caller mints a second semaphore for the same digest and the two
  // serialize against nothing.
  Effect.suspend(() => {
    let byKey = locks.get(fs)
    if (byKey === undefined) {
      byKey = new Map()
      locks.set(fs, byKey)
    }
    const key = JSON.stringify([directory, digest])
    let entry = byKey.get(key)
    if (entry === undefined) {
      entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 }
      byKey.set(key, entry)
    }
    entry.users += 1
    const held = entry
    const table = byKey

    // The deadline starts before the semaphore wait and ends once both locks
    // are held. The protected operation and its release are never timed out.
    const ready = Deferred.makeUnsafe<void>()
    const deadline = Deferred.await(ready).pipe(
      Effect.timeout(FileLease.defaultAcquireWithin),
      Effect.catchTag("TimeoutError", (cause) => Effect.fail(failure(cause))),
      Effect.andThen(Effect.never)
    )
    const coordinated = coordination === "process"
      ? Deferred.succeed(ready, undefined).pipe(Effect.andThen(effect))
      : Effect.gen(function*() {
        // The lock directory is refused as a symlink before and after it is
        // created, and its identity is re-checked before every lock-file
        // mutation, so a swap of `.locks` for a link cannot redirect lock,
        // claim, or tombstone writes and removals elsewhere. The portable
        // filesystem cannot make a check atomic with the mutation after it.
        const lockDirectory = `${directory}/${directoryName}`
        yield* ArtifactPath.guard(fs, lockDirectory).pipe(Effect.mapError(failure))
        yield* fs.makeDirectory(lockDirectory, { recursive: true, mode: 0o700 }).pipe(Effect.mapError(failure))
        const checkLockDirectory = yield* ArtifactPath.guard(fs, lockDirectory).pipe(Effect.mapError(failure))
        return yield* FileLease.hold(fs, `${lockDirectory}/${digest}.lock`, effect, failure, {
          label: "Artifact lock",
          annotations: { digest },
          onAcquired: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
          guard: checkLockDirectory
        })
      })

    return held.semaphore.withPermit(coordinated).pipe(
      Effect.raceFirst(deadline),
      Effect.ensuring(Effect.sync(() => {
        held.users -= 1
        if (held.users === 0 && table.get(key) === held) table.delete(key)
      }))
    )
  })
