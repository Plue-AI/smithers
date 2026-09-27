/**
 * Error mapping from thrown ZenFS/Node errors onto `PlatformError`.
 *
 * @since 1.0.0-rc.0
 */

import * as PlatformError from "effect/PlatformError"

/**
 * The Node-style `code` a thrown value carries, or `undefined`.
 *
 * @private
 */
const codeOf = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined

/**
 * The `SystemErrorTag` each Node error code normalizes onto.
 *
 * Every tag here is one `effect/PlatformError` already declares, and every
 * code is one both ZenFS and `node:fs/promises` raise. Collapsing them onto
 * `Unknown` would throw away the one thing a caller can branch on: `exists`
 * has to tell "not there" from "could not look", and a guarded kernel path
 * inspecting `error.reason._tag` has to tell a permission refusal from a
 * malfunction.
 *
 * @private
 */
const tags: Readonly<Record<string, PlatformError.SystemErrorTag>> = {
  EACCES: "PermissionDenied",
  EBUSY: "Busy",
  EEXIST: "AlreadyExists",
  EISDIR: "BadResource",
  ELOOP: "BadResource",
  ENOENT: "NotFound",
  ENOTDIR: "BadResource",
  EPERM: "PermissionDenied"
}

/**
 * Map a thrown ZenFS/Node error onto a `PlatformError`, mirroring how effect's
 * own platform implementations construct one: a normalized `_tag`, the module
 * and method that failed, the path, and the original `cause` kept intact.
 *
 * @private
 * @since 1.0.0-rc.0
 * @slop
 */
export const platformError = (method: string, path: string) => (cause: unknown): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: tags[codeOf(cause) ?? ""] ?? "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: cause instanceof Error ? cause.message : String(cause),
    cause
  })
