/**
 * Membership test for the exact action vocabulary.
 *
 * @since 0.1.0
 */

import { Action } from "../Action.ts"

const actions: ReadonlySet<string> = new Set(Action.literals)

/**
 * @since 0.1.0
 * @private
 */
export const isAction = (value: string): value is Action => actions.has(value)
