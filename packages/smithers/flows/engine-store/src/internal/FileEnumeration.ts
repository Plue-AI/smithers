/**
 * Workspace-relative file enumeration for glob and tree-artifact expansion.
 *
 * The host `glob` is deliberately not consulted. Two divergences make it the
 * wrong oracle for a declared pattern: the kernel `FileSystem` absolutizes
 * patterns against the workspace root and returns absolute paths, so a
 * workspace-relative matcher filters every result out; and Node's matcher
 * skips dotfiles, which `FileSet.matchesPattern` — and Bazel's glob — cover.
 * Walking `readDirectory` and filtering through `FileSet` keeps every
 * expansion byte-identical to the matcher the plan's overlap passes use, in
 * the one coordinate system declarations are written in.
 *
 * @since 0.1.0
 */

import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as FileSet from "@smthrs/plan/FileSet"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"

/** Bounded metadata reads, preserving the input order and typed failures. */
const metadata = <A>(
  fs: FileSystem.FileSystem,
  paths: ReadonlyArray<string>,
  operation: "stat" | "readDirectory",
  fallback: (path: string) => Effect.Effect<A, PlatformError.PlatformError>
): Effect.Effect<ReadonlyArray<A>, PlatformError.PlatformError> =>
  Effect.gen(function*() {
    const batch = KernelFileSystem.batch(fs)
    if (batch === undefined) {
      return yield* Effect.forEach(paths, (path) => fallback(path), {
        concurrency: KernelFileSystem.fallbackConcurrency
      })
    }
    const values: Array<A> = []
    for (let offset = 0; offset < paths.length; offset += batch.maxSize) {
      const response = yield* batch.execute(
        paths.slice(offset, offset + batch.maxSize).map((path) => ({ operation, path }))
      )
      for (const entry of [...response.entries].sort((a, b) => a.index - b.index)) {
        const value = yield* Effect.fromResult(entry.result)
        values.push(
          (value.operation === "stat"
            ? value.info
            : (value as Extract<KernelFileSystem.BatchValue, { readonly paths: unknown }>).paths) as A
        )
      }
    }
    return values
  })

/**
 * The default maximum number of directory entries visited by one expansion.
 *
 * @since 1.0.0
 * @category constants
 */
export const defaultMaxEntries = 100_000

/**
 * The stable error code returned when enumeration exceeds its safety bound.
 *
 * @since 1.0.0
 * @category errors
 */
export const FileEnumerationErrorCode = Schema.Literal("entry_limit_exceeded")

/**
 * The stable error code returned when enumeration exceeds its safety bound.
 *
 * @since 1.0.0
 * @category errors
 */
export type FileEnumerationErrorCode = typeof FileEnumerationErrorCode.Type

/**
 * A workspace enumeration exceeded its configured entry limit.
 *
 * @since 1.0.0
 * @category errors
 */
export class FileEnumerationError extends Schema.TaggedError<FileEnumerationError>()(
  "@smthrs/engine-store/FileEnumerationError",
  {
    code: FileEnumerationErrorCode,
    message: Schema.String,
    pattern: Schema.String,
    limit: Schema.Number,
    cause: Schema.Unknown
  }
) {}

/**
 * How an enumeration talks to a FileSystem that does not speak
 * workspace-relative paths.
 *
 * @since 0.1.0
 * @category models
 */
export interface EnumerationOptions {
  /**
   * Maps a workspace-relative path (`""` names the workspace root) to the
   * coordinate the FileSystem expects. Defaults to the identity, with `""`
   * spelled `"."`.
   */
  readonly resolve?: (path: string) => string
  /**
   * Maximum number of directory entries one expansion may visit. Defaults to
   * {@link defaultMaxEntries}. Enumeration fails instead of returning a
   * partial result when the walk exceeds this bound.
   */
  readonly maxEntries?: number | undefined
}

/** @internal */
const defaultResolve = (path: string): string => path === "" ? "." : path

const ignoredDirectoryNames = new Set([".git", ".jj", "node_modules"])

