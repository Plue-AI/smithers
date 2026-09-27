/**
 * Membership test for the pattern action vocabulary.
 *
 * @since 0.1.0
 */

import { PatternAction } from "../PatternAction.ts"

const patternActions: ReadonlySet<string> = new Set(PatternAction.literals)

/**
 * @since 0.1.0
 * @private
 */
export const isPatternAction = (value: string): value is PatternAction => patternActions.has(value)
