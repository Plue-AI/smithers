/**
 * Action coverage shared by `subsumes` and `mayOverlap`.
 *
 * @since 0.1.0
 */

import type { PatternAction } from "../PatternAction.ts"

/**
 * @since 0.1.0
 * @private
 */
export const actionSubsumes = (left: PatternAction, right: PatternAction): boolean => {
  if (left === "*" || left === right) {
    return true
  }
  return left.endsWith(":*") && right !== "*" && right.startsWith(left.slice(0, -1))
}
