/**
 * Whether an effect tier needs an idempotency key on retry.
 *
 * @since 0.1.0
 */

import type { EffectTier } from "./EffectTier.ts"

/**
 * Determines whether retrying an effect requires an idempotency key.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const requiresIdempotencyKey = (tier: EffectTier): boolean => tier === "irreversible"
