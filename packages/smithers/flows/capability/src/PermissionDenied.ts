/**
 * The refused-capability failure and its constructor.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"
import { Capability } from "./Capability.ts"
import { capabilitySnapshot } from "./internal/capabilitySnapshot.ts"

/**
 * A capability rejected by policy or by the current capability ceiling. The
 * error retains a defensive copy rather than the caller's `Capability`
 * instance, and its `capability` slot is non-writable.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class PermissionDenied extends Schema.TaggedError<PermissionDenied>()(
  "@smthrs/capability/PermissionDenied",
  {
    code: Schema.Literal("permission_denied"),
    capability: Capability,
    reason: Schema.String
  }
) {
  constructor(props: {
    readonly code?: "permission_denied"
    readonly capability: Capability
    readonly reason: string
  }) {
    super({ ...props, code: "permission_denied" })
    Object.defineProperty(this, "capability", {
      value: capabilitySnapshot(props.capability),
      enumerable: true,
      writable: false,
      configurable: false
    })
  }
}

/**
 * Constructs a denied permission failure.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const permissionDenied = (capability: Capability, reason: string): PermissionDenied =>
  new PermissionDenied({
    code: "permission_denied",
    capability,
    reason
  })
