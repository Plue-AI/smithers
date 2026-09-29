/**
 * Where a saved flow's files land.
 *
 * A model that promotes the script it just ran produces three ordinary files —
 * the flow, its end-to-end test, and the fixture that test replays — and they
 * have to be written somewhere the next run can discover them. That "somewhere"
 * is not one thing: a checkout writes into the working tree, a browser host
 * writes into session storage it owns, and a test writes into a map it can
 * inspect. This module is the one contract all three satisfy, so
 * `PromoteFlows` never learns which one it is talking to.
 *
 * The store is also the last place an id is still just text. Every path a write
 * builds comes from it, so {@link validateId} runs before any of them are built
 * rather than after: `../escape` is refused as a bad id, not caught as a
 * surprising write outside the root.
 *
 * @since 0.1.0
 */

import * as Fault from "@smthrs/flow/Fault"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as RcMap from "effect/RcMap"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"

/**
 * Stable error codes returned by saved-flow storage.
 *
 * @category models
 * @since 0.1.0
 */
export const FlowStoreErrorCode = Schema.Literals([
  "invalid_id",
  "invalid_path",
  "write_failed",
  "unsupported"
])

/**
 * Stable error codes returned by saved-flow storage.
 *
 * @category models
 * @since 0.1.0
 */
export type FlowStoreErrorCode = typeof FlowStoreErrorCode.Type

/**
 * Error raised by saved-flow storage.
 *
 * Every message is written for the model that will read it back as a call
 * failure, because the cell that asked to save a flow is the only thing that
 * can correct the id or reissue the write.
 *
 * @category errors
 * @since 0.1.0
 */
export class FlowStoreError extends Schema.TaggedError<FlowStoreError>()(
  "@smthrs/agent/FlowStore/FlowStoreError",
  {
    code: FlowStoreErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}
Fault.register(
  "@smthrs/agent/FlowStore/FlowStoreError",
  {
    invalid_id: "factory",
    invalid_path: "factory",
    write_failed: "infra",
    unsupported: "bug"
  } satisfies Fault.Rows<FlowStoreErrorCode>
)

const error = (code: FlowStoreErrorCode, message: string, cause?: unknown): FlowStoreError =>
  new FlowStoreError({ code, message, ...(cause === undefined ? {} : { cause }) })

/**
 * The flow ids a router can route.
 *
 * One directory name, lowercase, and no separators: a saved flow is discovered
 * as `flows/<id>/flow.ts`, so an id is exactly what may stand between those two
 * slashes.
 *
 * @category models
 * @since 0.1.0
 */
export const idPattern = /^[a-z][a-z0-9-]*$/

/**
 * Refuses an id no flow directory could be named.
 *
 * @category constructors
 * @since 0.1.0
 */
export const validateId = (id: string): Effect.Effect<void, FlowStoreError> =>
  idPattern.test(id) ? Effect.void : Effect.fail(
    error(
      "invalid_id",
      `"${id}" is not a saveable flow id. Use lowercase letters, digits, and hyphens, starting with a letter, then save it again.`
    )
  )

/**
 * One flow the store already holds.
 *
 * @category models
 * @since 0.1.0
 */
export interface SavedFlow {
  /** The flow's id, which is also its directory name. */
  readonly id: string
  /** Every file the store holds for it, root-relative and sorted. */
  readonly files: ReadonlyArray<string>
}

/**
 * What one write recorded.
 *
 * @category models
 * @since 0.1.0
 */
export interface WriteResult {
  /** The paths that were written, in the order they were given. */
  readonly files: ReadonlyArray<string>
}

/**
 * Saved-flow storage operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  /**
   * Writes one flow's files, keyed by their root-relative paths.
   *
   * The keys are the caller's own paths and are reported back unchanged, so a
   * host that mounts its flows somewhere else still tells the model where the
   * files went in terms the model gave it.
   */
  readonly write: (
    id: string,
    files: Record<string, string>
  ) => Effect.Effect<WriteResult, FlowStoreError>
  /** Every flow the store holds, by id. */
  readonly list: () => Effect.Effect<ReadonlyArray<SavedFlow>, FlowStoreError>
}

/**
 * Service tag for saved-flow storage.
 *
 * @category services
 * @since 0.1.0
 */
export class FlowStore extends Context.Service<FlowStore, Service>()("@smthrs/agent/FlowStore") {}

