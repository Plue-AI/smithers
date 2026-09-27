/**
 * The `FileSystem` layer over a ZenFS-shaped backend.
 *
 * @since 1.0.0-rc.0
 */

import { withIsolatedFileSystem } from "@smthrs/kernel/FileSystem"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import { make } from "./make.ts"
import type { ZenFsPromisesLike } from "./ZenFsPromisesLike.ts"

/**
 * Provides the `FileSystem` service backed by a ZenFS-shaped promises API.
 *
 * The workspace must occupy the whole mounted namespace, whose root is `/`.
 * A subtree grant can race with a symlink change after authorization. Use one
 * workspace per mount (or a backend without symlinks); this layer refuses a
 * workspace root other than `/`. The caller must provide a genuinely isolated
 * mount, not unrestricted host filesystem access.
 *
 * {@link make} builds the same service **without** the attestation, for a
 * caller that wants effect's `FileSystem` and no kernel claim attached.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export const layer = (
  fs: ZenFsPromisesLike,
  options: { readonly workspaceRoot: string } = { workspaceRoot: "/" }
): Layer.Layer<FileSystem.FileSystem, PlatformError.PlatformError> =>
  Layer.effect(FileSystem.FileSystem)(
    options.workspaceRoot === "/"
      ? Effect.succeed(withIsolatedFileSystem(make(fs)))
      : Effect.fail(PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "layer",
        pathOrDescriptor: options.workspaceRoot,
        description: "isolation requires the workspace root to equal the mount root /"
      }))
  )
