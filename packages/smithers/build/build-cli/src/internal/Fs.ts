/**
 * Filesystem-boundary helpers shared by the modules that read untrusted paths
 * and report what went wrong when one cannot be read.
 *
 * `Cache.ts` and `Workspace.ts` each carried byte-identical copies of
 * {@link optionalOpenFlag} and near-identical copies of {@link errorCode} and
 * {@link failureMessage}. They are one policy — how this package inspects a
 * rejected value without running code that value owns — so they live in one
 * place.
 *
 * @since 0.1.0
 */

import * as NodeFs from "node:fs"
import * as NodeUtil from "node:util/types"

/**
 * Returns an open(2) flag the platform may not provide.
 *
 * Windows builds of libuv define neither `O_NOFOLLOW` nor `O_NONBLOCK`; a
 * missing flag contributes nothing rather than crashing the open.
 *
 * @category constants
 * @since 0.1.0
 */
export const optionalOpenFlag = (name: "O_NOFOLLOW" | "O_NONBLOCK"): number =>
  (NodeFs.constants as Partial<Record<string, number>>)[name] ?? 0

/**
 * Reads a rejected value's own `code` data property, or undefined.
 *
 * Only an own data property is read: an accessor or a Proxy trap would run
 * arbitrary code while a failure is being classified.
 *
 * @category rendering
 * @since 0.1.0
 */
export const errorCode = (cause: unknown): string | undefined => {
  if ((typeof cause !== "object" && typeof cause !== "function") || cause === null || NodeUtil.isProxy(cause)) {
    return undefined
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(cause, "code")
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads a rejected value's own `message` data property, or the generic text.
 *
 * Same posture as {@link errorCode}: own data properties only.
 *
 * @category rendering
 * @since 0.1.0
 */
export const failureMessage = (cause: unknown): string => {
  if ((typeof cause !== "object" && typeof cause !== "function") || cause === null || NodeUtil.isProxy(cause)) {
    return "unavailable failure"
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(cause, "message")
    if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") {
      return descriptor.value === "" ? "unavailable failure" : descriptor.value
    }
  } catch {
    // Fall through to the deliberately generic message.
  }
  return "unavailable failure"
}
