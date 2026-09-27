/**
 * The exact capability constructor.
 *
 * @since 0.1.0
 */

import type { Action } from "./Action.ts"
import { Capability } from "./ExactCapability.ts"

/**
 * Constructs an exact capability.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make = (action: Action, resource: string): Capability => new Capability({ action, resource })
