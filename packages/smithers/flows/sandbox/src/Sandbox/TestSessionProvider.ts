/**
 * Defines the observable scripted sandbox provider.
 *
 * @since 0.1.0
 */

import type { Provider } from "./Provider.ts"
import type { TestSessionState } from "./TestSessionState.ts"

/**
 * A scripted lifecycle provider plus its observable state.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestSessionProvider extends Provider {
  readonly state: TestSessionState
}
