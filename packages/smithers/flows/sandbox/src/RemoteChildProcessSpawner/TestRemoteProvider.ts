/**
 * Defines the observable remote test provider.
 *
 * @since 0.1.0
 */

import type { Provider } from "./Provider.ts"
import type { TestRemoteState } from "./TestRemoteState.ts"

/**
 * A scripted provider plus its observable cancellation state.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestRemoteProvider extends Provider {
  readonly state: TestRemoteState
}
