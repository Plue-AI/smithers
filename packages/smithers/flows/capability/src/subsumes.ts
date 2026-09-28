/**
 * Provable coverage of one pattern by another.
 *
 * @since 0.1.0
 */

import type { CapabilityPattern } from "./CapabilityPattern.ts"
import { actionSubsumes } from "./internal/actionSubsumes.ts"
import { dotSegmentForms } from "./internal/hasDotSegment.ts"

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
 * cannot be proven by its syntactic checks. A filesystem `right` whose
 * resource is absolute with a `.` or `..` segment, or relative and climbing
 * above its start, is never covered, since `/w/**` does not cover `/w/../**`.
 * A relative dot resource is covered only when both its text and its lexical
 * normal form are.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const subsumes = (left: CapabilityPattern, right: CapabilityPattern): boolean => {
  if (!actionSubsumes(left.action, right.action)) {
    return false
  }
  const forms = dotSegmentForms(right.action, right.resource)
  return forms !== undefined && forms.every((resource) => resourceSubsumes(left.resource, resource))
}
