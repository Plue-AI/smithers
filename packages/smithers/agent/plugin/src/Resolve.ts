/**
 * Bounded plugin resolution: admit, filter, validate, order, and snapshot.
 *
 * The resulting catalog owns every record it exposes. Dispatch never reads a
 * caller-owned map, plugin record, hook object, config value, or cache identity.
 *
 * @since 1.0.0-rc.0
 */

import * as ImmutableMap from "@smthrs/canonical/ReadonlyMap"
import type { Action } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { FlowsConfig } from "./Config.ts"
import * as Config from "./Config.ts"
import type { HookCatalog, HookKind, HookObject } from "./Hooks.ts"
import { engineHooks, handlerOf, orderOf } from "./Hooks.ts"
import type { FlowsHooks } from "./index.ts"
import * as Boundary from "./internal/Boundary.ts"
import { mergePluginLayers } from "./internal/mergePluginLayers.ts"
import { snapshotCacheEnvironment } from "./internal/snapshotCacheEnvironment.ts"
import type { Apply, FlowsPlugin, PluginInput } from "./Plugin.ts"
import { PluginError, type PluginErrorCode } from "./PluginError.ts"

/**
 * Maximum nested preset-array depth accepted at startup.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumPluginDepth = 64

/**
 * Maximum plugins accepted by one kernel.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumPlugins = 256

/**
 * Maximum aggregate hook handlers accepted by one kernel.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumHandlers = 1_024

/**
 * Maximum input nodes, including arrays and omitted entries.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumPluginInputNodes = 4_096

/**
 * Maximum UTF-16 length of one plugin or hook name.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumPluginNameLength = 256

/**
 * Default fiber bound for parallel observers.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const defaultParallelConcurrency = 16

/**
 * Maximum configurable parallel-observer bound.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumParallelConcurrency = 256

/**
 * One resolved handler with immutable attribution.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface HandlerRecord {
  readonly plugin: string
  readonly hook: string
  readonly handler: (...args: Array<any>) => unknown
}

/**
 * The immutable output of plugin resolution.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Resolved<H = FlowsHooks> {
  readonly plugins: ReadonlyArray<FlowsPlugin<H>>
  readonly handlers: ReadonlyMap<string, ReadonlyArray<HandlerRecord>>
  /** The frozen runtime catalog this resolution admitted. Dispatch refuses a method whose kind differs from it. */
  readonly kinds: Readonly<Record<string, HookKind>>
  readonly parallelConcurrency: number
  readonly cacheEnvironment?: Action.CacheEnvironment | undefined
}

/**
 * Options for {@link resolve}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options<H = FlowsHooks> {
  /** Pre-resolution config tested by `apply` predicates. */
  readonly config?: FlowsConfig | undefined
  /** Host whose literal `apply` selectors are active. Defaults to `"engine"`. */
  readonly target?: "engine" | "harness" | undefined
  /**
   * Hook names recognized by this host, each with the kind `H` declares for
   * it. The shared `config` and `configResolved` hooks are fixed to
   * `waterfall` and `parallel`; another kind fails with `hook_kind_mismatch`.
   */
  readonly hooks?: HookCatalog<H> | undefined
  /** Complete composition identity for sealed activity keys. Requires every selected plugin to have a version. */
  readonly cacheEnvironment?: Action.CacheEnvironment | undefined
  /** Maximum observers run at once. Defaults to 16 and cannot exceed 256. */
  readonly parallelConcurrency?: number | undefined
}

interface RawOptions {
  readonly config: unknown
  readonly target: unknown
  readonly hooks: unknown
  readonly cacheEnvironment: unknown
  readonly parallelConcurrency: unknown
}

const failure = (
  code: PluginErrorCode,
  message: string,
  path: string,
  fields: { readonly plugin?: string; readonly hook?: string } = {}
): PluginError => new PluginError({ code, message, path, ...fields })

