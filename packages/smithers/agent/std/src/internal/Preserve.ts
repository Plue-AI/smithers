/**
 * Per-file atomic replacement that preserves permission bits and ownership.
 * The sibling is complete before rename; no crash-durability guarantee is made.
 * A file whose owner this process cannot assign is rewritten in place instead.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import type * as PlatformError from "effect/PlatformError"

const permissions = 0o7777

/**
 * Replaces a file's text atomically, preserving its permission bits and owner.
 *
 * @category filesystem
 * @since 1.0.0
 */
export const writeFileString = (
  fileSystem: FileSystem.FileSystem,
  path: string,
  content: string
): Effect.Effect<void, PlatformError.PlatformError> =>
  replace(fileSystem, path, (target, flag, mode) => fileSystem.writeFileString(target, content, { flag, mode }))

/**
 * Replaces a file's bytes with the same atomic boundary used for text writes.
 *
 * @category filesystem
 * @since 1.0.0
 */
export const writeFile = (
  fileSystem: FileSystem.FileSystem,
  path: string,
  content: Uint8Array
): Effect.Effect<void, PlatformError.PlatformError> =>
  replace(fileSystem, path, (target, flag, mode) => fileSystem.writeFile(target, content, { flag, mode }))

const replace = (
  fileSystem: FileSystem.FileSystem,
  path: string,
  write: (
    target: string,
    flag: "wx" | "w",
    mode: number | undefined
  ) => Effect.Effect<void, PlatformError.PlatformError>
): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.gen(function*() {
    const before = yield* fileSystem.stat(path).pipe(
      Effect.catch((error) => error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error))
    )
    // Keep following an existing symlink, as an in-place write did.
    const destination = before === undefined ? path : yield* fileSystem.realPath(path)
    const temporary = destination.replace(/[^/\\]+$/, `.smithers-${globalThis.crypto.randomUUID()}.tmp`)
    let owned = true
    // Set when the sibling cannot take the file's owner; see the chown below.
    let inPlace = false
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function*() {
        // Let the host finish its write before cancellation can unlink the name.
        yield* write(temporary, "wx", before === undefined ? undefined : before.mode & permissions).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (error.reason._tag === "AlreadyExists") owned = false
            })
          )
        )
        yield* restore(Effect.gen(function*() {
          if (before === undefined) return
          const after = yield* fileSystem.stat(temporary)
          const uid = Option.getOrUndefined(before.uid)
          const gid = Option.getOrUndefined(before.gid)
          const ownerChanged = (uid !== undefined && uid !== Option.getOrUndefined(after.uid)) ||
            (gid !== undefined && gid !== Option.getOrUndefined(after.gid))
          if (ownerChanged) {
            // Only root may give a file away. A writable file owned by another
            // user (a shared checkout, a bind mount) cannot be replaced by a
            // sibling this process owns without changing its owner, so it is
            // rewritten in place instead: same inode, owner, and mode, at the
            // cost of atomicity.
            const chowned = yield* fileSystem.chown(temporary, uid ?? -1, gid ?? -1).pipe(
              Effect.as(true),
              Effect.catch((error) =>
                error.reason._tag === "PermissionDenied" ? Effect.succeed(false) : Effect.fail(error)
              )
            )
            if (!chowned) {
              inPlace = true
              return
            }
          }
          // chown may clear set-id bits, so permissions are restored last.
          if (ownerChanged || (after.mode & permissions) !== (before.mode & permissions)) {
            yield* fileSystem.chmod(temporary, before.mode & permissions)
          }
        }))
        if (!inPlace) yield* fileSystem.rename(temporary, destination)
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() => owned ? fileSystem.remove(temporary, { force: true }).pipe(Effect.orDie) : Effect.void)
        )
      )
    )
    if (inPlace) yield* write(destination, "w", undefined)
  })
