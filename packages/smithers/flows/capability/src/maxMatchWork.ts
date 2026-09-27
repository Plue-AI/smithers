/**
 * The work budget one glob match may spend.
 *
 * @since 0.1.0
 */

import { maxResourceLength } from "./maxResourceLength.ts"

/**
 * The maximum pattern-length times resource-length work a match may perform.
 *
 * The matcher is O(pattern length times resource length) in the worst case and
 * `matches` returns `false` when the product exceeds this budget.
 * `Permission.evaluate` returns `deny` for a rule it cannot decide, and
 * `withinMatchBudget` reports whether a pair is decidable. The budget
 * covers every supported pair up to the 4096-unit {@link maxResourceLength}
 * limit and remains a defense for unchecked structural values. A pattern
 * ending in ` *` costs at most two passes.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export const maxMatchWork = maxResourceLength * maxResourceLength
