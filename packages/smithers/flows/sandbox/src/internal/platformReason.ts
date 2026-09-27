/**
 * Maps provider error codes onto normalized platform reasons.
 *
 * @since 0.1.0
 */

import * as PlatformError from "effect/PlatformError"
import type { ProviderError, ProviderErrorCode } from "../RemoteChildProcessSpawner/ProviderError.ts"

/**
 * The one mapping from a provider's closed code set onto the reasons
 * `PlatformError` already has.
 *
 * It lives here rather than in each adapter because two copies of the same
 * table under the same comment drifted: a caller holding a normalized
 * `PlatformError` could not infer the provider code without also knowing which
 * adapter had produced it.
 *
 * `unavailable` and `not_found` share `NotFound` deliberately at the process
 * seam. `not_found` exists so "absent" and "broken" stay apart in the PROVIDER
 * vocabulary, and they do; what they mean to a caller of a spawner is the same
 * instruction — this session cannot run your command, try somewhere else —
 * which is the reason `SandboxSupervision.retired` reports a retired session
 * as `NotFound` too. A caller that needs the distinction reads
 * `PlatformError.cause`, which carries the `ProviderError` itself.
 *
 * @category models
 * @since 0.1.0
 */
export const platformReason: Record<ProviderErrorCode, PlatformError.SystemErrorTag> = {
  aborted: "Unknown",
  timeout: "TimedOut",
  unavailable: "NotFound",
  not_found: "NotFound",
  spawn_error: "Unknown",
  unknown: "Unknown"
}

/**
 * Restates a provider failure in the platform vocabulary both spawner-facing
 * adapters share, so a session that refused to open reads the same whether the
 * caller reached it through `RemoteChildProcessSpawner` or `SandboxSupervision`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const platformFailure = (method: string, command: string) =>
(
  error: ProviderError
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: platformReason[error.code],
    module: "ChildProcess",
    method,
    description: `\`${command}\`: ${error.message}`,
    cause: error
  })