/** Groups written paths into one entry per `flows/<id>/` prefix. */
const listPaths = (paths: Iterable<string>): ReadonlyArray<SavedFlow> => {
  const byId = new Map<string, Array<string>>()
  for (const path of paths) {
    const parts = path.split("/")
    if (parts.length < 3 || parts[0] !== "flows" || !idPattern.test(parts[1]!)) continue
    const id = parts[1]!
    const held = byId.get(id)
    if (held === undefined) byId.set(id, [path])
    else held.push(path)
  }
  return [...byId.keys()].sort().map((id) => ({ id, files: byId.get(id)!.sort() }))
}

/**
 * Refuses a map key that is not a clean file path under `flows/<id>/`.
 *
 * The in-memory store has no filesystem to resolve a path against, so the key
 * is the whole address: one that names another flow's directory, or a `.` or
 * `..` segment, would land beside the flow being saved rather than in it.
 */
const validateMemoryPath = (id: string, key: string): Effect.Effect<void, FlowStoreError> => {
  const prefix = `flows/${id}/`
  const rest = key.startsWith(prefix) ? key.slice(prefix.length).split("/") : []
  return rest.length > 0 && rest.every((segment) => segment !== "" && segment !== "." && segment !== "..")
    ? Effect.void
    : Effect.fail(error("invalid_path", `"${key}" is not a file path inside ${prefix}.`))
}

/**
 * Constructs a store over an in-memory map, keyed by path.
 *
 * The map is the caller's, so a test writes through the store and reads the
 * bytes back without a filesystem. The listing is derived from the keys rather
 * than tracked separately, which is what lets a host hand in a map it populated
 * itself and still have the flows in it be listable. Every key must be a file
 * path under `flows/<id>/`; the whole write is refused before any key is stored
 * otherwise.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeMemory = (written: Map<string, string> = new Map()): Service =>
  FlowStore.of({
    write: (id, files) =>
      Effect.gen(function*() {
        yield* validateId(id)
        for (const path of Object.keys(files)) yield* validateMemoryPath(id, path)
        for (const [path, source] of Object.entries(files)) written.set(path, source)
        return { files: Object.keys(files) }
      }),
    list: () => Effect.sync(() => listPaths(written.keys()))
  })

/** Whether a relative result from Path.relative leaves its starting directory. */
const isOutside = (path: Path.Path, relative: string): boolean =>
  path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)

/** Resolves a file path using the host's semantics before any filesystem mutation. */
const validatePath = (path: Path.Path, root: string, relative: string): Effect.Effect<string, FlowStoreError> => {
  const confined = path.relative(root, path.resolve(root, relative))
  return path.isAbsolute(relative) || confined === "" || isOutside(path, confined)
    ? Effect.fail(error("invalid_path", `"${relative}" is not a file path inside the flows root.`))
    : Effect.succeed(confined)
}

/** The components of an already resolved, confined relative path. */
const segmentsOf = (path: Path.Path, relative: string): ReadonlyArray<string> => relative.split(path.sep)

/** Whether a path is a symbolic link, reading one that cannot be read at all as not one. */
const isLink = (fs: FileSystem.FileSystem, target: string): Effect.Effect<boolean> =>
  fs.readLink(target).pipe(Effect.map(() => true), Effect.orElseSucceed(() => false))

/**
 * Refuses a path that reaches its file through a symbolic link.
 *
 * A lexically clean path is not yet a path inside the root. The workspace a run
 * saves into is a checkout the agent did not write, so the entry at
 * `flows/<id>/flow.ts`, or any directory above it, can already be a link to
 * somewhere else on the host, and an ordinary write follows the link rather
 * than the path. Every component below the root is read before anything is
 * created, so a planted link is reported back to the model instead of
 * overwriting the file it points at.
 */
const validateConfinement = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  relative: string
): Effect.Effect<void, FlowStoreError> =>
  Effect.gen(function*() {
    const walked: Array<string> = []
    for (const segment of segmentsOf(path, relative)) {
      walked.push(segment)
      if (yield* isLink(fs, path.join(root, ...walked))) {
        return yield* Effect.fail(error(
          "invalid_path",
          `"${relative}" leaves the flows root through the symbolic link at "${
            walked.join("/")
          }". Remove the link and save the flow again.`
        ))
      }
    }
  })

