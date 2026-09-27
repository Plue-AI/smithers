/**
 * Maps a filesystem failure to the standard-flow code that names its reason.
 *
 * A permission denial is not a missing file. Telling the model a denied path
 * does not exist sends it searching for a file that is right there, and hides
 * the denial from whoever reads the run. Every standard flow that touches the
 * filesystem routes its failures through here so `PermissionDenied` always
 * reaches the model as `permission_denied`.
 *
 * @since 1.0.0
 */

import type * as PlatformError from "effect/PlatformError"
import * as StdError from "../StdError.ts"

/**
 * The failure for a path the host or the kernel guard refused.
 *
 * @private
 * @since 1.0.0
 */
export const permissionDenied = (path: string): StdError.StdError =>
  new StdError.StdError({ code: "permission_denied", message: `Permission denied: ${path}`, path })

/**
 * Maps `PermissionDenied` to `permission_denied` and any other reason through
 * `otherwise`.
 *
 * @private
 * @since 1.0.0
 */
export const denied = (
  path: string,
  otherwise: (error: PlatformError.PlatformError) => StdError.StdError
) =>
(error: PlatformError.PlatformError): StdError.StdError =>
  error.reason._tag === "PermissionDenied" ? permissionDenied(path) : otherwise(error)

/**
 * Maps a read-side failure: `NotFound` to `not_found` with `notFoundMessage`,
 * `PermissionDenied` to `permission_denied`, and anything else to
 * `command_failed` carrying the host's reason.
 *
 * @private
 * @since 1.0.0
 */
export const reading = (path: string, notFoundMessage: string) =>
  denied(path, (error) =>
    error.reason._tag === "NotFound"
      ? new StdError.StdError({ code: "not_found", message: notFoundMessage, path })
      : new StdError.StdError({ code: "command_failed", message: `Could not read ${path}: ${error.message}`, path }))
