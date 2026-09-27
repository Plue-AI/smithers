/**
 * Directory listing, flat or recursive, over a ZenFS-shaped backend.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"
import { normalizePath } from "./normalizePath.ts"
import { platformError } from "./platformError.ts"
import { realPath } from "./realPath.ts"
import type { ZenFsPromisesLike } from "./ZenFsPromisesLike.ts"
import type { ZenFsStatsLike } from "./ZenFsStatsLike.ts"

// Listing without canonicalization remains bounded by maximumDepth below.
const directoryIdentity = (fs: ZenFsPromisesLike, path: string) =>
  fs.realpath === undefined ? Effect.succeed(normalizePath(path)) : realPath(fs, path, "readDirectory")

/**
 * How many levels a walk descends when nothing else can stop it.
 *
 * A backend with `lstat` never follows a directory symlink, and one with
 * `realpath` closes a loop by identity, so neither needs a ceiling and a
 * legitimately deep tree is walked whole. A backend with neither follows the
 * link and reports a fresh pathname at every level, so that walk, and only
 * that walk, is bounded.
 *
 * @private
 */
const maximumDepth = 128

/**
 * `true` when the backend can neither avoid following a directory symlink nor
 * recognize one it has already visited.
 *
 * @private
 */
const unbounded = (fs: ZenFsPromisesLike): boolean => fs.lstat === undefined && fs.realpath === undefined

/**
 * The names directly inside one directory, in the backend's own array.
 *
 * @private
 */
const entriesOf = (
  fs: ZenFsPromisesLike,
  at: string
): Effect.Effect<Array<string>, PlatformError.PlatformError> =>
  Effect.tryPromise({ try: () => fs.readdir(at), catch: platformError("readDirectory", at) })

/**
 * One entry's own stats, without following a symlink when the backend can
 * avoid it. Node's recursive listing classifies entries by their directory
 * entry type, so a symlink to a directory is listed and not descended into;
 * `lstat` reproduces that. A backend with only `stat` follows the link, which
 * is why {@link collect} also carries a visited set.
 *
 * @private
 */
const inspect = (
  fs: ZenFsPromisesLike,
  at: string
): Effect.Effect<ZenFsStatsLike, PlatformError.PlatformError> => {
  // `.call(fs, ...)` keeps the receiver: a backend whose promises API is a
  // class instance loses `this` when the member is called through a captured
  // reference.
  const stats = fs.lstat ?? fs.stat
  return Effect.tryPromise({ try: () => stats.call(fs, at), catch: platformError("readDirectory", at) })
}

/**
 * Every entry below `directory`, named relative to the directory the caller
 * asked about, depth first in backend order.
 *
 * @private
 */
const collect = (
  fs: ZenFsPromisesLike,
  directory: string,
  prefix: string,
  seen: Set<string>,
  depth: number
): Effect.Effect<Array<string>, PlatformError.PlatformError> =>
  Effect.gen(function*() {
    if (depth > maximumDepth && unbounded(fs)) {
      return yield* Effect.fail(PlatformError.systemError({
        _tag: "BadResource",
        module: "FileSystem",
        method: "readDirectory",
        pathOrDescriptor: directory,
        description:
          `a directory link loops, or the tree is nested more than ${maximumDepth} levels deep, and this backend has neither lstat nor realpath to tell them apart`
      }))
    }
    const collected: Array<string> = []
    // The mount root already ends in the separator: joining under it verbatim
    // would hand the backend `//name`, which a backend keyed by exact path
    // cannot find.
    const parent = directory === "/" ? "" : directory
    for (const name of yield* entriesOf(fs, directory)) {
      const relative = prefix === "" ? name : `${prefix}/${name}`
      collected.push(relative)
      const child = `${parent}/${name}`
      const stats = yield* inspect(fs, child)
      if (!stats.isDirectory()) continue
      const canonical = yield* directoryIdentity(fs, child)
      if (seen.has(canonical)) continue
      seen.add(canonical)
      // Appended rather than spread: a wide subtree spread into `push` passes
      // one argument per entry and overflows the call stack.
      for (const entry of yield* collect(fs, child, relative, seen, depth + 1)) collected.push(entry)
    }
    return collected
  })

/**
 * Lists a directory, honouring `recursive` rather than dropping it.
 *
 * Effect documents `recursive` as "recursively list the contents of nested
 * directories", and `NodeFileSystem` honours it, so a flow that lists a tree
 * under `NodeHost` must not quietly lose every nested entry under
 * `BrowserHost`. The slice has no recursive `readdir`, so the walk is done
 * here with the members it does have, emitting the same `parent/child` shape
 * Node emits.
 *
 * The array returned is the caller's. The walk builds its own, and the flat
 * listing copies the backend's, so a backend that answers `readdir` from the
 * array it stores is neither changed through a result nor able to change one.
 *
 * @private
 * @since 1.0.0-rc.0
 * @slop
 */
export const readDirectory = (
  fs: ZenFsPromisesLike,
  path: string,
  options?: { readonly recursive?: boolean | undefined }
): Effect.Effect<Array<string>, PlatformError.PlatformError> =>
  options?.recursive === true
    ? Effect.flatMap(
      directoryIdentity(fs, path),
      (canonical) => collect(fs, path, "", new Set([canonical]), 0)
    )
    : Effect.map(entriesOf(fs, path), (names) => [...names])