const invalidPlugin = (
  path: string,
  complaint: string,
  fields: { readonly plugin?: string; readonly hook?: string } = {}
): PluginError => failure("invalid_plugin", `plugin input ${complaint}`, path, fields)

// Bound before quoting or scanning caller-controlled keys. Keep Boundary's
// identifier/dot and JSON-quoted/bracket path convention.
const diagnosticKey = (key: string): string => key.length > 64 ? `${key.slice(0, 64)}...` : key

const childPath = (path: string, key: string): string => {
  const bounded = diagnosticKey(key)
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(bounded) ? `${path}.${bounded}` : `${path}[${JSON.stringify(bounded)}]`
}

const ownData = (
  input: unknown,
  path: string,
  allowed?: ReadonlySet<string>
): Readonly<Record<string, unknown>> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidPlugin(path, "must be an ordinary record")
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) throw invalidPlugin(path, "must be an ordinary record")
  const output: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") throw invalidPlugin(path, "must not contain symbol keys")
    if (allowed !== undefined && !allowed.has(key)) {
      throw invalidPlugin(childPath(path, key), "contains an unknown property")
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw invalidPlugin(childPath(path, key), "must be an enumerable data property")
    }
    Object.defineProperty(output, key, { value: descriptor.value, enumerable: true })
  }
  return output
}

const snapshotOptions = (input: unknown): RawOptions => {
  const values = ownData(
    input,
    "$options",
    new Set(["config", "target", "hooks", "cacheEnvironment", "parallelConcurrency"])
  )
  return {
    config: values.config,
    target: values.target,
    hooks: values.hooks,
    cacheEnvironment: values.cacheEnvironment,
    parallelConcurrency: values.parallelConcurrency
  }
}

const validName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximumPluginNameLength &&
  Boundary.isWellFormedText(value) && !/^\s*$/u.test(value) && !/\p{Cc}/u.test(value)

const snapshotCatalog = (input: unknown): Readonly<Record<string, HookKind>> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidPlugin("$options.hooks", "must be an ordinary hook catalog")
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidPlugin("$options.hooks", "must be an ordinary hook catalog")
  }
  const output: Record<string, HookKind> = {}
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !validName(key)) {
      throw invalidPlugin("$options.hooks", "contains an invalid hook name")
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw invalidPlugin(childPath("$options.hooks", key), "must be an enumerable data property")
    }
    if (!(["sequential", "parallel", "first", "waterfall"] as ReadonlyArray<unknown>).includes(descriptor.value)) {
      throw invalidPlugin(childPath("$options.hooks", key), "contains an invalid hook kind")
    }
    Object.defineProperty(output, key, { value: descriptor.value, enumerable: true })
  }
  for (const hook of Object.keys(engineHooks) as ReadonlyArray<keyof typeof engineHooks>) {
    if (Object.hasOwn(output, hook) && output[hook] !== engineHooks[hook]) {
      throw failure(
        "hook_kind_mismatch",
        `hook catalog declares shared hook ${JSON.stringify(hook)} as ${
          JSON.stringify(output[hook])
        }, the kernel dispatches it as ${JSON.stringify(engineHooks[hook])}`,
        childPath("$options.hooks", hook),
        { hook }
      )
    }
  }
  return Object.freeze(output)
}

const snapshotHook = (
  entry: unknown,
  path: string,
  plugin: string,
  hook: string
): ((...args: Array<any>) => unknown) | HookObject<(...args: Array<any>) => unknown> => {
  if (typeof entry === "function") return entry as (...args: Array<any>) => unknown
  if (entry === undefined) {
    throw invalidPlugin(path, "must be a function or a hook object", { plugin, hook })
  }
  const values = ownData(entry, path, new Set(["order", "handler"]))
  if (typeof values.handler !== "function") {
    throw invalidPlugin(`${path}.handler`, "must be a function", { plugin, hook })
  }
  if (values.order !== undefined && values.order !== "pre" && values.order !== "post") {
    throw invalidPlugin(`${path}.order`, "must be pre or post", { plugin, hook })
  }
  return Object.freeze({
    ...(values.order === undefined ? {} : { order: values.order }),
    handler: values.handler
  }) as HookObject<(...args: Array<any>) => unknown>
}

