/**
 * Action selectors a capability pattern may name: every exact action plus the
 * namespace and whole-authority wildcards.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"
import { Action } from "./Action.ts"

/**
 * Schema for action selectors accepted in capability patterns.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const PatternAction = Schema.Literals(
  [...Action.literals, "fs:*", "net:*", "model:*", "memory:*", "proc:*", "jj:*", "*"] as const
)

/**
 * An action selector accepted in a capability pattern.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type PatternAction = typeof PatternAction.Type
