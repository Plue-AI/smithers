---
title: "API reference"
description: "Every export of @smthrs/plugin: the plugin and hook declarations, the Kernel, Plugins, Resolve, and Config modules, the PluginError codes, and the published limits."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/plugin/docs/api.md"
---

Import the declarations from the root and the four stateful modules either as
namespaces from the root or from their own subpaths:

```ts
import { engineHooks, type FlowsPlugin, make, PluginError } from "@smthrs/plugin"
import * as Config from "@smthrs/plugin/Config"
import * as Kernel from "@smthrs/plugin/Kernel"
import * as Plugins from "@smthrs/plugin/Plugins"
import * as Resolve from "@smthrs/plugin/Resolve"
```

Every function that can refuse returns `Effect<A, PluginError>`, except
`Config.merge` and `Config.deepFreeze`, which are synchronous and throw a
`PluginError`.

## Example

```ts
import { Kernel, make } from "@smthrs/plugin"

const editor = make({
  name: "flows-plugin-editor",
  hooks: { config: () => Effect.succeed({ editor: { readOnly: false } }) }
})
const kernel = await Effect.runPromise(Kernel.make([editor], {}, { target: "harness" }))
console.log(kernel.config) // { editor: { readOnly: false } }
```

## Root exports

| Export                                                                   | Kind               | Summary                                                               |
| ------------------------------------------------------------------------ | ------------------ | --------------------------------------------------------------------- |
| `FlowsHooks`                                                             | interface          | The augmentable hook catalog. Declares `config` and `configResolved`. |
| `Apply`, `FlowsPlugin`, `PluginInput`, `make`                            | from `Plugin`      | The plugin record and its constructor.                                |
| Hook kinds and type-level helpers, `engineHooks`, `handlerOf`, `orderOf` | from `Hooks`       | The hook surface.                                                     |
| `PluginErrorCode`, `PluginError`                                         | from `PluginError` | The single typed failure.                                             |
| `Config`, `Kernel`, `Plugins`, `Resolve`                                 | namespaces         | The four modules.                                                     |

### FlowsHooks

```ts
interface FlowsHooks {
  readonly config: WaterfallHook<(config: FlowsConfig) => Effect.Effect<Partial<FlowsConfig> | void, any, never>>
  readonly configResolved: ParallelHook<(config: ResolvedConfig) => Effect.Effect<void, any, never>>
}
```

Declared in the entry point so that `declare module "@smthrs/plugin"` can
augment it. Open for augmentation, closed for dispatch: the kernel dispatches
only the config lifecycle, and a host supplies and dispatches its own catalog
over the same augmented interface.

Both startup hooks are context-free. `Kernel.make` runs them before any plugin
layer is built and supplies no services of its own, so no externally supplied
service is available during startup. A handler that needs one provides it
inside the hook with `Effect.provide`. A plugin literal whose `config` hook
requires a service fails to compile against `FlowsHooks`; a host whose startup
hooks do require services declares a separate hook interface, and
`Kernel.make<H>` then carries the requirement as `Kernel.StartupContext<H>`.

## Plugin

```ts
type Apply = "engine" | "harness" | ((config: FlowsConfig) => boolean)

interface FlowsPlugin<H = FlowsHooks> {
  readonly name: string
  readonly version?: string | undefined
  readonly enforce?: "pre" | "post" | undefined
  readonly apply?: Apply | undefined
  readonly layer?: Layer.Layer<never, any, any> | undefined
  readonly hooks?: Partial<H> | undefined
}

type PluginInput<H = FlowsHooks> =
  | FlowsPlugin<H>
  | false
  | null
  | undefined
  | ReadonlyArray<PluginInput<H>>

const make: <H = FlowsHooks>(plugin: FlowsPlugin<H>) => FlowsPlugin<H>
```

