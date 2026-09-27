/**
 * Defines the liveness capability required from a sandbox provider.
 *
 * @since 0.1.0
 */

import type * as Effect from "effect/Effect"
import type { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"

/**
 * A cheap round-trip proving that the remote sandbox is alive.
 *
 * @category models
 * @since 0.1.0
 */
export interface PingProvider {
  readonly ping: Effect.Effect<void, ProviderError>
}
