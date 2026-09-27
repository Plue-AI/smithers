/**
 * Mapping from ZenFS/Node `Stats` onto effect's `File.Info`.
 *
 * @since 1.0.0-rc.0
 */

import * as ByteSize from "effect/ByteSize"
import type * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import type { ZenFsStatsLike } from "./ZenFsStatsLike.ts"

/**
 * The `File.Type` a stats object reports, `"Unknown"` when it is none of the
 * three kinds the slice can name.
 *
 * @private
 */
const fileType = (stats: ZenFsStatsLike): FileSystem.File.Type =>
  stats.isFile() ? "File" : stats.isDirectory() ? "Directory" : stats.isSymbolicLink() ? "SymbolicLink" : "Unknown"

/**
 * The `File.Info` a stats object supports: type, size, mode, and mtime are
 * real; everything the slice cannot know is `Option.none` or zero.
 *
 * @private
 * @since 1.0.0-rc.0
 * @slop
 */
export const fileInfo = (stats: ZenFsStatsLike): FileSystem.File.Info => ({
  type: fileType(stats),
  // Not a clock read: `stats.mtimeMs` is a timestamp the host already
  // reported, and this only re-boxes it in the `Date` that `File.Info`
  // declares. Nothing here observes the current time.
  mtime: Option.some(new Date(stats.mtimeMs)),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: stats.mode,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: ByteSize.bytes(stats.size),
  blksize: Option.none(),
  blocks: Option.none()
})
