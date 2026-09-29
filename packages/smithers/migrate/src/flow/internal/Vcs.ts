/**
 * The read-only version-control gate shared by launch and checkpoint creation.
 *
 * @since 1.0.0-rc.0
 * @private
 */

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Fs from "../../internal/Fs.ts"
import { io, make } from "../../MigrateError.ts"

const isDirectory = (target: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const info = yield* Fs.optionalNotFound(fs.stat(target))
    return Option.isSome(info) && info.value.type === "Directory"
  })

/**
 * Reads version-control metadata, preferring colocated jj. Git linked
 * worktrees and submodules use a .git file pointing to their metadata.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const detect = (root: string) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    if (yield* isDirectory(path.join(root, ".jj"))) return "jj" as const
    const gitPath = path.join(root, ".git")
    const gitInfo = yield* Fs.optionalNotFound(fs.stat(gitPath))
    if (Option.isSome(gitInfo)) {
      if (gitInfo.value.type === "Directory") return "git" as const
      if (gitInfo.value.type === "File") {
        const pointer = /^gitdir: (.+)\r?\n?$/.exec(yield* fs.readFileString(gitPath))?.[1]
        if (pointer !== undefined) {
          const gitDir = path.resolve(root, pointer)
          if (yield* isDirectory(gitDir)) {
            const head = yield* Fs.optionalNotFound(fs.stat(path.join(gitDir, "HEAD")))
            if (Option.isSome(head) && head.value.type === "File") return "git" as const
          }
        }
      }
    }
    return "none" as const
  })

/**
 * Refuses an unacknowledged copy-only checkpoint before any state is written.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const requireCheckpoint = (root: string, backupDir: string, allowNoVcs: boolean) =>
  Effect.gen(function*() {
    const vcs = yield* detect(root).pipe(Effect.mapError(io(`could not inspect version control under "${root}"`)))
    if (vcs === "none" && !allowNoVcs) {
      return yield* Effect.fail(make(
        "no-vcs",
        `"${root}" is under no version control, so a migration would have no way back. Initialize jj or git, or rerun with --allow-no-vcs to accept a file copy under ${backupDir} as the only checkpoint.`
      ))
    }
    return vcs
  })
