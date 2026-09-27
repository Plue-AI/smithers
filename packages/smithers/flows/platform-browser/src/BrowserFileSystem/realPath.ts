/**
 * Canonicalization of a path inside the mounted volume: the backend's own
 * `realpath` when it has one, and a refusal when it does not, because a
 * lexical collapse cannot prove where a symlink resolves.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"
import { platformError } from "./platformError.ts"
import type { ZenFsPromisesLike } from "./ZenFsPromisesLike.ts"

/**
 * Roots a relative path without changing the order in which links and parent
 * segments resolve. A tab has no cwd, so its relative names begin at `/`.
 *
 * @private
 * @category utilities
 * @since 1.0.0-rc.0
 */
const rootPath = (path: string): string =>
  path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path) ? path : `/${path}`

/**
 * Resolves a path to its canonical absolute pathname, following symlinks when
 * the backend can follow them.
 *
 * Effect documents `realPath` as canonicalization, and it is load-bearing:
 * `@smthrs/kernel` resolves every guarded path through it before checking the
 * grant, so that a symlink cannot name a resource outside the workspace.
 * Returning the input verbatim would make that defense a no-op, so the
 * backend's own `realpath` is used whenever it has one. Its input is made
 * absolute without collapsing segments so the backend follows a link before
 * applying a later `..`. A volume without `realpath` is refused because lexical normalization
 * cannot prove where a symlink resolves.
 *
 * @private
 * @category utilities
 * @since 1.0.0-rc.0
 * @slop
 */
export const realPath = (
  fs: ZenFsPromisesLike,
  path: string,
  /** The operation to blame, for a caller that canonicalizes on the way to something else. */
  method = "realPath"
): Effect.Effect<string, PlatformError.PlatformError> => {
  const resolve = fs.realpath
  // Called through `fs` rather than through the captured reference: a backend
  // whose promises API is a class instance loses `this` otherwise, and every
  // other call in this adapter goes through the object.
  if (resolve !== undefined) {
    return Effect.tryPromise({ try: () => resolve.call(fs, rootPath(path)), catch: platformError(method, path) })
  }
  return Effect.fail(PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: "the browser backend does not support realPath"
  }))
}
