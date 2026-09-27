/**
 * The `ChildProcessSpawner` layer over a just-bash interpreter.
 *
 * @since 1.0.0-rc.0
 */

import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import type * as Path from "effect/Path"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { JustBashLike } from "./JustBashLike.ts"
import { make } from "./make.ts"

/**
 * Provides the `ChildProcessSpawner` service backed by a just-bash interpreter.
 *
 * `FileSystem` and `Path` are required for the same reason
 * `NodeChildProcessSpawner` requires them: `cwd` is validated and resolved
 * before the command runs. Provide the `BrowserFileSystem` layer mounted on the
 * very filesystem the interpreter writes through, or the two will disagree
 * about what exists.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export const layer = (
  bash: JustBashLike
): Layer.Layer<ChildProcessSpawner, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(ChildProcessSpawner, make(bash))
