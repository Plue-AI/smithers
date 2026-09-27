/**
 * Turns a nonzero vendor command exit into a provider failure.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"

/**
 * Passes `result` through when its command exited 0, and fails with `code`
 * and `${message}: command exited <status>` otherwise.
 *
 * @category constructors
 * @since 0.1.0
 */
export const checked = <R extends { readonly exitCode: number }>(
  result: R,
  code: ProviderError["code"],
  message: string
): Effect.Effect<R, ProviderError> =>
  result.exitCode === 0
    ? Effect.succeed(result)
    : Effect.fail(new ProviderError({ code, message: `${message}: command exited ${result.exitCode}` }))
