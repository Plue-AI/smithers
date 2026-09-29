/**
 * Filesystem helpers shared by the scanners: a bounded directory walk with the
 * project ignore rules, and read helpers that turn a missing or unreadable file
 * into a typed `io` failure rather than a defect.
 *
 * @since 1.0.0-rc.0
 * @private
 */

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import { io, type MigrateError } from "../MigrateError.ts"

/**
 * Directory names the scanner never descends into.
 *
 * `.smithers/executions`, `.smithers/runs`, and `.smithers/logs` hold run
 * state, which the tool reports on but never reads as source. `.flows` is the
 * new runtime's state directory and is not part of a 0.x project.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const ignoredDirectories: ReadonlyArray<string> = [
  ".flows",
  ".git",
  ".jj",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor"
]

/**
 * Paths, relative to the project root, that the walk skips wholesale.
 *
 * The keys are written from the project root. When the root *is* the pack
 * directory, the walk matches them again with the `.smithers/` prefix restored,
 * so pointing the tool at `<project>/.smithers` skips the same run state as
 * pointing it at `<project>`. Without that, a real pack costs the walk every
 * execution log and every worktree checkout under it: Plue's pack holds 2,465
 * execution files and 81,864 worktree files beside 500 source files.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const ignoredPaths: ReadonlyArray<string> = [
  ".smithers-migrate",
  ".smithers/executions",
  ".smithers/logs",
  ".smithers/node_modules",
  ".smithers/runs",
  ".smithers/sandboxes",
  ".smithers/state",
  ".smithers/workflows/.worktrees"
]

/**
 * The walk's bounds. A 0.x project is application source, so an unbounded walk
 * over a monorepo checkout would spend minutes in directories the tool never
 * reads.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const maxDepth = 12

/**
 * The largest file the scanners read. A source file is application code; a
 * file past this size is an asset, a log, or a database that leaked into the
 * source tree, and reading it would spend the process on text no scanner
 * uses. The skip is reported, never silent.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const maxFileBytes = 8 * 1024 * 1024

/**
 * One path a walk did not descend into or read, and why.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Skipped {
  readonly path: string
  readonly reason: "unreadable" | "depth" | "symlink"
  readonly message: string
}

/**
 * What a walk found and what it could not: the files, and every skip.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Walked {
  readonly files: ReadonlyArray<string>
  readonly skipped: ReadonlyArray<Skipped>
}

/**
 * Options for {@link walk}.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface WalkOptions {
  readonly ignore?: ReadonlyArray<string> | undefined
  readonly maxDepth?: number | undefined
}

const relative = (root: string, path: Path.Path, absolute: string): string => {
  const value = path.relative(root, absolute)
  return value.split(path.sep).join("/")
}

/**
 * Lists every file under `root`, as paths relative to `root` with `/`
 * separators, sorted, and every directory the walk could not read or would
 * not descend into.
 *
 * A directory the operator cannot read, and a directory past {@link maxDepth},
 * are recorded rather than dropped: a scan that left something out has to say
 * so, because a plan built on it may be incomplete and `Gate` refuses to apply
 * one. A path that vanished between the listing and the stat is not a skip;
 * it was not there.
 *
 * Symbolic links are never followed. A link whose target resolves inside the
 * project is left out silently, because the target is walked on its own path
 * (or is ignored on its own path). A link that leads out of the project is a
 * `symlink` skip: its content is not the project's, and reading it would copy
 * a file from outside the root into the scan, the report, and the archive. A
 * dangling link holds nothing and is left out.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const walkReport = (
  root: string,
  options: WalkOptions = {}
): Effect.Effect<Walked, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const ignored = new Set([...ignoredPaths, ...(options.ignore ?? [])])
    const limit = options.maxDepth ?? maxDepth
    const found: Array<string> = []
    const skipped: Array<Skipped> = []
    const realRoot = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root))
    // A root whose own name is `.smithers` is a pack directory, so the keys
    // above still apply once their prefix is put back.
    const packPrefix = path.basename(root) === ".smithers" ? ".smithers/" : undefined
    const isIgnored = (key: string): boolean =>
      ignored.has(key) || (packPrefix !== undefined && ignored.has(`${packPrefix}${key}`))

    const visit = (directory: string, depth: number): Effect.Effect<void> =>
      Effect.gen(function*() {
        const key = relative(root, path, directory)
        if (depth > limit) {
          skipped.push({
            path: key,
            reason: "depth",
            message: `"${key}" is more than ${limit} directories deep and was not scanned`
          })
          return
        }
        const listed = yield* Effect.result(fs.readDirectory(directory))
        if (listed._tag === "Failure") {
          skipped.push({
            path: key === "" ? "." : key,
            reason: "unreadable",
            message: `"${key === "" ? "." : key}" could not be listed: ${listed.failure.message}`
          })
          return
        }
        for (const name of listed.success.slice().sort()) {
          if (ignoredDirectories.includes(name)) continue
          const absolute = path.join(directory, name)
          const child = relative(root, path, absolute)
          if (isIgnored(child)) continue
          if (Option.isSome(yield* fs.readLink(absolute).pipe(Effect.option))) {
            const real = yield* fs.realPath(absolute).pipe(Effect.option)
            if (real._tag === "Some" && !contains(path, realRoot, real.value)) {
              skipped.push({
                path: child,
                reason: "symlink",
                message: `"${child}" is a symbolic link that leads outside the project and was not scanned`
              })
            }
            continue
          }
          const info = yield* Effect.result(optionalNotFound(fs.stat(absolute)))
          if (info._tag === "Failure") {
            skipped.push({
              path: child,
              reason: "unreadable",
              message: `"${child}" could not be inspected: ${info.failure.message}`
            })
            continue
          }
          if (Option.isNone(info.success)) continue
          if (info.success.value.type === "Directory") {
            yield* visit(absolute, depth + 1)
          } else if (info.success.value.type === "File") {
            found.push(child)
          }
        }
      })

    yield* visit(root, 0)
    return { files: found.sort(), skipped: skipped.sort((left, right) => (left.path < right.path ? -1 : 1)) }
  })

/**
 * Lists every file under `root`, as paths relative to `root` with `/`
 * separators, sorted. The walk's skips are dropped; callers that have to
 * account for them use {@link walkReport}.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const walk = (
  root: string,
  options: WalkOptions = {}
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.map(walkReport(root, options), (walked) => walked.files)

/**
 * Lists every file under `root` with no ignore rules at all, as paths relative
 * to `root` with `/` separators, sorted. Returns nothing when `root` is not a
 * directory.
 *
 * {@link walk} exists to skip what a scanner must not read. This exists for the
 * opposite job: proving that a directory the tool must never write to holds
 * exactly the files it held before, which needs every one of them.
 *
 * A symbolic link is listed as an entry of its own and never followed: the
 * link is what sits in the directory, and following it would list files that
 * live somewhere else, or loop forever on a link to an ancestor.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const walkAll = (
  root: string
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const found: Array<string> = []
    const visit = (directory: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [] as Array<string>))
        for (const name of names.slice().sort()) {
          const absolute = path.join(directory, name)
          if (Option.isSome(yield* fs.readLink(absolute).pipe(Effect.option))) {
            found.push(relative(root, path, absolute))
            continue
          }
          const info = yield* fs.stat(absolute).pipe(Effect.option)
          if (info._tag === "None") continue
          if (info.value.type === "Directory") yield* visit(absolute)
          else if (info.value.type === "File") found.push(relative(root, path, absolute))
        }
      })
    const info = yield* fs.stat(root).pipe(Effect.option)
    if (info._tag === "None" || info.value.type !== "Directory") return []
    yield* visit(root)
    return found.sort()
  })

/** Whether `inner` is `outer` or lives under it, both absolute. */
const contains = (path: Path.Path, outer: string, inner: string): boolean => {
  const value = path.relative(outer, inner)
  return value === "" || (value !== ".." && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value))
}

