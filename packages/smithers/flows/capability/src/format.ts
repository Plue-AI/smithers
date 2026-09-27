/**
 * The `action:resource` text form capabilities and patterns render into.
 *
 * @since 0.1.0
 */

import type { Action } from "./Action.ts"
import { isPatternAction } from "./internal/isPatternAction.ts"
import type { PatternAction } from "./PatternAction.ts"

/**
 * Formats a capability or a capability pattern for storage, display, and
 * durable key input.
 *
 * `Capability` and `CapabilityPattern` have distinct nominal brands but share
 * the encoded `{action, resource}` shape. Both use this renderer to preserve
 * byte-identical durable identities.
 *
 * The function throws an `Error` that names an invalid action. Runtime
 * validation prevents invalid structural inputs from colliding with valid
 * durable identities.
 *
 * @since 0.1.0
 * @category formatting
 * @slop
 */
export const format = (capability: {
  readonly action: Action | PatternAction
  readonly resource: string
}): string => {
  if (!isPatternAction(capability.action)) {
    throw new Error(`Invalid capability action: ${capability.action}`)
  }
  return `${capability.action}:${capability.resource}`
}
