/**
 * Decidability check for one pattern and capability pair.
 *
 * @since 0.1.0
 */

import type { CapabilityPattern } from "./CapabilityPattern.ts"
import type { Capability } from "./ExactCapability.ts"
import { matchesAction } from "./internal/matchesAction.ts"
import { maxMatchWork } from "./maxMatchWork.ts"

/**
 * Reports whether `matches` can decide a pattern and exact capability
 * within {@link maxMatchWork}.
 *
 * An action mismatch is decidable without resource matching. When the action
 * selects the capability, the pattern-length times resource-length product
 * must fit within the work budget.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const withinMatchBudget = (pattern: CapabilityPattern, capability: Capability): boolean =>
  !matchesAction(pattern.action, capability.action) ||
  pattern.resource.length * capability.resource.length <= maxMatchWork
