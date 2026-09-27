/**
 * Defines sandbox health probe configuration.
 *
 * @since 0.1.0
 */

import type * as Duration from "effect/Duration"

/**
 * Sandbox health probe configuration.
 *
 * @category models
 * @since 0.1.0
 */
export interface ProbeOptions {
  /** How long the ping may take before the sandbox counts as dead. Default 5 seconds. */
  readonly deadline?: Duration.Input | undefined
}
