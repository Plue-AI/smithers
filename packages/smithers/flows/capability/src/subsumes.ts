/**
 * Provable coverage of one pattern by another.
 *
 * @since 0.1.0
 */

import type { CapabilityPattern } from "./CapabilityPattern.ts"
import { actionSubsumes } from "./internal/actionSubsumes.ts"

const resourceSubsumes = (left: string, right: string): boolean => {
  if (left === right || left === "**") {
    return true
  }
  if (!left.endsWith("/**")) {
    return false
  }
  const prefix = left.slice(0, -3)
  return right.startsWith(`${prefix}/`)
}

/**
 * Conservatively determines whether every capability selected by `right` is
 * also selected by `left`. It returns `false` for glob relationships that
 * cannot be proven by its syntactic checks.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const subsumes = (left: CapabilityPattern, right: CapabilityPattern): boolean =>
  actionSubsumes(left.action, right.action) && resourceSubsumes(left.resource, right.resource)
