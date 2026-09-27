/**
 * Cell-harness hooks hosted by the shared Smithers plugin kernel.
 *
 * The plugin package deliberately leaves its hook catalog open for host
 * augmentation. This module adds the cell dispatch points needed by the
 * production composition: registry and executable-flow waterfalls before
 * disclosure, a monitor waterfall before the first frame, plus a
 * provider-neutral request waterfall immediately before a sealed model step.
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import type * as Monitor from "@smthrs/harness/Monitor"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import type { Apply, FlowsHooks, FlowsPlugin, PluginInput, WaterfallHook } from "@smthrs/plugin"
import { engineHooks, make as makePlugin } from "@smthrs/plugin"
import type { FlowsConfig, ResolvedConfig } from "@smthrs/plugin/Config"
import * as Kernel from "@smthrs/plugin/Kernel"
import { PluginError } from "@smthrs/plugin/PluginError"
import type * as Plugins from "@smthrs/plugin/Plugins"
import type * as Registry from "@smthrs/registry/Registry"
import * as Effect from "effect/Effect"

declare module "@smthrs/plugin" {
  interface FlowsHooks {
    /** Transforms the one registry used for disclosure and call resolution. */
    readonly cellRegistry: WaterfallHook<
      (registry: Registry.Registry) => Effect.Effect<Registry.Registry | void, unknown>
    >
    /**
     * Adds or transforms the executable flow bindings the host composes.
     *
     * The array a handler returns is the array the next handler sees, and the
     * last one is the catalog — both the descriptors disclosed to the model and
     * the implementations the boundary resolves against. A plugin therefore
     * contributes *capabilities*, not merely descriptions of them.
     */
    readonly cellFlows: WaterfallHook<
      (
        bindings: ReadonlyArray<FlowBinding.Binding>
      ) => Effect.Effect<ReadonlyArray<FlowBinding.Binding> | void, unknown>
    >
    /**
     * Adds or transforms the monitors the supervisor scores; the result is
     * validated before the first frame.
     */
    readonly cellMonitors: WaterfallHook<
      (
        monitors: ReadonlyArray<Monitor.Monitor>
      ) => Effect.Effect<ReadonlyArray<Monitor.Monitor> | void, unknown>
    >
    /** Transforms a provider-neutral request before its sealed model step. */
    readonly cellModelRequest: WaterfallHook<
      (request: ModelRequest.ModelRequest) => Effect.Effect<ModelRequest.ModelRequest | void, unknown>
    >
  }
}

/**
 * Runtime catalog supplied when the plugin kernel resolves for a cell host.
 *
 * @category models
 * @since 0.1.0
 */
export const hooks = Object.freeze(
  {
    ...engineHooks,
    cellRegistry: "waterfall",
    cellFlows: "waterfall",
    cellMonitors: "waterfall",
    cellModelRequest: "waterfall"
  } as const
)

/**
 * Resolves a cell host's plugin list through the shared kernel.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  input: PluginInput<FlowsHooks> = [],
  config: FlowsConfig = {}
): Effect.Effect<Kernel.Kernel<FlowsHooks>, PluginError> =>
  Kernel.make<FlowsHooks>(input, config, { target: "harness", hooks })

/**
 * Runs the ordered registry waterfall.
 *
 * Each handler returns the registry handed to the next handler. Because the
 * value remains the existing `Registry.Registry` contract, plugins may wrap or
 * replace the source without introducing another registry abstraction.
 *
 * @category dispatch
 * @since 0.1.0
 */
export const registry = (
  plugins: Plugins.Service<FlowsHooks>,
  initial: Registry.Registry
) => plugins.waterfall("cellRegistry", initial, (_previous, next) => next)

/**
 * Runs the ordered executable-flow waterfall.
 *
 * @category dispatch
 * @since 0.1.0
 */
export const flows = (
  plugins: Plugins.Service<FlowsHooks>,
  initial: ReadonlyArray<FlowBinding.Binding>
) => plugins.waterfall("cellFlows", initial, (_previous, next) => next)

/**
 * Runs the ordered monitor waterfall.
 *
 * @category dispatch
 * @since 1.0.0-rc.0
 */
export const monitors = (
  plugins: Plugins.Service<FlowsHooks>,
  initial: ReadonlyArray<Monitor.Monitor>
) => plugins.waterfall("cellMonitors", initial, (_previous, next) => next)

/**
 * Authors a harness plugin that contributes executable flows.
 *
 * The whole plugin is `name` plus bindings, so the common case — "this package
 * adds these capabilities" — needs no hook knowledge. Ordering, `apply`
 * filtering, and the config waterfall are the kernel's, unchanged; a plugin that
 * needs to *transform* other plugins' flows writes the `cellFlows` hook itself.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromBindings = (options: {
  readonly name: string
  readonly bindings: ReadonlyArray<FlowBinding.Binding>
  readonly enforce?: "pre" | "post" | undefined
  readonly apply?: Apply | undefined
}): FlowsPlugin<FlowsHooks> =>
  makePlugin<FlowsHooks>({
    name: options.name,
    ...(options.enforce === undefined ? {} : { enforce: options.enforce }),
    ...(options.apply === undefined ? {} : { apply: options.apply }),
    hooks: {
      cellFlows: (bindings) => Effect.succeed([...bindings, ...options.bindings])
    }
  })

/**
 * Runs the ordered provider-neutral request waterfall.
 *
 * @category dispatch
 * @since 0.1.0
 */
export const modelRequest = (
  plugins: Plugins.Service<FlowsHooks>,
  initial: ModelRequest.ModelRequest
) => plugins.waterfall("cellModelRequest", initial, (_previous, next) => next)

/**
 * Computes the order-sensitive identity of a resolved host composition.
 *
 * `StepKey` normalizes layer arrays as sets, while plugin and layer order can
 * change request and registry semantics. Folding the ordered declarations and
 * resolved config into one digest preserves that semantic distinction inside
 * the otherwise set-like layer material.
 *
 * @category identity
 * @since 0.1.0
 */
export const identity = (
  layers: ReadonlyArray<string>,
  plugins: Plugins.Service<FlowsHooks>,
  config: ResolvedConfig
): Effect.Effect<string, PluginError> =>
  Effect.try({
    try: () =>
      `flows/cell-composition/v1:${
        Digest.digest(CanonicalJson.stringify({
          layers,
          plugins: plugins.resolved.plugins.map((plugin) => ({
            name: plugin.name,
            enforce: plugin.enforce ?? "normal"
          })),
          config
        }))
      }`,
    catch: (cause) =>
      new PluginError({
        code: "config_invalid",
        message: "The resolved cell composition cannot be used as durable identity",
        cause
      })
  })