| Field     | Meaning                                                                                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`    | Required and unique among selected plugins. Compared as an exact Unicode string, at most 256 UTF-16 code units, never empty or whitespace only. Convention: `flows-plugin-<thing>`. |
| `version` | Semantic identity folded into sealed cache keys. Required when the host declares a `cacheEnvironment`; refused as empty or malformed text.                                          |
| `enforce` | Ordering group. Omitted means normal.                                                                                                                                               |
| `apply`   | Conditional inclusion. A literal names the host target; a predicate receives the pre-resolution configuration and returns a boolean.                                                |
| `layer`   | Services this plugin contributes to the composition. Must be an Effect `Layer`.                                                                                                     |
| `hooks`   | Typed hook entries. Only keys declared in `H` compile, and only names in the host's runtime catalog resolve.                                                                        |

`make` is an identity function that pins a plugin literal to `FlowsPlugin<H>`,
so an excess or misspelled hook key fails at the definition site.
`PluginInput` accepts falsy entries and arrays nested up to
`maximumPluginDepth`, which is what makes a preset an ordinary function that
returns plugins.

## Hooks

```ts
type HookKind = "sequential" | "parallel" | "first" | "waterfall"

interface HookObject<F> {
  readonly order?: "pre" | "post" | undefined
  readonly handler: F
}

type HookEntry<K extends HookKind, F> = (F | HookObject<F>) & HookMeta<K, F>

type SequentialHook<F> = HookEntry<"sequential", F>
type ParallelHook<F> = HookEntry<"parallel", F>
type FirstHook<F> = HookEntry<"first", F>
type WaterfallHook<F> = HookEntry<"waterfall", F>
```

`HookMeta<K, F>` is a phantom carrier: it records the kind and the handler type
in the type system and adds nothing at runtime. A hook entry is either the bare
handler or the `{ order, handler }` object; `undefined` and `null` are refused.

Type-level helpers, used by the dispatcher's signatures and available to hosts:

| Helper             | Extracts                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `KindOf<T>`        | The declared kind of a hook entry type.                                                                                |
| `HandlerOf<T>`     | The handler function type.                                                                                             |
| `KeysOfKind<H, K>` | The hook names of kind `K` in interface `H`.                                                                           |
| `ArgsOf<T>`        | The positional argument tuple the handler accepts.                                                                     |
| `ReturnOf<T>`      | The Effect the handler returns.                                                                                        |
| `SuccessOf<T>`     | That Effect's success value.                                                                                           |
| `ContextOf<T>`     | That Effect's required context.                                                                                        |
| `HookCatalog<H>`   | The runtime catalog for `H`: a name declared in `H` must carry the kind its type declares; other names admit any kind. |

Values:

```ts
const engineHooks: Readonly<{ readonly config: "waterfall"; readonly configResolved: "parallel" }>
const handlerOf: (entry: unknown) => (...args: Array<any>) => unknown
const orderOf: (entry: unknown) => "pre" | "post" | undefined
```

`engineHooks` is the frozen runtime catalog for the shared configuration hooks,
and the catalog `Resolve.resolve` checks against when a host supplies none.
Spread it into your own catalog to keep the config lifecycle available.
`handlerOf` and `orderOf` normalize either hook entry form.

## Kernel

```ts
interface Kernel<H = FlowsHooks> {
  readonly plugins: Plugins.Service<H>
  readonly config: ResolvedConfig
  readonly layer: Layer.Layer<any, PluginError, any>
  readonly observerErrors: ReadonlyArray<PluginError>
}

type ConfigContext<H> = ContextOf<H["config"]>
type StartupContext<H> = ConfigContext<H> | ContextOf<H["configResolved"]>

const make: <H = FlowsHooks>(
  input: PluginInput<NoInfer<H>>,
  config?: FlowsConfig,
  options?: Omit<Resolve.Options<NoInfer<H>>, "config">
) => Effect.Effect<Kernel<H>, PluginError, StartupContext<H>>

