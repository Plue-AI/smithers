/**
 * The plugin object: a plain record produced by a factory function.
 *
 * The public package contract is documented at
 * {@link https://smithers.sh/docs/reference/api/plugin}. The shipped consumer is the
 * assembled cell host in `@smthrs/agent`;
 * durable-core policy continues to use Effect services and constructor
 * options rather than plugin lifecycle hooks.
 *
 * @since 1.0.0-rc.0
 */

import type * as Layer from "effect/Layer"
import type { FlowsConfig } from "./Config.ts"
import type { FlowsHooks } from "./index.ts"

/**
 * Conditional-inclusion predicate, mirroring Vite's `apply`.
 *
 * `"engine"` and `"harness"` select the matching plugin-kernel host. The
 * assembled cell host resolves as `"harness"`; this does not make `"engine"` an
 * engine-lifecycle hook registration.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Apply = "engine" | "harness" | ((config: FlowsConfig) => boolean)

/**
 * A flows plugin.
 *
 * Generic over the hook interface so a harness can hold plugins typed against
 * its augmented `FlowsHooks` without any inheritance machinery.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface FlowsPlugin<H = FlowsHooks> {
  /** Required, unique. Convention: `flows-plugin-<thing>`. */
  readonly name: string
  /**
   * Semantic identity folded into sealed cache keys. Required when the host
   * declares a cache environment. `Action.CacheEnvironment` is complete by
   * contract, so a versionless composition is refused instead of claiming an
   * ambiguous cross-run identity.
   */
  readonly version?: string | undefined
  /** Ordering group; omitted means `"normal"`. */
  readonly enforce?: "pre" | "post" | undefined
  /** Conditional inclusion. */
  readonly apply?: Apply | undefined
  /** Services this plugin contributes to the engine environment. */
  readonly layer?: Layer.Layer<never, any, any> | undefined
  /** Typed hooks; only keys declared in the hook interface compile. */
  readonly hooks?: Partial<H> | undefined
}

/**
 * What a `plugins` array may contain: plugins, falsy entries, and arrays nested
 * up to `Resolve.maximumPluginDepth`: so a preset is just a function returning
 * plugins.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type PluginInput<H = FlowsHooks> =
  | FlowsPlugin<H>
  | false
  | null
  | undefined
  | ReadonlyArray<PluginInput<H>>

/**
 * Identity constructor that pins a plugin literal to `FlowsPlugin` so excess
 * hook keys are rejected at the definition site.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const make = <H = FlowsHooks>(plugin: FlowsPlugin<H>): FlowsPlugin<H> => plugin
