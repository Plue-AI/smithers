/**
 * Defines one scripted response for the remote test provider.
 *
 * @since 0.1.0
 */

import type { ProviderError } from "./ProviderError.ts"

/**
 * One scripted response used by `TestRemote.make`.
 *
 * `pending` creates an operation that runs until its fiber is interrupted.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestScript {
  readonly stdout?: string | undefined
  readonly stderr?: string | undefined
  readonly exitCode?: number | undefined
  readonly failure?: ProviderError | undefined
  readonly pending?: boolean | undefined
}