const runConfig: <H = FlowsHooks>(
  plugins: Plugins.Service<H>,
  config: FlowsConfig
) => Effect.Effect<ResolvedConfig, PluginError, ConfigContext<H>>
```

`StartupContext<H>` is `never` for `FlowsHooks`, whose startup hooks are
context-free, so `Kernel.make([...])` runs with `Effect.runPromise` as is. For a
separate hook interface whose `config` or `configResolved` handlers require
services, the requirement is the startup Effect's context and the caller
provides it before running; the kernel never supplies startup services itself.

`make` performs startup in this order:

1. Snapshot the positional `config`.
2. Resolve the plugin list against `options`.
3. Run the `config` waterfall, deep-merging each returned patch.
4. Decode and freeze the result into a `ResolvedConfig`.
5. Run `configResolved` observers in parallel, collecting their failures into
   `observerErrors` rather than failing.
6. Merge the selected plugins' layers, left to right in resolved order.

The positional `config` is the kernel's only pre-resolution configuration
source. `Options.config` is excluded from the options type so a caller cannot
declare a second one, and a `config` key smuggled past the type fails at
runtime with `invalid_plugin` at `$options.config`, the same refusal an
unknown option key gets. `runConfig` exposes step 3 and step 4 on their own, for a
host that resolved its plugin list separately. Before dispatching the first
hook, it validates and copies the supplied config into a detached, recursively
frozen snapshot. Invalid or accessor-bearing input fails with `config_invalid`
before any hook runs, without executing accessors. The final waterfall result
is admitted again through `Config.resolve`.

`observerErrors` is a return value, not a log: a `configResolved` failure never
fails startup, so a host that ignores the array cannot tell a working observer
from a broken one.

## Plugins

```ts
interface Service<H = FlowsHooks> {
  readonly resolved: Resolved<H>
  readonly handlers: (hook: string) => ReadonlyArray<HandlerRecord>

  readonly sequential: <K extends KeysOfKind<H, "sequential">>(
    hook: K,
    ...args: ArgsOf<H[K]>
  ) => Effect.Effect<ReadonlyArray<SuccessOf<H[K]>>, PluginError, ContextOf<H[K]>>

  readonly parallel: <K extends KeysOfKind<H, "parallel">>(
    hook: K,
    ...args: ArgsOf<H[K]>
  ) => Effect.Effect<ReadonlyArray<PluginError>, never, ContextOf<H[K]>>

  readonly first: <K extends KeysOfKind<H, "first">>(
    hook: K,
    ...args: ArgsOf<H[K]>
  ) => Effect.Effect<SuccessOf<H[K]>, PluginError, ContextOf<H[K]>>

  readonly waterfall: <K extends KeysOfKind<H, "waterfall">>(
    hook: K,
    initial: ArgsOf<H[K]>[0],
    merge: (previous: ArgsOf<H[K]>[0], patch: Exclude<SuccessOf<H[K]>, void>) => ArgsOf<H[K]>[0]
  ) => Effect.Effect<ArgsOf<H[K]>[0], PluginError, ContextOf<H[K]>>
}

const make: <H = FlowsHooks>(resolved: Resolved<H>) => Service<H>
const makeNoop: <H = FlowsHooks>() => Service<H>

class Plugins extends Context.Service<Plugins, Service>()("flows/plugin/Plugins") {}
const layer: (resolved: Resolved) => Layer.Layer<Plugins>
const layerNoop: Layer.Layer<Plugins>
```

Dispatch semantics, one row per kind:

| Method       | Runs                                                      | Returns                                                                | On handler failure                                                               |
| ------------ | --------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `sequential` | Every handler, in resolved order, one at a time.          | Each handler's success value, in resolved order.                       | Fails the caller with `hook_failed` and stops.                                   |
| `parallel`   | Every handler, bounded by `Resolved.parallelConcurrency`. | The failures, in resolved handler order. Success values are discarded. | Never fails the caller.                                                          |
| `first`      | Handlers in order until one returns `Option.some`.        | That `Option`, or `Option.none()`.                                     | Fails with `hook_failed`; a non-`Option` value fails with `invalid_hook_result`. |
| `waterfall`  | Every handler, threading the merged value.                | The final value.                                                       | Fails with `hook_failed` and stops.                                              |

Every method first compares its kind with the runtime catalog the resolution
admitted (`Resolved.kinds`). A hook the catalog declares with a different kind
is refused before any handler runs: `sequential`, `first`, and `waterfall` fail
with `hook_kind_mismatch`, and `parallel` returns that one error. A hook name
absent from the catalog dispatches nothing. The typed signatures make the
mismatch unreachable without a cast; the runtime check covers the cast.

Handlers must return an Effect. Synchronous throws, Effect failures and defects,
and non-Effect results (including `undefined`, scalars, and Promises) become
`hook_failed` with the plugin and hook names. Non-Effect error messages include
the result's JavaScript `typeof`. Parallel dispatch collects these errors and
continues running sibling observers, including with `parallelConcurrency: 1`.
`Kernel.make` succeeds and reports them in `observerErrors`. Sequential dispatch
fails with the attributed error and skips later handlers.

A waterfall handler whose Effect succeeds with `undefined` leaves the value
unchanged: the merge function is not called. A merge that throws a `PluginError` keeps that
error's code and path and gains the handler's attribution; a merge that throws
anything else becomes `config_invalid` attributed to the handler.

Cancellation is fiber interruption through scope closure. Nothing threads an
`AbortSignal`. Interrupting a dispatch interrupts the handler in flight, runs
its finalizers, and skips the handlers that had not started.

The `Plugins` service tag, `layer`, and `layerNoop` hold one dispatcher over the
process-wide augmented `FlowsHooks`. A host typed against a separate hook
interface holds its `Service<H>` directly and uses none of the three.

## Resolve

```ts
interface HandlerRecord {
  readonly plugin: string
  readonly hook: string
  readonly handler: (...args: Array<any>) => unknown
}

