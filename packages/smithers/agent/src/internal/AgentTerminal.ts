/**
 * Fail-closed diagnostics for the production coding terminal binding.
 *
 * @since 1.0.0
 */

import { StdError } from "@smthrs/std/StdError"

// Host readiness is diagnostic only. It cannot substitute for the two real
// reference-host checks or enable a fallback executor.
/**
 * Required terminal providers.
 *
 * @private
 * @since 1.0.0
 */
export const dependencies = [
  "T-FLW-01",
  "T-COL-03",
  "T-TRM-07",
  "T-TRM-01",
  "T-APP-09",
  "T-APP-10",
  "T-APP-12"
] as const
/**
 * Host readiness, without authority to activate execution.
 *
 * @private
 * @since 1.0.0
 */
export type Providers = Partial<Record<typeof dependencies[number], true>>

/**
 * Typed refusal until the real install acceptance passes.
 *
 * @private
 * @since 1.0.0
 */
export const unavailable = (providers: Providers = {}): StdError => {
  const missing = dependencies.filter((ticket) => providers[ticket] !== true)
  return new StdError({
    code: "provider_unavailable",
    message: `Agent terminal unavailable: ${
      missing.length > 0 ? `missing ${missing.join(", ")}; ` : ""
    }requires C-J3-10 and C-COL-04 through the composed install.`
  })
}
