/**
 * Defines the sandbox health service contract.
 *
 * @since 0.1.0
 */

import type * as Effect from "effect/Effect"
import type { HealthState } from "./HealthState.ts"

/**
 * Sandbox health probe service.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  /** Pings the sandbox and reports its typed health state. */
  readonly check: Effect.Effect<HealthState>
}
