/**
 * Defines sandbox supervision configuration.
 *
 * @since 0.1.0
 */

import type * as Duration from "effect/Duration"
import type * as Effect from "effect/Effect"
import type { HealthState } from "../SandboxHealth/HealthState.ts"
import type { ProbeOptions } from "../SandboxHealth/ProbeOptions.ts"
import type { Reporter } from "./Reporter.ts"

/**
 * Supervision configuration.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options extends ProbeOptions {
  /** How long supervision waits between probes. */
  readonly interval: Duration.Input
  /**
   * The liveness probe. Defaults to `SandboxHealth.make` over the
   * supervised provider, which means a provider without `ping` is never
   * probed.
   */
  readonly probe?: Effect.Effect<HealthState> | undefined
  /**
   * How many consecutive unhealthy probes retire the session. Default 1. A
   * higher tolerance rides out a probe that lost a race with a loaded machine;
   * one healthy answer resets the count.
   */
  readonly tolerance?: number | undefined
  /** Where a retirement is reported. Defaults to a logged warning. */
  readonly reporter?: Reporter | undefined
}
