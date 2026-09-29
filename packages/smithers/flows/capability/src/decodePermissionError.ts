/**
 * Constructed permission failures from structural boundary values.
 *
 * @since 1.0.0-rc.0
 */

import { Option } from "effect"
import { Capability } from "./Capability.ts"
import {
  GrantStoreError,
  isPermissionError,
  PermissionDenied,
  type PermissionError,
  PermissionRequired
} from "./Permission.ts"

/**
 * Validates data before constructing a yieldable permission error. Invalid
 * payloads, inspection failures, or metadata exceeding the constructor's
 * limits return None.
 * Construction also accepts instances from another copy of the package,
 * without relying on JavaScript instanceof identity.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const decodePermissionError = (input: unknown): Option.Option<PermissionError> => {
  try {
    if (!isPermissionError(input)) return Option.none()
    switch (input._tag) {
      case "@smthrs/capability/PermissionRequired":
        return Option.some(
          new PermissionRequired({
            requestId: input.requestId,
            runId: input.runId,
            capability: new Capability(input.capability),
            tier: input.tier,
            meta: input.meta
          })
        )
      case "@smthrs/capability/PermissionDenied":
        return Option.some(new PermissionDenied({ capability: new Capability(input.capability), reason: input.reason }))
      case "@smthrs/capability/GrantStoreError":
        return Option.some(new GrantStoreError({ code: input.code, message: input.message, cause: input.cause }))
    }
  } catch {
    return Option.none()
  }
}
