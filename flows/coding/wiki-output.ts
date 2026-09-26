/** Host-owned publication must never become an implementation workspace edit. */
import { Effect, FileSystem, Option, Path } from "effect"

export const separateWikiOutput = (repositoryPath: string, output: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem, path = yield* Path.Path
    const root = yield* fs.realPath(repositoryPath)
    const requested = path.resolve(repositoryPath, output)
    let ancestor = requested
    // Resolve existing ancestors before creating anything. A symlink outside the
    // workspace can otherwise route a seemingly separate publication back in.
    while (!(yield* fs.exists(ancestor))) {
      if (Option.isSome(yield* fs.readLink(ancestor).pipe(Effect.option))) {
        return yield* Effect.fail(new Error("Wiki output cannot contain a dangling symlink"))
      }
      const parent = path.dirname(ancestor)
      if (parent === ancestor) return yield* Effect.fail(new Error("Wiki output has no existing parent"))
      ancestor = parent
    }
    const canonical = path.resolve(yield* fs.realPath(ancestor), path.relative(ancestor, requested))
    const relative = path.relative(root, canonical)
    if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
      return yield* Effect.fail(
        new Error(
          "Coding wiki output must be outside the source workspace, including .flows; use a separate wiki directory"
        )
      )
    }
    return canonical
  })