/** Creates checked parent directories without following an existing symbolic link. */
const prepareParent = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  relative: string
) =>
  Effect.gen(function*() {
    let directory = root
    for (const segment of segmentsOf(path, relative).slice(0, -1)) {
      directory = path.join(directory, segment)
      const child = directory
      yield* fs.makeDirectory(child).pipe(
        Effect.catch((cause) =>
          Effect.gen(function*() {
            if (yield* isLink(fs, child)) return yield* Effect.fail(cause)
            const info = yield* fs.stat(child)
            if (info.type !== "Directory") return yield* Effect.fail(cause)
          })
        )
      )
    }
  })

/** Stages all bytes and backups before replacing any target; rolls back failed publication. */
const publish = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  files: ReadonlyArray<readonly [string, string]>
): Effect.Effect<void, FlowStoreError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function*() {
      // A named, exclusive mkdir instead of makeTempDirectory: the capability
      // kernel's guarded filesystem, which every agent-reachable native host
      // composes, refuses the makeTemp* family (see Executable.reserveSibling).
      // A non-recursive mkdir fails when the name is taken, so the generation
      // is still this save's own.
      const generation = path.join(root, `.flow-store-${globalThis.crypto.randomUUID()}`)
      yield* fs.makeDirectory(generation)
      const entries = files.map(([relative, source], index) => ({
        relative,
        source,
        target: path.join(root, relative),
        staged: path.join(generation, `${index}.new`),
        backup: path.join(generation, `${index}.old`),
        existed: false
      }))
      let retainGeneration = false
      const result = yield* Effect.exit(Effect.gen(function*() {
        yield* restore(Effect.gen(function*() {
          for (const entry of entries) {
            yield* fs.writeFileString(entry.staged, entry.source, { flag: "wx" })
          }
          // Backups are copied before publishing, so even a disk-full error
          // while retaining old bytes cannot remove an existing destination.
          for (const entry of entries) {
            yield* validateConfinement(fs, path, root, entry.relative)
            yield* prepareParent(fs, path, root, entry.relative)
            const info = yield* fs.stat(entry.target).pipe(
              Effect.catch((cause) => cause.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(cause))
            )
            if (info !== undefined) {
              if (info.type !== "File") {
                return yield* Effect.fail(error("write_failed", `"${entry.relative}" is not a regular file.`))
              }
              yield* fs.copyFile(entry.target, entry.backup)
              entry.existed = true
            }
          }
        }))
        const published: Array<typeof entries[number]> = []
        // Publication and rollback are masked: interruption during staging
        // cleans up, while interruption after the first rename waits for the
        // complete set to be installed or restored.
        const installed = yield* Effect.exit(Effect.gen(function*() {
          for (const entry of entries) {
            yield* validateConfinement(fs, path, root, entry.relative)
            yield* fs.rename(entry.staged, entry.target)
            published.push(entry)
          }
        }))
        if (Exit.isFailure(installed)) {
          const failures: Array<unknown> = []
          for (const entry of published.reverse()) {
            const rollback = yield* Effect.exit(
              validateConfinement(fs, path, root, entry.relative).pipe(
                Effect.andThen(
                  entry.existed
                    ? fs.rename(entry.backup, entry.target)
                    : fs.remove(entry.target)
                )
              )
            )
            if (Exit.isFailure(rollback)) failures.push(rollback.cause)
          }
          if (failures.length > 0) {
            // Never delete the only surviving previous bytes if the host
            // also refuses recovery. Keep them at the reported location.
            retainGeneration = true
            return yield* Effect.fail(error(
              "write_failed",
              `could not restore the saved flow; recovery files remain at "${generation}"`,
              { publication: installed.cause, rollback: failures }
            ))
          }
          return yield* Effect.failCause(installed.cause)
        }
      }))
      if (!retainGeneration) yield* fs.remove(generation, { recursive: true })
      if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
    })
  ).pipe(Effect.mapError((cause) =>
    cause instanceof FlowStoreError ? cause : error("write_failed", "could not publish the saved flow", cause)
  ))

/** Active saves share a root lock even when hosts construct separate store instances. */
const WriteLocks = Context.Service<RcMap.RcMap<string, Semaphore.Semaphore>>("@smthrs/agent/FlowStore/WriteLocks")
const locksLayer = Layer.effect(WriteLocks, RcMap.make({ lookup: (_root: string) => Semaphore.make(1) }))
// The memo map shares the layer across active operations, including operations
// from different store instances. Their scopes release the final owner.
const lockOwners = Layer.makeMemoMapUnsafe()