interface Resolved<H = FlowsHooks> {
  readonly plugins: ReadonlyArray<FlowsPlugin<H>>
  readonly handlers: ReadonlyMap<string, ReadonlyArray<HandlerRecord>>
  readonly kinds: Readonly<Record<string, HookKind>>
  readonly parallelConcurrency: number
  readonly cacheEnvironment?: Action.CacheEnvironment | undefined
}

interface Options<H = FlowsHooks> {
  readonly config?: FlowsConfig | undefined
  readonly target?: "engine" | "harness" | undefined
  readonly hooks?: HookCatalog<H> | undefined
  readonly cacheEnvironment?: Action.CacheEnvironment | undefined
  readonly parallelConcurrency?: number | undefined
}

const resolve: <H = FlowsHooks>(
  input: PluginInput<NoInfer<H>>,
  options?: Options<NoInfer<H>>,
  configOverride?: FlowsConfig
) => Effect.Effect<Resolved<H>, PluginError>

const layer: <H>(resolved: Resolved<H>) => Layer.Layer<any, PluginError, any>
```

| Option                | Default       | Meaning                                                                                                                                                                                                                                                                                                      |
| --------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config`              | `{}`          | Pre-resolution configuration tested by `apply` predicates. `Kernel.make` supplies it positionally and omits this field. Supplying both `config` and `configOverride` fails with `invalid_plugin` at `$options.config`.                                                                                       |
| `target`              | `"engine"`    | The host whose literal `apply` selectors are active.                                                                                                                                                                                                                                                         |
| `hooks`               | `engineHooks` | The hook names and kinds this host recognizes, typed as `HookCatalog<H>`. The `unknown_hook` guard checks against it, the frozen copy is `Resolved.kinds`, and `config` or `configResolved` labelled with any kind but `waterfall` or `parallel` fails with `hook_kind_mismatch` at `$options.hooks.<name>`. |
| `cacheEnvironment`    | absent        | Complete composition identity for sealed activity keys. Requires a `version` on every selected plugin.                                                                                                                                                                                                       |
| `parallelConcurrency` | `16`          | Maximum observers run at once. A positive safe integer through 256.                                                                                                                                                                                                                                          |

`resolve` is once-only and everything it returns is a copy the kernel owns.
Plugin records and hook objects are snapshotted, handler records and ordered
arrays are frozen, and `handlers` is a read-only map facade with no `set`,
`delete`, or `clear`. Reflection is descriptor-only: accessors never execute,
exotic prototypes are refused, and a hostile proxy observes a bounded number of
traps whose results are copied rather than retained.

Order of the checks: options, flatten, validate every record, filter by `apply`,
check hook names against the catalog for selected plugins, reject duplicate
names, order, then decode the cache environment. Structure is validated before
filtering, so exclusion cannot hide a malformed plugin; catalog names are
checked after, so a shared preset carrying harness-only hooks still resolves
under an engine kernel.

Ordering follows Vite exactly. `enforce` sorts the plugin list once into pre,
normal, and post, stably within each group. The per-hook `order` then
re-partitions that list for one hook, so `{ order: "pre", handler }` runs ahead
of every normal-order handler even when its plugin is `enforce: "post"`. Ties
keep resolved plugin order.

