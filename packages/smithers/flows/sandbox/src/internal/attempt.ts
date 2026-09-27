/**
 * Runs a vendor SDK promise in the provider error vocabulary.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import type { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { providerFailure } from "./localProcess.ts"

/**
 * Builds a provider's `attempt`: it runs `thunk` and restates a rejection as a
 * `ProviderError` with `code` and the message `${prefix}: ${message}`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const attemptIn = (prefix: string) =>
<A>(
  thunk: () => Promise<A>,
  code: ProviderError["code"],
  message: string
): Effect.Effect<A, ProviderError> =>
  Effect.tryPromise({ try: thunk, catch: providerFailure(code, `${prefix}: ${message}`) })
