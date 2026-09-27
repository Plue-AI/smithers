/**
 * The Node host the workspace walk runs on.
 *
 * `WorkspaceObservation.fileSystemHost` spends two Effect `FileSystem` calls
 * on every entry: `readLink`, which fails with an error value on every regular
 * file, then `stat`. On this repository that was 3.4–5 s a measurement, twice
 * a frame, and a one-line `ctx.done()` answer reached the TUI 8 s after the
 * model wrote it. This host reads each entry's type off the directory listing,
 * so directories and symlinks cost no call at all, and measures a directory's
 * files with concurrent `lstat`s. `lstat` never follows a link, so the walk's
 * "a symlink is not part of the tree" rule holds without asking twice.
 *
 * Errors carry the tags Effect's own Node `FileSystem` gives them, so the walk
 * reads a vanished path and a denied one exactly as it does on the portable host.
 *
 * @since 1.0.0
 */

import type * as WorkspaceObservation from "@smthrs/agent/WorkspaceObservation"
import { Effect } from "effect"
import * as PlatformError from "effect/PlatformError"
import type { Dirent } from "node:fs"
import { lstat, readdir } from "node:fs/promises"

/** The reason tags `@effect/platform-node`'s `handleErrnoException` assigns. */
const reason = (code: unknown): PlatformError.SystemErrorTag => {
  switch (code) {
    case "ENOENT":
      return "NotFound"
    case "EACCES":
      return "PermissionDenied"
    case "EEXIST":
      return "AlreadyExists"
    case "EISDIR":
    case "ENOTDIR":
    case "ELOOP":
      return "BadResource"
    case "EBUSY":
      return "Busy"
    default:
      return "Unknown"
  }
}

const platformError = (method: string, path: string, error: unknown): PlatformError.PlatformError => {
  const errno = error as NodeJS.ErrnoException
  return PlatformError.systemError({
    _tag: reason(errno?.code),
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    ...(errno?.syscall === undefined ? {} : { syscall: errno.syscall }),
    cause: error
  })
}

const measure = async (directory: string, entry: Dirent): Promise<WorkspaceObservation.Measured> => {
  if (entry.isDirectory()) return { _tag: "Directory" }
  if (!entry.isFile()) return { _tag: "Skipped" }
  const path = `${directory}/${entry.name}`
  try {
    // `bigint`, as Effect's Node `FileSystem` asks: its millisecond mtime is
    // truncated from nanoseconds, and the default float one can round up. A
    // run journaled on one host and resumed on the other must read the same
    // tree as the same digest.
    const info = await lstat(path, { bigint: true })
    // Replaced by a link or a directory between the listing and the lstat.
    if (!info.isFile()) return { _tag: "Skipped" }
    return { _tag: "File", size: Number(info.size), modified: info.mtime.getTime() }
  } catch (error) {
    return { _tag: "Failed", method: "stat", cause: platformError("stat", path, error) }
  }
}

/**
 * Lists one directory with its entry types and measures its kept files together.
 *
 * @category constructors
 * @since 1.0.0
 */
export const host: WorkspaceObservation.Host = {
  entries: (directory, keep) =>
    Effect.tryPromise({
      try: async () => {
        const listed = (await readdir(directory, { withFileTypes: true })).filter((entry) => keep(entry.name))
        return Promise.all(
          listed.map(async (entry) => ({ name: entry.name, measured: await measure(directory, entry) }))
        )
      },
      catch: (error) => platformError("readDirectory", directory, error)
    })
}
