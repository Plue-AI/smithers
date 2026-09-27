/**
 * Path checks for the portable filesystem adapter. These detect symlinks and
 * observed replacements, but cannot make pathname mutations atomic with the
 * check. Effect's FileSystem has no descriptor-relative rename or unlink.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"

/**
 * Checks one entry without accepting a symbolic link and returns a check that
 * also refuses a changed identity. Missing entries are allowed for creation.
 *
 * @category utilities
 * @since 1.0.0-rc.0
 */
export const guard = (
  fs: FileSystem.FileSystem,
  path: string,
  type: "Directory" | "File" = "Directory",
  expected?: FileSystem.File.Info
): Effect.Effect<Effect.Effect<void, PlatformError.PlatformError>, PlatformError.PlatformError> => {
  const refused = () =>
    PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "ArtifactPath",
      method: "guard",
      pathOrDescriptor: path,
      description: "artifact path is a symlink, has the wrong type, or was replaced"
    })
  const inspect = Effect.gen(function*() {
    const linked = yield* fs.readLink(path).pipe(
      Effect.as(true),
      Effect.catch((cause) => {
        // Node readlink uses EINVAL for an existing entry that is not a link.
        // Other failures, including an unsupported host capability, fail closed.
        const underlying = cause.cause
        return cause.reason._tag === "NotFound" ||
            (typeof underlying === "object" && underlying !== null && "code" in underlying &&
              underlying.code === "EINVAL")
          ? Effect.succeed(false)
          : Effect.fail(cause)
      })
    )
    if (linked) return yield* Effect.fail(refused())
    const info = yield* fs.stat(path).pipe(
      Effect.map(Option.some),
      Effect.catch((cause) => cause.reason._tag === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(cause))
    )
    if (Option.isSome(info) && info.value.type !== type) return yield* Effect.fail(refused())
    return info
  })
  const unchanged = (before: Option.Option<FileSystem.File.Info>, after: Option.Option<FileSystem.File.Info>) => {
    if (Option.isNone(before)) return Effect.void
    if (
      Option.isNone(after) || before.value.dev !== after.value.dev ||
      Option.getOrUndefined(before.value.ino) !== Option.getOrUndefined(after.value.ino)
    ) {
      return Effect.fail(refused())
    }
    return Effect.void
  }
  return Effect.gen(function*() {
    const before = yield* inspect
    yield* unchanged(Option.fromUndefinedOr(expected), before)
    return Effect.flatMap(inspect, (after) => unchanged(before, after))
  })
}