interface EnumerationBudget {
  readonly limit: number
  count: number
  pattern: string
}

const budgetFor = (pattern: string, options: EnumerationOptions): EnumerationBudget => ({
  limit: options.maxEntries ?? defaultMaxEntries,
  count: 0,
  pattern
})

const explicitIgnoredDirectories = (patterns: Iterable<string>): ReadonlySet<string> => {
  const explicit = new Set<string>()
  for (const pattern of patterns) {
    for (const part of pattern.replaceAll("\\", "/").split("/")) {
      if (ignoredDirectoryNames.has(part)) explicit.add(part)
    }
  }
  return explicit
}

const visit = (budget: EnumerationBudget): Effect.Effect<void, FileEnumerationError> => {
  budget.count += 1
  if (budget.count <= budget.limit) return Effect.void
  const message = `enumerating pattern ${JSON.stringify(budget.pattern)} exceeded the ${budget.limit}-entry limit`
  return Effect.fail(
    new FileEnumerationError({
      code: "entry_limit_exceeded",
      pattern: budget.pattern,
      limit: budget.limit,
      message,
      cause: new RangeError(message)
    })
  )
}

interface EnumeratedEntries {
  readonly files: ReadonlyArray<string>
  readonly directories: ReadonlyArray<string>
}

const enumerateUnder = (
  fs: FileSystem.FileSystem,
  dir: string,
  resolve: (path: string) => string,
  budget: EnumerationBudget,
  pruneIgnoredDirectories: boolean,
  explicit: ReadonlySet<string> = new Set()
): Effect.Effect<EnumeratedEntries, PlatformError.PlatformError | FileEnumerationError> =>
  Effect.gen(function*() {
    // A directory that is not there enumerates to nothing, and its own
    // listing reports that with `NotFound` — so no `exists` probe precedes
    // it. The probe asked the question the very next call answers anyway, and
    // on a confined host every host call is one CPython fork
    // (`@smthrs/platform-node/AtomicFileSystem`), so it doubled the cost of
    // reaching the walk root. Only the root is probed this way; a subtree
    // discovered by `stat` inside the walk is read without a net, exactly as
    // before, so a listing that refuses there still fails the expansion.
    const root = yield* metadata(fs, [resolve(dir)], "readDirectory", fs.readDirectory).pipe(
      Effect.map((values) => values[0]!),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined))
    )
    // The absent root is the one case that reports no directories at all: a
    // tree replay must not be told to prune scaffolding that never existed.
    if (root === undefined) return { files: [], directories: [] }

    const files: Array<string> = []
    const directories: Array<string> = [dir]
    const pending = [{ path: dir, entries: [...root].sort(), index: 0 }]
    const size = KernelFileSystem.batch(fs)?.maxSize ?? KernelFileSystem.fallbackConcurrency
    while (pending.length > 0) {
      const paths: Array<string> = []
      // Fill one batch from all queued listings. A tree with one file in each
      // of many sibling directories must not start one helper per leaf.
      while (paths.length < size && pending.length > 0) {
        const current = pending[pending.length - 1]!
        if (current.index === current.entries.length) {
          pending.pop()
          continue
        }
        yield* visit(budget)
        const relative = current.entries[current.index++]!.replaceAll("\\", "/")
        paths.push(current.path === "" ? relative : `${current.path}/${relative}`)
      }
      const infos = yield* metadata(fs, paths.map(resolve), "stat", fs.stat)
      const children: Array<string> = []
      for (const [index, path] of paths.entries()) {
        const info = infos[index]!
        if (info.type === "File") {
          files.push(path)
          continue
        }
        if (info.type !== "Directory") continue
        const name = path.slice(path.lastIndexOf("/") + 1)
        if (pruneIgnoredDirectories && ignoredDirectoryNames.has(name) && !explicit.has(name)) continue
        directories.push(path)
        children.push(path)
      }
      const listings = yield* metadata(fs, children.map(resolve), "readDirectory", fs.readDirectory)
      for (const [index, path] of children.entries()) {
        pending.push({ path, entries: [...listings[index]!].sort(), index: 0 })
      }
    }
    return { files: files.sort(), directories: directories.sort() }
  })

