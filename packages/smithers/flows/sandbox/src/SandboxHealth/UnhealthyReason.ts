/**
 * Defines the closed sandbox liveness failure vocabulary.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * The closed set of reasons a sandbox probe reports as unhealthy.
 *
 * `unresponsive` means the ping missed its deadline. `ping_failed` means the
 * provider answered with a failure.
 *
 * @category models
 * @since 0.1.0
 */
export const UnhealthyReason = Schema.Literals(["unresponsive", "ping_failed"])

/**
 * A reason a sandbox probe reports as unhealthy.
 *
 * @category models
 * @since 0.1.0
 */
export type UnhealthyReason = typeof UnhealthyReason.Type