const snapshotPlugin = <H>(
  input: unknown,
  path: string
): FlowsPlugin<H> => {
  const values = ownData(input, path, new Set(["name", "version", "enforce", "apply", "layer", "hooks"]))
  if (!validName(values.name)) throw invalidPlugin(`${path}.name`, "requires a bounded non-empty name")
  const name = values.name
  if (values.version !== undefined && !validName(values.version)) {
    throw invalidPlugin(`${path}.version`, "requires a bounded non-empty version", { plugin: name })
  }
  if (values.enforce !== undefined && values.enforce !== "pre" && values.enforce !== "post") {
    throw invalidPlugin(`${path}.enforce`, "must be pre or post", { plugin: name })
  }
  if (
    values.apply !== undefined && values.apply !== "engine" && values.apply !== "harness" &&
    typeof values.apply !== "function"
  ) throw invalidPlugin(`${path}.apply`, "must be engine, harness, or a predicate", { plugin: name })
  if (values.layer !== undefined && !Layer.isLayer(values.layer)) {
    throw invalidPlugin(`${path}.layer`, "must be an Effect Layer", { plugin: name })
  }

  let hooks: Readonly<Record<string, unknown>> | undefined
  if (values.hooks !== undefined) {
    const rawHooks = ownData(values.hooks, `${path}.hooks`)
    const snapshot: Record<string, unknown> = Object.create(null)
    for (const [index, hook] of Object.keys(rawHooks).entries()) {
      if (!validName(hook)) {
        throw invalidPlugin(`${path}.hooks[${index}]`, "contains an invalid hook name")
      }
      const entry = rawHooks[hook]
      Object.defineProperty(snapshot, hook, {
        value: snapshotHook(entry, childPath(`${path}.hooks`, hook), name, hook),
        enumerable: true
      })
    }
    hooks = Object.freeze(snapshot)
  }

  return Object.freeze({
    name,
    ...(values.version === undefined ? {} : { version: values.version }),
    ...(values.enforce === undefined ? {} : { enforce: values.enforce }),
    ...(values.apply === undefined ? {} : { apply: values.apply as Apply }),
    ...(values.layer === undefined ? {} : { layer: values.layer as Layer.Layer<never, any, any> }),
    ...(hooks === undefined ? {} : { hooks: hooks as Partial<H> })
  })
}

interface AdmittedPlugin<H> {
  readonly plugin: FlowsPlugin<H>
  readonly path: string
}

const flatten = <H>(input: unknown): ReadonlyArray<AdmittedPlugin<H>> => {
  const output: Array<AdmittedPlugin<H>> = []
  const arrays = new WeakSet<object>()
  const stack: Array<{ readonly value: unknown; readonly path: string; readonly depth: number }> = [
    { value: input, path: "$", depth: 0 }
  ]
  let nodes = 0
  while (stack.length > 0) {
    const current = stack.pop()!
    nodes += 1
    if (current.value === false || current.value === null || current.value === undefined) continue
    if (Array.isArray(current.value)) {
      if (current.depth >= maximumPluginDepth) {
        throw failure("resource_limit", `plugin input exceeds the depth limit of ${maximumPluginDepth}`, current.path)
      }
      if (arrays.has(current.value)) throw invalidPlugin(current.path, "contains a cycle or repeated preset array")
      arrays.add(current.value)
      const length = current.value.length
      // Every queued frame and array element costs a node, including omitted
      // entries. Refuse before enumerating keys, descriptors, or child frames.
      if (length > maximumPluginInputNodes - nodes - stack.length) {
        throw failure("resource_limit", `plugin input exceeds the ${maximumPluginInputNodes}-node limit`, current.path)
      }
      const keys = Reflect.ownKeys(current.value)
      if (keys.length !== length + 1 || !keys.includes("length")) {
        throw invalidPlugin(current.path, "must be a dense preset array with no extra properties")
      }
      for (let index = length - 1; index >= 0; index--) {
        const descriptor = Object.getOwnPropertyDescriptor(current.value, String(index))
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          throw invalidPlugin(`${current.path}[${index}]`, "must be an enumerable data property")
        }
        stack.push({ value: descriptor.value, path: `${current.path}[${index}]`, depth: current.depth + 1 })
      }
      continue
    }
    output.push(Object.freeze({ plugin: snapshotPlugin<H>(current.value, current.path), path: current.path }))
    if (output.length > maximumPlugins) {
      throw failure("resource_limit", `plugin input exceeds the ${maximumPlugins}-plugin limit`, current.path)
    }
  }
  return output
}

