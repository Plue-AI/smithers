/**
 * The durability and retry classification of an effect.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"

/**
 * Schema for the durability and retry semantics of an effect.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const EffectTier = Schema.Literals(["sealed", "compensable", "irreversible"] as const)

/**
 * The durability and retry semantics of an effect.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type EffectTier = typeof EffectTier.Type
