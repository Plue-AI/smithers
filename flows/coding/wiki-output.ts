/** Wiki publication paths are judged by where they really resolve, never lexically. */
import { Effect, FileSystem, Option, Path } from "effect"

/** The canonical location of a possibly-missing output, relative to the canonical repository. */
const resolveOutput = (repositoryPath: string, output: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem, path = yield* Path.Path
    const root = yield* fs.realPath(repositoryPath)
    const requested = path.resolve(repositoryPath, output)
    let ancestor = requested
    // Resolve existing ancestors before creating anything. A symlinked ancestor
    // can otherwise route a publication across the repository boundary.
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
    const inside = relative !== "" && !path.isAbsolute(relative) && relative !== ".." &&
      !relative.startsWith(`..${path.sep}`)
    return { canonical, inside, relative }
  })

/** Host-owned publication must never become an implementation workspace edit. */
export const separateWikiOutput = (repositoryPath: string, output: string) =>
  Effect.gen(function*() {
    const { canonical, inside, relative } = yield* resolveOutput(repositoryPath, output)
    if (inside || relative === "") {
      return yield* Effect.fail(
        new Error(
          "Coding wiki output must be outside the source workspace, including .flows; use a separate wiki directory"
        )
      )
    }
    return canonical
  })

/** A local generation writes its output and engine state only where it really lies inside the repository. */
export const containedWikiOutput = (repositoryPath: string, output: string) =>
  Effect.gen(function*() {
    const { canonical, inside } = yield* resolveOutput(repositoryPath, output)
    if (!inside) {
      return yield* Effect.fail(
        new Error(`Wiki path must resolve to a dedicated location inside --root, through no symlink out: ${output}`)
      )
    }
    return canonical
  })