/**
 * Every file under `dir` (workspace-relative; `""` for the workspace root),
 * as sorted workspace-relative paths. A missing directory enumerates to
 * nothing — a zero-match expansion is legal, so absence is a fact rather than
 * a failure. This declared-tree walk does not prune `.git`, `.jj`, or
 * `node_modules`. Those names are part of the tree identity and must be
 * captured and restored exactly.
 *
 * @since 0.1.0
 * @category accessors
 */
export const filesUnder = (
  fs: FileSystem.FileSystem,
  dir: string,
  options: EnumerationOptions = {}
): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError | FileEnumerationError> =>
  Effect.gen(function*() {
    const resolve = options.resolve ?? defaultResolve
    return (yield* enumerateUnder(
      fs,
      dir,
      resolve,
      budgetFor(dir === "" ? "**" : `${dir}/**`, options),
      false
    )).files
  })

/**
 * Every file and every directory under `dir` (workspace-relative, non-empty),
 * as sorted workspace-relative paths. The directory list includes `dir`
 * itself, so a tree replay can audit exactly the scaffolding it may have to
 * prune. A missing directory enumerates to nothing — a tree that matched
 * nothing is legal, so absence is a fact rather than a failure. This
 * declared-tree walk does not prune `.git`, `.jj`, or `node_modules` because
 * replay needs every directory and file that contributes to the tree.
 *
 * @since 0.1.0
 * @category accessors
 */
export const entriesUnder = (
  fs: FileSystem.FileSystem,
  dir: string,
  options: EnumerationOptions = {}
): Effect.Effect<
  { readonly files: ReadonlyArray<string>; readonly directories: ReadonlyArray<string> },
  PlatformError.PlatformError | FileEnumerationError
> =>
  Effect.gen(function*() {
    const resolve = options.resolve ?? defaultResolve
    return yield* enumerateUnder(fs, dir, resolve, budgetFor(`${dir}/**`, options), false)
  })

/**
 * The longest directory prefix of a pattern that contains no wildcard — the
 * subtree a walk has to visit. `src/**` walks `src`; `*.txt` walks the root.
 *
 * @since 0.1.0
 * @category accessors
 */
export const staticPrefix = (pattern: string): string => {
  const segments = pattern.replaceAll("\\", "/").split("/")
  const fixed: Array<string> = []
  for (const segment of segments.slice(0, -1)) {
    if (segment.includes("*")) break
    fixed.push(segment)
  }
  return fixed.join("/")
}

/**
 * Expands one glob against the workspace: walk each include's static prefix,
 * keep the files `FileSet.matchesGlob` covers. Sorted and deduplicated, so
 * expansion is deterministic. A glob walk prunes `.git`, `.jj`, and
 * `node_modules` unless an include sharing that walk prefix names the
 * directory as a path segment. This keeps a root glob from traversing
 * repository metadata and dependency trees while preserving an explicitly
 * declared match after either a fixed or wildcard segment.
 *
 * @since 0.1.0
 * @category accessors
 */
export const expandGlob = (
  fs: FileSystem.FileSystem,
  glob: FileSet.Glob,
  options: EnumerationOptions = {}
): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError | FileEnumerationError> =>
  Effect.gen(function*() {
    const resolve = options.resolve ?? defaultResolve
    const matched = new Set<string>()
    const budget = budgetFor("", options)
    const groups = new Map<string, Array<string>>()
    for (const include of glob.include) {
      const prefix = staticPrefix(include)
      const group = groups.get(prefix)
      if (group === undefined) groups.set(prefix, [include])
      else group.push(include)
    }
    for (const [prefix, includes] of groups) {
      budget.pattern = includes[0]!
      const explicit = explicitIgnoredDirectories(includes)
      for (const path of (yield* enumerateUnder(fs, prefix, resolve, budget, true, explicit)).files) {
        if (FileSet.matchesGlob(glob, path)) matched.add(path)
      }
    }
    return [...matched].sort()
  })