const serializeWrite = <A, E>(root: string, write: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.scoped(Effect.gen(function*() {
    const services = yield* Layer.buildWithMemoMap(locksLayer, lockOwners, yield* Scope.Scope)
    const lock = yield* RcMap.get(Context.get(services, WriteLocks), root)
    return yield* lock.withPermit(write)
  }))

/**
 * Constructs a store over a directory on the host filesystem.
 *
 * Validates every path with the injected Path semantics and rejects symbolic
 * links below the root before staging. Writes to the same resolved root are
 * serialized within this process, including across store instances.
 * The entire file set and backups are staged inside the root before targets
 * are replaced by individual atomic renames. Publication failures restore the
 * previous files; interruption cleans staging or waits for publication to finish.
 * If recovery itself fails, backups remain at the location in the error.
 * Readers outside the store can observe publication in progress. This is not a
 * crash-durable transaction or a lock against other processes changing the tree.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeFileSystem = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string
): Service => {
  root = path.resolve(root)
  // Caller paths can overlap across ids. A root lock also protects those saves.
  const lockKey = path.sep === "\\" ? root.toLowerCase() : root
  return FlowStore.of({
    write: (id, files) =>
      serializeWrite(
        lockKey,
        Effect.gen(function*() {
          yield* validateId(id)
          const resolved: Array<readonly [string, string]> = []
          for (const [relative, source] of Object.entries(files)) {
            const confined = yield* validatePath(path, root, relative)
            for (const [previous] of resolved) {
              const between = path.relative(path.join(root, previous), path.join(root, confined))
              const reverse = path.relative(path.join(root, confined), path.join(root, previous))
              if (!isOutside(path, between) || !isOutside(path, reverse)) {
                return yield* Effect.fail(error("invalid_path", `"${relative}" overlaps another saved file path.`))
              }
            }
            resolved.push([confined, source])
          }
          for (const [relative] of resolved) yield* validateConfinement(fs, path, root, relative)
          yield* fs.makeDirectory(root, { recursive: true }).pipe(
            Effect.mapError((cause) => error("write_failed", "could not create the flows root", cause))
          )
          yield* publish(fs, path, root, resolved)
          return { files: Object.keys(files) }
        })
      ),
    list: () =>
      Effect.gen(function*() {
        const directory = path.join(root, "flows")
        // A directory that cannot be listed contributes nothing, which is the
        // same reading `WorkspaceObservation` takes of the same question. A
        // root that has never saved a flow has no `flows` directory at all, and
        // that is the state every host starts in rather than a failure.
        const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []))
        const paths: Array<string> = []
        for (const id of entries) {
          if (!idPattern.test(id)) continue
          const held = yield* fs.readDirectory(path.join(directory, id), { recursive: true }).pipe(
            Effect.orElseSucceed(() => [])
          )
          for (const relative of held) {
            const info = yield* fs.stat(path.join(directory, id, relative)).pipe(
              Effect.map((stat) => stat.type),
              // An entry that cannot be stated is not a file the store can
              // claim to hold: a dangling link is the ordinary way to produce
              // one, and reporting it would name a path nothing can read.
              Effect.orElseSucceed(() => "Unknown" as const)
            )
            if (info === "File") paths.push(`flows/${id}/${relative.split(path.sep).join("/")}`)
          }
        }
        return listPaths(paths)
      })
  })
}

/**
 * Constructs a store that saves nothing, optionally overriding operations.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => {
  const unavailable = (method: string) =>
    Effect.fail(
      error("unsupported", `This host has nowhere to save a flow, so ${method} is unavailable and no flow was saved.`)
    )
  return FlowStore.of({
    write: () => unavailable("FlowStore.write"),
    list: () => unavailable("FlowStore.list"),
    ...overrides
  })
}

/**
 * Provides a store over an in-memory map.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerMemory = (written: Map<string, string> = new Map()): Layer.Layer<FlowStore> =>
  Layer.succeed(FlowStore)(makeMemory(written))

/**
 * Provides a store over a directory on the host filesystem.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerFileSystem = (
  root: string
): Layer.Layer<FlowStore, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(FlowStore)(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      return makeFileSystem(fs, path, root)
    })
  )

/**
 * Provides a store that saves nothing.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<FlowStore> =>
  Layer.succeed(FlowStore)(makeNoop(overrides))
