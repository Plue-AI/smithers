/**
 * Startup: resolve the plugin list, run the config pipeline, hand back a
 * dispatcher, a frozen config, and the merged layer.
 *
 * The public package contract is documented at
 * {@link https://smithers.sh/docs/reference/api/plugin}, with the shipped host catalog in
 * `packages/smithers/agent/src/CellPlugin.ts`. D14 in
 * `docs/pages/design-decisions.md` keeps durable policy outside these hooks.
 *
 * Order of operations, per the spec:
 *
 * 1. flatten / filter / validate / order the plugin list;
 * 2. `config` waterfall: each plugin may return a partial to deep-merge;
 * 3. decode and freeze into a `ResolvedConfig` (`config_invalid` on failure);
 * 4. `configResolved` parallel: observers capture the final config;
 * 5. plugin `layer`s merge left-to-right.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type { FlowsConfig, ResolvedConfig } from "./Config.ts"
import * as Config from "./Config.ts"
import type { ContextOf } from "./Hooks.ts"
import type { FlowsHooks } from "./index.ts"
import type { PluginInput } from "./Plugin.ts"
import type { PluginError } from "./PluginError.ts"
import * as Plugins from "./Plugins.ts"
import * as Resolve from "./Resolve.ts"

/**
 * Everything startup produces from a plugin list and a raw config.
 *
 * `observerErrors` carries `configResolved` failures: parallel observers are
 * lossy by contract, so they are reported rather than fatal.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Kernel<H = FlowsHooks> {
  readonly plugins: Plugins.Service<H>
  readonly config: ResolvedConfig
  readonly layer: Layer.Layer<any, PluginError, any>
  readonly observerErrors: ReadonlyArray<PluginError>
}

type HookAt<H, K extends string> = K extends keyof H ? H[K] : never

/**
 * The services a hook interface's `config` hook requires at startup. `never`
 * for the shared `FlowsHooks`, whose startup hooks are context-free.
 *
 * @category type-level
 * @since 1.0.0-rc.0
 */
export type ConfigContext<H> = ContextOf<HookAt<H, "config">>

/**
 * The services a hook interface's startup hooks require: the union of the
 * `config` and `configResolved` requirements. `Kernel.make` cannot supply
 * them itself, so they surface in its Effect and the caller provides them.
 *
 * @category type-level
 * @since 1.0.0-rc.0
 */
export type StartupContext<H> = ConfigContext<H> | ContextOf<HookAt<H, "configResolved">>

/**
 * Snapshots the config before dispatching the `config` waterfall, then
 * admits the result as a frozen `ResolvedConfig`.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const runConfig = <H = FlowsHooks>(
  plugins: Plugins.Service<H>,
  config: FlowsConfig
): Effect.Effect<ResolvedConfig, PluginError, ConfigContext<H>> =>
  Effect.gen(function*() {
    const initial = yield* Config.snapshot(config)
    const merged = yield* (plugins.waterfall as unknown as (
      hook: string,
      initial: FlowsConfig,
      merge: (previous: FlowsConfig, patch: unknown) => FlowsConfig
    ) => Effect.Effect<FlowsConfig, PluginError, ConfigContext<H>>)("config", initial, Config.merge)
    return yield* Config.resolve(merged)
  })

/**
 * Resolves plugins, executes the config pipeline, and merges plugin layers.
 * The positional `config` is the kernel's only pre-resolution configuration;
 * the options object cannot declare a second source, and a `config` key
 * supplied anyway fails with `invalid_plugin` at `$options.config`.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const make = <H = FlowsHooks>(
  input: PluginInput<NoInfer<H>>,
  config: FlowsConfig = {},
  options: Omit<Resolve.Options<NoInfer<H>>, "config"> = {}
): Effect.Effect<Kernel<H>, PluginError, StartupContext<H>> =>
  Effect.gen(function*() {
    const initial = yield* Config.snapshot(config)
    const resolved = yield* Resolve.resolve<H>(input, options, initial)
    const dispatcher = Plugins.make<H>(resolved)
    const frozen = yield* runConfig(dispatcher, initial)
    const observerErrors = yield* (dispatcher.parallel as unknown as (
      hook: string,
      value: ResolvedConfig
    ) => Effect.Effect<ReadonlyArray<PluginError>, never, StartupContext<H>>)("configResolved", frozen)
    return Object.freeze({
      plugins: dispatcher,
      config: frozen,
      layer: Resolve.layer(resolved),
      observerErrors
    })
  })
