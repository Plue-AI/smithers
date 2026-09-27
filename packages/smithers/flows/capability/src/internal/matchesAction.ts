/**
 * Action selection shared by the matcher and its budget check.
 *
 * @since 0.1.0
 */

import type { Action } from "../Action.ts"
import type { PatternAction } from "../PatternAction.ts"

/**
 * @since 0.1.0
 * @private
 */
export const matchesAction = (pattern: PatternAction, action: Action): boolean =>
  pattern === "*" || pattern === action || (pattern.endsWith(":*") && action.startsWith(pattern.slice(0, -1)))
