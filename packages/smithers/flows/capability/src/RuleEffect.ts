/**
 * The decision a matching permission rule applies.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"

/**
 * Schema for decisions made by matching permission rules.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const RuleEffect = Schema.Literals(["allow", "deny", "ask"] as const)

/**
 * The decision made by a matching permission rule.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type RuleEffect = typeof RuleEffect.Type
