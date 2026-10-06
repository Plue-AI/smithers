/**
 * Mutation preparation for versioned hosts and cooperative locks for ordinary hosts.
 * Ordinary locks fail closed after process death; they are never stolen on a timer.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as StdError from "../StdError.ts"
import * as FsFailure from "./FsFailure.ts"

/**
 * Authenticated standard-flow call session; absent callers cannot borrow another run's base.
 *
 * @category context
 * @since 1.0.0
 */
export const ReadSession = Context.Reference<string | undefined>("@smthrs/std/ReadSession", {
  defaultValue: () => undefined
})

/**
 * The coding host attaches one run-scoped precondition policy to its guarded filesystem.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const Preconditions = Symbol.for("@smthrs/std/file-preconditions")

/**
 * One prepared file change; moves include a write and a guarded source removal.
 *
 * @category models
 * @since 1.0.0
 */
export interface Change {
  readonly path: string
  /** Null removes a file. Writes preserve existing metadata; new files use host defaults. */
  readonly content: Uint8Array | null
}

/**
 * A per-invocation provider receipt boundary, with immutable captured read bases.
 *
 * @category models
 * @since 1.0.0
 */
export interface Prepared {
  /** Return bytes matching the captured base, never an unchecked current read. */
  readonly read: (path: string) => Effect.Effect<Uint8Array, StdError.StdError>
  readonly commit: (changes: ReadonlyArray<Change>) => Effect.Effect<void, StdError.StdError>
}

/**
 * Read records only successful model-facing reads; mutation-internal reads never refresh a base.
 *
 * @category models
 * @since 1.0.0
 */
export interface VersionedFileSystem extends FileSystem.FileSystem {
  readonly [Preconditions]?: {
    readonly record: (
      path: string,
      bytes: Uint8Array,
      session: string | undefined
    ) => Effect.Effect<void, StdError.StdError>
    readonly validate: (
      paths: ReadonlyArray<string>,
      session: string | undefined
    ) => Effect.Effect<void, StdError.StdError>
    /** Capture this invocation's bases from the existing ledger before tool-internal
     * reads. The returned commit must compare them again inside the provider, then
     * settle the entire batch before advancing the ledger. Concurrent reads or
     * commits must never replace these captured bases. Preparation does not freeze
     * callers; only the complete commit may acquire guest-wide exclusion.
     */
    readonly prepare?: (
      paths: ReadonlyArray<string>,
      session: string | undefined
    ) => Effect.Effect<Prepared, StdError.StdError>
  }
}

const unavailable = () =>
  Effect.fail(
    new StdError.StdError({
      code: "provider_unavailable",
      message: "Authenticated atomic file mutation provider unavailable"
    })
  )

/**
 * Versioned hosts own parent creation and locking inside their atomic commit.
 *
 * @category guards
 * @since 1.0.0
 */
export const isVersioned = (fs: FileSystem.FileSystem): boolean =>
  (fs as VersionedFileSystem)[Preconditions] !== undefined

/**
 * Record the entire original file, before pagination, through the host's existing policy.
 *
 * @category filesystem
 * @since 1.0.0
 */
export const recordRead = (fs: FileSystem.FileSystem, path: string, bytes: Uint8Array) =>
  Effect.flatMap(
    ReadSession,
    (session) => (fs as VersionedFileSystem)[Preconditions]?.record(path, bytes, session) ?? Effect.void
  )

/**
 * Refuse an unqualified provider before creating any parent or lock directories.
 *
 * @category filesystem
 * @since 1.0.0
 */
export const validate = (fs: FileSystem.FileSystem, paths: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const policy = (fs as VersionedFileSystem)[Preconditions]
    if (policy === undefined) return
    const session = yield* ReadSession
    yield* policy.validate(paths, session)
    if (policy.prepare === undefined) return yield* unavailable()
  })

/**
 * The portable body is used only for an ordinary, unversioned filesystem.
 *
 * @category models
 * @since 1.0.0
 */
export interface Mutation {
  readonly read: (
    path: string,
    ordinary: Effect.Effect<Uint8Array, StdError.StdError>
  ) => Effect.Effect<Uint8Array, StdError.StdError>
  readonly commit: (
    changes: ReadonlyArray<Change>,
    ordinary: Effect.Effect<void, StdError.StdError>
  ) => Effect.Effect<void, StdError.StdError>
}

// This serializes one host's preparation, ledger and diagnostic ordering only.
// It is NOT the guest's outside-writer exclusion or its atomic commit boundary.
const hostLocks = new WeakMap<object, Semaphore.Semaphore>()

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
 * Versioned hosts capture bases under a local semaphore until scope exit.
 * Ordinary hosts hold all named files using exclusive mkdir, so independently
 * composed hosts and processes agree.
 * A hash collision only refuses an unrelated edit; it cannot lose exclusion.
 *
 * @private
 * @since 1.0.0
 */
export const acquire = (
  fileSystem: FileSystem.FileSystem,
  paths: ReadonlyArray<string>,
  creationPaths?: Path.Path
): Effect.Effect<Mutation, StdError.StdError, Scope.Scope> =>
  Effect.gen(function*() {
    // Unavailable coding providers refuse before acquiring even protocol state.
    // The versioned provider owns exclusion and revalidation at its commit;
    // cooperative caller-side locks cannot exclude terminal or SSH writers.
    yield* validate(fileSystem, paths)
    const policy = (fileSystem as VersionedFileSystem)[Preconditions]
    if (policy !== undefined) {
      let lock = hostLocks.get(policy)
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1)
        hostLocks.set(policy, lock)
      }
      const held = lock
      yield* Effect.acquireRelease(held.take(1), () => held.release(1), { interruptible: true })
      const session = yield* ReadSession
      const prepared = yield* policy.prepare!(paths, session)
      return { read: (path) => prepared.read(path), commit: (changes) => prepared.commit(changes) }
    }
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
    return { read: (_path, ordinary) => ordinary, commit: (_changes, ordinary) => ordinary }
  })