/**
 * The target a symbolic link names, or `undefined` when `file` is not a link
 * (or is not there). The link itself is read, never followed.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const linkTarget = (file: string): Effect.Effect<string | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readLink(file).pipe(Effect.orElseSucceed(() => undefined))
  })

/**
 * The bytes a digest records for a symbolic link in place of its target's
 * content: the link's own text, so retargeting the link changes the digest
 * and nothing outside the project is ever read.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const linkRecord = (target: string): Uint8Array => new TextEncoder().encode(`symlink:${target}`)

/**
 * The first prefix of the project-relative `file` that is a symbolic link,
 * `file` itself included, or `undefined` when no component of the path is one.
 *
 * Reading, writing, or removing a project path through a link reaches
 * whatever the link names, which may be a file outside the project. A caller
 * that must touch only the project's own bytes refuses a path this returns a
 * prefix for.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const linkOnPath = (
  root: string,
  file: string
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const segments = file.split("/")
    for (let index = 1; index <= segments.length; index++) {
      const prefix = segments.slice(0, index).join("/")
      const absolute = path.join(root, ...segments.slice(0, index))
      if ((yield* linkTarget(absolute)) !== undefined) return prefix
      // Past the first missing component nothing deeper exists.
      if (!(yield* fs.exists(absolute).pipe(Effect.orElseSucceed(() => false)))) return undefined
    }
    return undefined
  })

/**
 * Turns the platform's typed `NotFound` into `None` and leaves every other
 * failure alone.
 *
 * Absence is the one filesystem answer a caller may act on without a person:
 * a file that is not there was not there. A permission error, a disk error,
 * or a path that is a directory is not absence, and treating it as absence is
 * how a rollback deletes a file it was supposed to restore.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const optionalNotFound = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError, R> =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none()))
  )

/**
 * Reads a UTF-8 file, or `undefined` when it does not exist. Any other
 * failure is an `io` error naming the file.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const readIfExists = (
  file: string,
  description: string = file
): Effect.Effect<string | undefined, MigrateError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* optionalNotFound(fs.readFileString(file)).pipe(
      Effect.mapError(io(`could not read "${description}"`))
    )
    return Option.isSome(text) ? text.value : undefined
  })

/**
 * Reads a UTF-8 file, or `undefined` when it does not exist or cannot be read.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const readOption = (
  file: string
): Effect.Effect<string | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined))
  })

/**
 * Reads a UTF-8 file and fails with `io` when it cannot be read.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const read = (
  file: string
): Effect.Effect<string, MigrateError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(file)
  }).pipe(Effect.mapError(io(`could not read "${file}"`)))

let atomicCounter = 0

/**
 * Writes a text file atomically: the whole text lands in a sibling temporary
 * file first, and one rename moves it over the target.
 *
 * A reader of the file — a person opening `pending-unit.json` after a crash,
 * the next run reading a unit artifact back — sees the old bytes or the new
 * ones, never half of each. The temporary name carries the pid so two
 * processes writing the same target never share one, and a counter so two
 * writes in one process never do. A crash between the write and the rename
 * leaves the temporary file behind; it matches {@link staleTemporary} and is
 * tolerated rather than reported as a foreign file.
 *
 * The caller keeps its own error mapping: this fails with the platform's
 * error, exactly as `fs.writeFileString` would.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const writeAtomic = (
  file: string,
  text: string
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${atomicCounter++}`)
    yield* fs.writeFileString(temporary, text).pipe(
      Effect.andThen(fs.rename(temporary, file)),
      // A failure after the temporary file landed must not leave it behind:
      // the report directory refuses entries that are not the tool's own.
      Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore))
    )
  })

/**
 * Whether a directory entry is a leftover of a crashed {@link writeAtomic}.
 *
 * The report directory's layout check refuses files that are not the tool's
 * own; a leftover temporary is the tool's own, interrupted. It is allowed to
 * stay rather than failing the next run, and it is overwritten by nothing —
 * the next atomic write takes a fresh name.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const isStaleTemporary = (entry: string): boolean => /^\..+\.tmp-\d+-\d+$/.test(entry)

/**
 * Reports whether a path exists.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const exists = (file: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
  })

/**
 * Reports whether a path is a directory.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const isDirectory = (file: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(file).pipe(Effect.option)
    return info._tag === "Some" && info.value.type === "Directory"
  })

/**
 * The 1-based line and column of a character offset in `source`.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const positionAt = (source: string, offset: number): { readonly line: number; readonly column: number } => {
  const before = source.slice(0, Math.max(0, offset))
  const lines = before.split("\n")
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 }
}
