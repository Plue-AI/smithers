/**
 * Projection of a permission failure into Effect's `PlatformError` channel.
 *
 * @since 0.1.0
 */

import { type PlatformError, systemError } from "effect/PlatformError"
import { formatError } from "./formatError.ts"
import { displayField } from "./internal/displayField.ts"
import type { PermissionError } from "./PermissionError.ts"

/**
 * Projects a permission failure into Effect's `PlatformError` channel.
 *
 * Effect owns `FileSystem` and `ChildProcessSpawner`, and their tags fix the
 * error channel to `PlatformError`. Rather than mint a second tag whose only
 * difference is a wider error type, the kernel decorates those tags in place
 * and maps its own failures through here.
 *
 * The structured failure is preserved: the normalized reason is always `PermissionDenied` — the
 * operation did not happen because the capability kernel refused, suspended,
 * or could not decide it — `description` carries the human rendering from
 * {@link formatError}, and `cause` carries the structured failure itself, so
 * `fromPlatformError` hands the attended surface back the original
 * `capability`, `tier`, `requestId`, and `reason`.
 * Module, method, and string paths use the same escaping and field limit as
 * the description. The projected path is display text; the raw capability
 * resource remains in the cause. Numeric descriptors are unchanged.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const toPlatformError = (options: {
  readonly module: string
  readonly method: string
  readonly pathOrDescriptor?: string | number | undefined
  readonly error: PermissionError
}): PlatformError =>
  systemError({
    _tag: "PermissionDenied",
    module: displayField(options.module),
    method: displayField(options.method),
    description: formatError(options.error),
    ...(options.pathOrDescriptor === undefined ? {} : {
      pathOrDescriptor: typeof options.pathOrDescriptor === "string"
        ? displayField(options.pathOrDescriptor)
        : options.pathOrDescriptor
    }),
    cause: options.error
  })
