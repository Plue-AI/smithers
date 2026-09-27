/**
 * Defines failures reported by remote providers.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * The closed set of failure kinds a provider may report.
 *
 * The codes are this seam's own. They used to borrow the `Shell` service's
 * closed code set; that service is gone — process execution is Effect's
 * `ChildProcessSpawner` — so the seam declares what a *remote session* can go
 * wrong with and `layer` normalizes those onto `PlatformError`. Provider
 * packages may add SDK details to `cause`, but cannot create new Host-visible
 * failure kinds.
 *
 * `not_found` entered the set with the `Sandbox` session contract: a session
 * that can read files back needs an honest answer for a path that holds
 * nothing, and overloading `unknown` would make "absent" indistinguishable
 * from "broken" at the one seam whose job is to keep them apart.
 *
 * @category models
 * @since 0.1.0
 */
export const ProviderErrorCode = Schema.Literals([
  "aborted",
  "timeout",
  "unavailable",
  "not_found",
  "spawn_error",
  "unknown"
])

/**
 * The value form of {@link ProviderErrorCode}.
 *
 * @category models
 * @since 0.1.0
 */
export type ProviderErrorCode = typeof ProviderErrorCode.Type

/**
 * A provider failure before it is normalized onto `PlatformError`.
 *
 * @category models
 * @since 0.1.0
 */
export class ProviderError extends Schema.TaggedError<ProviderError>()(
  "@smthrs/sandbox/RemoteChildProcessSpawner/ProviderError",
  {
    code: ProviderErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}
