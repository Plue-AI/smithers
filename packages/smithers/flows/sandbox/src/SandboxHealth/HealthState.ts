/**
 * Defines the complete sandbox health state.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import { Healthy } from "./Healthy.ts"
import { Unhealthy } from "./Unhealthy.ts"

/**
 * Schema for every state a sandbox health probe can report.
 *
 * @category models
 * @since 0.1.0
 */
export const HealthState = Schema.Union([Healthy, Unhealthy])

/**
 * A state reported by a sandbox health probe.
 *
 * @category models
 * @since 0.1.0
 */
export type HealthState = typeof HealthState.Type
