/**
 * The single typed failure of the plugin kernel.
 *
 * The public package contract is documented at
 * {@link https://smithers.sh/docs/reference/api/plugin}; D14 in
 * `docs/pages/design-decisions.md` bounds it to host-owned cell hooks.
 *
 * @since 1.0.0-rc.0
 */

import * as Schema from "effect/Schema"

/**
 * Closed set of plugin-system failure codes.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const PluginErrorCode = Schema.Literals([
  "duplicate_name",
  "unknown_hook",
  "hook_kind_mismatch",
  "invalid_plugin",
  "apply_failed",
  "config_invalid",
  "cache_environment_invalid",
  "invalid_hook_result",
  "resource_limit",
  "hook_failed",
  "layer_failed"
])

/**
 * Closed set of plugin-system failure codes.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type PluginErrorCode = typeof PluginErrorCode.Type

/**
 * Failure raised by plugin resolution, hook dispatch, config execution, or
 * layer construction.
 *
 * Parallel observer failures never fail the caller; they are returned from
 * `Plugins.parallel` with this same shape so they can be journalled on the
 * lossy telemetry channel.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class PluginError extends Schema.TaggedError<PluginError>()("flows/plugin/PluginError", {
  code: PluginErrorCode,
  message: Schema.String,
  plugin: Schema.optional(Schema.String),
  hook: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown)
}) {}