const included = <H>(
  plugin: FlowsPlugin<H>,
  config: FlowsConfig,
  target: "engine" | "harness"
): Effect.Effect<boolean, PluginError> => {
  const apply = plugin.apply
  if (apply === undefined) return Effect.succeed(true)
  if (typeof apply !== "function") return Effect.succeed(apply === target)
  return Effect.try({
    try: () => apply(config),
    catch: () =>
      failure("apply_failed", `plugin "${plugin.name}" apply predicate failed`, "$.apply", {
        plugin: plugin.name
      })
  }).pipe(
    Effect.flatMap((result) =>
      typeof result === "boolean"
        ? Effect.succeed(result)
        : Effect.fail(invalidPlugin("$.apply", "predicate must return a boolean", { plugin: plugin.name }))
    )
  )
}

const rank = (enforce: "pre" | "post" | undefined): number => (enforce === "pre" ? 0 : enforce === "post" ? 2 : 1)

/**
 * Resolves a plugin preset into an immutable, resource-bounded catalog.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const resolve = <H = FlowsHooks>(
  input: PluginInput<NoInfer<H>>,
  options: Options<NoInfer<H>> = {},
  configOverride?: FlowsConfig
): Effect.Effect<Resolved<H>, PluginError> =>
  Effect.gen(function*() {
    const raw = yield* Effect.try({
      try: () => snapshotOptions(options),
      catch: (cause) =>
        cause instanceof PluginError
          ? cause
          : invalidPlugin("$options", "could not be inspected without executing user code")
    })
    if (configOverride !== undefined && raw.config !== undefined) {
      return yield* Effect.fail(invalidPlugin(
        "$options.config",
        "cannot declare config in options alongside the positional override"
      ))
    }
    if (raw.target !== undefined && raw.target !== "engine" && raw.target !== "harness") {
      return yield* Effect.fail(invalidPlugin("$options.target", "must be engine or harness"))
    }
    if (
      raw.parallelConcurrency !== undefined &&
      (typeof raw.parallelConcurrency !== "number" || !Number.isSafeInteger(raw.parallelConcurrency) ||
        raw.parallelConcurrency <= 0 ||
        raw.parallelConcurrency > maximumParallelConcurrency)
    ) {
      return yield* Effect.fail(failure(
        "resource_limit",
        `parallel concurrency must be between 1 and ${maximumParallelConcurrency}`,
        "$options.parallelConcurrency"
      ))
    }
    const parallelConcurrency = raw.parallelConcurrency === undefined
      ? defaultParallelConcurrency
      : raw.parallelConcurrency
    const config = yield* Config.snapshot(configOverride ?? raw.config ?? {})
    const known = yield* Effect.try({
      try: () => snapshotCatalog(raw.hooks ?? engineHooks),
      catch: (cause) =>
        cause instanceof PluginError
          ? cause
          : invalidPlugin("$options.hooks", "could not be inspected without executing user code")
    })
    const admitted = yield* Effect.try({
      try: () => flatten<H>(input),
      catch: (cause) =>
        cause instanceof PluginError
          ? cause
          : invalidPlugin("$", "could not be inspected without executing user code")
    })
    const target = raw.target ?? "engine"
    const selected = yield* Effect.filter(admitted, ({ plugin }) => included(plugin, config, target))

    let handlerCount = 0
    for (const { path, plugin } of selected) {
      const pluginHooks = plugin.hooks as Readonly<Record<string, unknown>> | undefined
      if (pluginHooks === undefined) continue
      for (const hook of Object.keys(pluginHooks)) {
        if (!Object.hasOwn(known, hook)) {
          return yield* Effect.fail(failure(
            "unknown_hook",
            `plugin ${JSON.stringify(plugin.name)} declares unknown hook ${JSON.stringify(diagnosticKey(hook))}`,
            childPath(`${path}.hooks`, hook),
            { plugin: plugin.name, hook }
          ))
        }
        handlerCount += 1
        if (handlerCount > maximumHandlers) {
          return yield* Effect.fail(failure(
            "resource_limit",
            `plugin handlers exceed the limit of ${maximumHandlers}`,
            childPath(`${path}.hooks`, hook)
          ))
        }
      }
    }

    const seen = new Set<string>()
    for (const { plugin } of selected) {
      if (seen.has(plugin.name)) {
        return yield* Effect.fail(failure(
          "duplicate_name",
          `duplicate plugin name "${plugin.name}"`,
          "$.name",
          { plugin: plugin.name }
        ))
      }
      seen.add(plugin.name)
    }

    const plugins = Object.freeze(
      selected
        .map(({ plugin }, index) => ({ plugin, index }))
        .sort((left, right) => rank(left.plugin.enforce) - rank(right.plugin.enforce) || left.index - right.index)
        .map(({ plugin }) => plugin)
    )
    const entries: Array<readonly [string, ReadonlyArray<HandlerRecord>]> = []
    for (const hook of Object.keys(known)) {
      const records: Array<{
        readonly record: HandlerRecord
        readonly enforceRank: number
        readonly orderRank: number
        readonly index: number
      }> = []
      for (const [index, plugin] of plugins.entries()) {
        const pluginHooks = plugin.hooks as Readonly<Record<string, unknown>> | undefined
        if (pluginHooks === undefined || !Object.hasOwn(pluginHooks, hook)) continue
        const entry = pluginHooks[hook]
        const record = Object.freeze({ plugin: plugin.name, hook, handler: handlerOf(entry) })
        records.push({ record, enforceRank: rank(plugin.enforce), orderRank: rank(orderOf(entry)), index })
      }
      // Vite's rule, verbatim: the per-hook `order` is the outer partition and
      // the enforce-sorted plugin list supplies the stable order inside it, so a
      // hook marked `order: "pre"` runs ahead of every normal-order handler even
      // when its plugin is `enforce: "post"`.
      const ordered = records
        .sort((left, right) =>
          left.orderRank - right.orderRank || left.enforceRank - right.enforceRank || left.index - right.index
        )
        .map(({ record }) => record)
      if (ordered.length > 0) entries.push([hook, Object.freeze(ordered)])
    }
    const cacheEnvironment = yield* snapshotCacheEnvironment(raw.cacheEnvironment, plugins)
    return Object.freeze({
      plugins,
      handlers: ImmutableMap.make(entries),
      kinds: known,
      parallelConcurrency,
      ...(cacheEnvironment === undefined ? {} : { cacheEnvironment })
    })
  })

/**
 * Merges every resolved plugin layer left-to-right and supplies the detached
 * cache environment captured during resolution.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const layer = <H>(resolved: Resolved<H>): Layer.Layer<any, PluginError, any> =>
  mergePluginLayers(resolved.plugins, resolved.cacheEnvironment)