`layer` merges every selected plugin's layer left to right, so an earlier
plugin's services are visible to a later plugin's layer, and the later plugin
wins when two provide the same tag. A layer that fails during acquisition
becomes `layer_failed` with the plugin's name. `layer` also seals
`Action.CurrentCacheEnvironment`: plugin layers read the declared environment,
or `undefined` when none was declared, and a plugin layer that provides its own
environment is overridden.

### Limits

| Constant                     | Value | Refusal                       |
| ---------------------------- | ----- | ----------------------------- |
| `maximumPlugins`             | 256   | `resource_limit`              |
| `maximumHandlers`            | 1,024 | `resource_limit`              |
| `maximumPluginInputNodes`    | 4,096 | `resource_limit`              |
| `maximumPluginDepth`         | 64    | `resource_limit`              |
| `maximumParallelConcurrency` | 256   | `resource_limit`              |
| `maximumPluginNameLength`    | 256   | `invalid_plugin`              |
| `defaultParallelConcurrency` | 16    | none, it is the default value |

A `resource_limit` carries the path of the offending entry or preset array, and
the handler bound counts the handlers the kernel dispatches. Plugin, version,
and hook names are a separate check, not a budget: they are control-free,
well-formed strings within `maximumPluginNameLength` that are neither empty nor
entirely whitespace, and a name that is not fails with `invalid_plugin` at its
own path even when every budget is free.

## Config

```ts
const ConfigValue: Schema.Json
type ConfigValue = typeof ConfigValue.Type

const FlowsConfig: Schema.Codec<Readonly<Record<string, ConfigValue>>, unknown>
type FlowsConfig = typeof FlowsConfig.Type

const ResolvedConfig: typeof FlowsConfig
type ResolvedConfig = typeof ResolvedConfig.Type

const defaults: ResolvedConfig

const merge: (base: FlowsConfig, patch: unknown) => FlowsConfig
const deepFreeze: <A extends ConfigValue>(value: A) => A
const snapshot: (config: unknown) => Effect.Effect<FlowsConfig, PluginError>
const resolve: (config: unknown) => Effect.Effect<ResolvedConfig, PluginError>
```

| Export       | Behavior                                                                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaults`   | The frozen empty configuration. Engine policy is deliberately not defaulted here.                                                                                                                                                                                         |
| `merge`      | Copies and deep-merges a patch over a base. Records merge key by key; every other JSON value replaces wholesale. Raw operands are admitted; unchanged snapshot subtrees are reused. Cached totals enforce result bounds. Throws `PluginError` with code `config_invalid`. |
| `deepFreeze` | Copies and recursively freezes one JSON value without retaining caller-owned objects. Throws `PluginError`.                                                                                                                                                               |
| `snapshot`   | Admits a raw pre-resolution configuration as an immutable snapshot.                                                                                                                                                                                                       |
| `resolve`    | Decodes the post-waterfall configuration into its final immutable form.                                                                                                                                                                                                   |

`FlowsConfig` and `ResolvedConfig` decode through the same admission contract as
`snapshot` and `resolve`. Decoding raw input detaches and recursively freezes it;
invalid input produces a schema error. `Schema.is` recognizes admitted snapshots,
not mutable JSON shapes. Encoding accepts admitted snapshots and returns their
JSON value. The TypeScript types remain read-only namespace maps.

Known snapshots can be reused by `snapshot`, `resolve`, and `merge`. Freezing an
object yourself does not establish admission. A merge copies each changed record
and retains unchanged frozen subtrees. It fully admits and detaches patch data,
including references to previous snapshots, so patches cannot introduce shared
references. Cached byte, member, node, and depth totals enforce result bounds.
Admission work scales with the initial tree plus patch data; copying changed
records also scales with their immediate key counts.

Configuration is a plugin-owned JSON namespace map. The root keys `engine`,
`retry`, `store`, and `plugins` are refused, because the kernel does not apply
those policies.

Refused with `config_invalid`, at the offending path, without executing user
accessors: cycles, repeated object references, sparse arrays, accessors, symbol
keys, exotic prototypes, non-finite numbers, unpaired surrogates, `undefined`
members, and the prototype-control keys `__proto__`, `constructor`, and
`prototype`. `undefined` is refused rather than dropped, so
`{ endpoint: undefined }` fails at `$.endpoint` instead of resolving to `{}`.
Omit the key, or write `null`.

### Limits

| Constant               | Value                   |
| ---------------------- | ----------------------- |
| `maximumConfigBytes`   | 1 MiB of encoded JSON   |
| `maximumConfigDepth`   | 64 container edges      |
| `maximumConfigMembers` | 4,096 aggregate members |
| `maximumConfigNodes`   | 8,192 aggregate values  |

Strings are limited to 64 KiB of encoded JSON and keys to 1 KiB.

## Cache identity

`Options.cacheEnvironment` is optional. Omitting it keeps sealed activity keys
local to the run and leaves plugin `version` optional. Supplying it requires the
complete `Action.CacheEnvironment` schema and a bounded, non-empty `version` on
every selected plugin.

Resolution copies and freezes every layer entry, capability record, and
capability array, then prepends each selected `name@version` in resolved order.
Both halves percent-escape `%` and then `@`, so the identity is injective:
`a@b` at version `c` and `a` at version `b@c` produce different layer entries
instead of one shared sealed identity. A scoped name reads as
`%40scope/name@1.0.0`. A versionless composition fails with
`cache_environment_invalid` instead of declaring an ambiguous cross-run
identity. Invalid or mutable caller data never reaches
`Action.CurrentCacheEnvironment`, and no plugin layer can declare or replace
it.

## PluginError

```ts
const PluginErrorCode: Schema.Literals<[
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
]>
type PluginErrorCode = typeof PluginErrorCode.Type

