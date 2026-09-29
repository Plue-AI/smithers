/**
 * The repository as `memory` reads it: tracked directories, bounded file
 * heads, and one buffered command runner for jj and git.
 *
 * Read-only on purpose. jj is always run with `--ignore-working-copy`, so a
 * memory call never snapshots the working copy or writes an operation.

 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Stream from "effect/Stream"

/**
 * One directory's direct children, sorted. `""` is the repository root.
 *
 * @since 1.0.0
 * @private
 */
export interface Entry {
  readonly dirs: ReadonlyArray<string>
  readonly files: ReadonlyArray<string>
}

/**
 * The repository's directories, keyed by repository-relative path.
 *
 * @since 1.0.0
 * @private
 */
export type Tree = ReadonlyMap<string, Entry>

/** Directory names a filesystem walk never enters. */
const pruned = new Set(["node_modules", "dist", "target", "coverage", "tmp", "build", "out"])

/**
 * A file larger than this is never read: memory is not a code search.
 *
 * @since 1.0.0
 * @private
 */
export const maxFileBytes = 512_000

/**
 * The most files a filesystem walk lists before it stops.
 *
 * @since 1.0.0
 * @private
 */
export const maxWalkFiles = 50_000

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * `text` cut to at most `limit` UTF-8 bytes, never mid-character.
 *
 * @since 1.0.0
 * @private
 */
export const headOf = (text: string, limit: number): string => {
  const bytes = encoder.encode(text)
  if (bytes.byteLength <= limit) return text
  return decoder.decode(bytes.slice(0, limit)).replace(/�$/, "")
}

/**
 * A path that is not there is absence, answered with `value`; any other
 * failure (a denied read above all) is the host's, and fails.
 *
 * @since 1.0.0
 * @private
 */
export const absent = <A>(value: A) => (error: PlatformError.PlatformError) =>
  error.reason._tag === "NotFound" ? Effect.succeed(value) : Effect.fail(error)

/**
 * UTF-8 bytes of `text`.
 *
 * @since 1.0.0
 * @private
 */
export const size = (text: string): number => encoder.encode(text).byteLength

/**
 * Runs `command` with `args` in `cwd`; `undefined` when it cannot start or
 * exits non-zero. Absent history or notes is a fact about the repository,
 * never a memory failure.
 *
 * @since 1.0.0
 * @private
 */
export const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  Effect.scoped(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd }))
    const [stdout, , code] = yield* Effect.all(
      [collect(handle.stdout), Stream.runDrain(handle.stderr), handle.exitCode],
      { concurrency: 3 }
    )
    return code === 0 ? stdout : undefined
  })).pipe(Effect.catch(() => Effect.succeed(undefined)))

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  Stream.runFold(stream, () => "", (text, chunk: Uint8Array) => text + decoder.decode(chunk, { stream: true }))

/**
 * A repository-relative path, normalized, or `null` for an absolute or
 * escaping path and for private or runtime trees.
 *
 * @since 1.0.0
 * @private
 */
export const normalizePath = (value: string): string | null => {
  if (value.length === 0 || value.length > 4096 || /[\\\0]/.test(value) || value.startsWith("/")) return null
  if (!value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !/^\.(git|jj)$/i.test(part))) {
    return null
  }
  if (/^(?:\.flows|node_modules|Smithers-Ops)(?:\/|$)/i.test(value) || /(?:^|\/)\.env(?:\.|$)/.test(value)) return null
  return value
}

/**
 * Whether `file` is a link. A link is never read: jj tracks it as a link, and
 * its target may lie outside the root.
 *
 * @since 1.0.0
 * @private
 */
export const linked = (fs: FileSystem.FileSystem, file: string) =>
  fs.readLink(file).pipe(Effect.as(true), Effect.orElseSucceed(() => false))

/**
 * The real path of `relative` under `root` when it resolves inside `rootReal`
 * (the real path of `root`); `undefined` when absent or when a link, the leaf
 * or a parent directory, leads outside the root.
 *
 * @since 1.0.0
 * @private
 */
export const inside = (fs: FileSystem.FileSystem, path: Path.Path, rootReal: string, file: string) =>
  fs.realPath(file).pipe(
    Effect.catch(absent(undefined)),
    Effect.map((real) => real !== undefined && real.startsWith(`${rootReal}${path.sep}`) ? real : undefined)
  )

/**
 * Builds the directory map from repository-relative file paths.
 *
 * @since 1.0.0
 * @private
 */
