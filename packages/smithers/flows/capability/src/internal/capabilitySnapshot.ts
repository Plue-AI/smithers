/**
 * The defensive capability copy a permission error retains.
 *
 * @since 0.1.0
 */

import { Capability } from "../Capability.ts"

/**
 * @since 0.1.0
 * @private
 */
export const capabilitySnapshot = (capability: Capability): Capability => {
  const snapshot = new Capability({ action: capability.action, resource: capability.resource })
  for (const field of ["action", "resource"] as const) {
    Object.defineProperty(snapshot, field, {
      value: snapshot[field],
      enumerable: true,
      writable: false,
      configurable: false
    })
  }
  return snapshot
}
