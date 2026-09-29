/**
 * Cooperative cross-process exclusion for complete standard file mutations.
 * Locks fail closed after process death; they are never stolen on a timer.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import type * as Scope from "effect/Scope"
import * as StdError from "../StdError.ts"
import * as FsFailure from "./FsFailure.ts"

// The on-disk lock protocol owns this hash; dependency upgrades must not
// change the name and let two versions acquire different locks for one file.
// Case/normalization aliases deliberately share a lock, including on hosts
// whose realPath preserves caller casing. Case-sensitive hosts may refuse a
// simultaneous change to a distinct case variant; that is safe contention.
const lockHash = (value: string): string => {
  value = value.normalize("NFC").toUpperCase()
  let hash = 5381
  for (let index = 0; index < value.length; index++) hash = (hash * 33) ^ value.charCodeAt(index)
  return (hash >>> 0).toString(16)
}

const parent = (path: string) => path.slice(0, path.lastIndexOf(path.startsWith("/") ? "/" : "\\") + 1)

/**
 * Holds all named files until the enclosing scope exits. Exclusive mkdir is
 * the host primitive, so independently composed hosts and processes agree.
 * A hash collision only refuses an unrelated edit; it cannot lose exclusion.
 *
 * @private
 * @since 1.0.0
 */
export const acquire = (
  fileSystem: FileSystem.FileSystem,
  paths: ReadonlyArray<string>,
  creationPaths?: Path.Path
): Effect.Effect<void, StdError.StdError, Scope.Scope> =>
  Effect.gen(function*() {
    const locks = new Map<string, string>()
    for (const path of paths) {
      const destination = yield* fileSystem.realPath(path).pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound" && creationPaths !== undefined
            ? fileSystem.realPath(creationPaths.dirname(path)).pipe(
              Effect.map((directory) => creationPaths.join(directory, creationPaths.basename(path)))
            )
            : Effect.fail(error)
        ),
        Effect.mapError(FsFailure.reading(path, `File not found: ${path}`))
      )
      const lock = `${parent(destination)}.smithers-${lockHash(destination)}.lock`
      locks.set(lock, path)
    }
    for (const [lock, path] of [...locks].sort(([left], [right]) => left.localeCompare(right))) {
      yield* Effect.acquireRelease(
        fileSystem.makeDirectory(lock, { mode: 0o700 }).pipe(
          Effect.mapError(FsFailure.denied(path, (error) =>
            new StdError.StdError({
              code: error.reason._tag === "AlreadyExists" ? "no_match" : "command_failed",
              message: error.reason._tag === "AlreadyExists"
                ? `Concurrent mutation of ${path}: lock ${lock} is held. Re-read and retry after the other writer finishes; a stopped writer's lock requires explicit recovery.`
                : `Could not lock ${path} for mutation`,
              path
            })))
        ),
        () => fileSystem.remove(lock, { recursive: true }).pipe(Effect.orDie)
      )
    }
  })