export const fromPaths = (paths: ReadonlyArray<string>): Tree => {
  const dirs = new Map<string, { dirs: Set<string>; files: Array<string> }>()
  const at = (dir: string) => {
    let entry = dirs.get(dir)
    if (entry === undefined) {
      entry = { dirs: new Set(), files: [] }
      dirs.set(dir, entry)
    }
    return entry
  }
  at("")
  for (const path of paths) {
    const parts = path.split("/")
    for (let depth = 0; depth < parts.length; depth++) {
      const parent = parts.slice(0, depth).join("/")
      const name = parts.slice(0, depth + 1).join("/")
      if (depth === parts.length - 1) at(parent).files.push(name)
      else at(parent).dirs.add(name)
    }
  }
  return new Map(
    [...dirs].map(([dir, entry]) => [dir, { dirs: [...entry.dirs].sort(), files: entry.files.sort() }])
  )
}

/**
 * A path that is not there, or that the host will not let memory read, is skipped.
 *
 * @since 1.0.0
 * @private
 */
export const unreadable = <A>(value: A) => (error: PlatformError.PlatformError) =>
  error.reason._tag === "PermissionDenied" ? Effect.succeed(value) : absent(value)(error)

/**
 * The tracked files of `root`: jj's view of `@` under `root` when it is in a
 * jj workspace, else git's index under `root` when it is in a git repository,
 * otherwise a bounded filesystem walk that skips hidden and build directories,
 * never follows a link and skips a directory it may not list. Either way a
 * path {@link normalizePath} refuses is dropped.
 *
 * git lists tracked files only (`ls-files --cached`): an untracked file is
 * left out with the ignored ones, because an ignored secret and a new file
 * look alike to memory and a secret must never reach Jev.
 *
 * @since 1.0.0
 * @private
 */
export const tree = (root: string, limit: number = maxWalkFiles) =>
  Effect.gen(function*() {
    // `.` scopes the listing to `root`, and jj prints paths relative to the
    // directory it runs in, so a root below the workspace root lists no `../`.
    const listed = yield* run("jj", ["--ignore-working-copy", "file", "list", "."], root)
    if (listed !== undefined) return fromPaths(listed.split("\n").filter((line) => normalizePath(line) !== null))
    // git, like jj, prints paths relative to `root` and only those below it.
    const indexed = yield* run("git", ["ls-files", "--cached", "-z"], root)
    if (indexed !== undefined) return fromPaths(indexed.split("\0").filter((line) => normalizePath(line) !== null))
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const files: Array<string> = []
    const walk = (dir: string): Effect.Effect<void, PlatformError.PlatformError> =>
      Effect.gen(function*() {
        const names = yield* fs.readDirectory(path.join(root, dir)).pipe(Effect.catch(unreadable<Array<string>>([])))
        for (const name of names.sort()) {
          if (files.length >= limit) return
          if (name.startsWith(".") || pruned.has(name)) continue
          const relative = dir === "" ? name : `${dir}/${name}`
          // A link is never followed, as jj tracks it: a link to an ancestor
          // would walk forever and a link outward would leave the root.
          if (yield* linked(fs, path.join(root, relative))) continue
          const info = yield* fs.stat(path.join(root, relative)).pipe(Effect.catch(absent(undefined)))
          if (info?.type === "Directory") yield* walk(relative)
          else if (info?.type === "File") files.push(relative)
        }
      })
    yield* walk("")
    return fromPaths(files.filter((file) => normalizePath(file) !== null))
  })

/**
 * The first `limit` bytes of a repository file; `undefined` when absent,
 * unreadable (`PermissionDenied`, which `denied: "fail"` surfaces instead) or
 * a link.
 *
 * @since 1.0.0
 * @private
 */
export const head = (
  root: string,
  relative: string,
  limit: number,
  options: { readonly denied: "skip" | "fail" } = { denied: "skip" }
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(root, relative)
    // `fail` lets a denied read surface, for a path the task named.
    const skip = options.denied === "skip" ? unreadable : absent
    if (yield* linked(fs, file)) return undefined
    const info = yield* fs.stat(file).pipe(Effect.catch(skip(undefined)))
    if (info === undefined || info.type !== "File" || info.size > maxFileBytes) return undefined
    const text = yield* fs.readFileString(file).pipe(Effect.catch(skip(undefined)))
    return text === undefined || text.includes("\u0000") ? undefined : headOf(text, limit)
  })