class PluginError extends Schema.TaggedError<PluginError>()("flows/plugin/PluginError", {
  code: PluginErrorCode,
  message: Schema.String,
  plugin: Schema.optional(Schema.String),
  hook: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown)
}) {}
```

Every startup and dispatch refusal uses this one error. `plugin` and `hook` are
attribution, `path` is a diagnostic dollar-path into the refused value, and
`cause` carries a failing handler's or layer's original failure. Match on
`code`; the messages are prose.

`cause` is not redacted. It holds whatever the plugin failed or threw with,
which can include credentials or config values. Keep it in process for
diagnostics, and redact it before a host logs, persists, or transmits a
`PluginError`.

A dollar-path is not an RFC 6901 JSON Pointer: `$` is the input, `.config` an
identifier property, `[2]` an array index, and `["not an identifier"]` any other
key, JSON-quoted. So `$[2].hooks.config` is the third plugin's `config` entry
and `$options.parallelConcurrency` is an option.

| Code                        | Meaning                                                                        |
| --------------------------- | ------------------------------------------------------------------------------ |
| `duplicate_name`            | Two selected plugins have the same exact name.                                 |
| `unknown_hook`              | A plugin declares a hook absent from the host catalog.                         |
| `hook_kind_mismatch`        | A catalog kind disagrees with the kind the kernel or a dispatch method runs.   |
| `invalid_plugin`            | A plugin, preset, option, or hook entry has an invalid runtime shape.          |
| `apply_failed`              | An `apply` predicate threw. Its raw failure is not retained.                   |
| `config_invalid`            | Config is not bounded strict JSON or uses a reserved policy key.               |
| `cache_environment_invalid` | Cache identity is malformed or incomplete.                                     |
| `invalid_hook_result`       | A first hook returned a value other than `Option`.                             |
| `resource_limit`            | Preset, plugin, handler, or concurrency work exceeds a published bound.        |
| `hook_failed`               | A hook Effect failed, defected, threw synchronously, or returned a non-Effect. |
| `layer_failed`              | A validated plugin layer failed during acquisition.                            |

`configResolved` is a lossy observer boundary. Its failures do not fail kernel
startup; `Kernel.observerErrors` returns them for redacted logging by the host.
What to change for each code is in [Troubleshooting](/troubleshooting/).

## Related packages

The shipped hook catalog is the Smithers agent loop in
[`@smthrs/agent`](https://agent.smithers.sh/reference/api/), which augments `FlowsHooks` with three
waterfalls. `Action.CacheEnvironment` comes from
[`@smthrs/flow`](https://flow.smithers.sh/reference/api/). The other runtime dependency,
[`@smthrs/canonical`](https://canonical.smithers.sh/reference/api/), supplies immutable catalog maps.
