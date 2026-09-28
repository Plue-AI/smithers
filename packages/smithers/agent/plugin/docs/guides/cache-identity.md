---
title: "Declare a cache identity for sealed steps"
description: "Supply Action.CacheEnvironment so a composition's sealed cache keys are shareable across runs, and understand why every selected plugin then needs a version."
sidebar:
  order: 5
---

Skip this guide unless your host runs on the Smithers durable engine, which is
what reads the identity described here. Everything else in this package works
without it.

A sealed step in the [durable engine](/api/engine) is content-addressed: the
same call replays one recorded result instead of paying the provider again.
That is only safe when the key covers the composition the result was computed
under. Swap a model plugin and keep the key, and the run is served a stale
answer computed by a different composition.

The kernel is where a host says what its composition is. Declaring
`cacheEnvironment` folds every selected plugin's identity into the environment
that keys sealed steps. Omitting it keeps sealed keys local to the run.

## Omitting it is the honest default

```ts
import { Kernel, make } from "@smthrs/plugin"

const kernel = Kernel.make([make({ name: "flows-plugin-model-sonnet" })])
```

`Action.CurrentCacheEnvironment` resolves to `undefined` under this kernel's
layer, which is the engine's "nothing was declared" state. Sealed keys are
pinned to the current execution, so nothing is shared and nothing is wrong. Use
this until you can state the composition's whole identity.

## Declaring it requires the complete identity

Pass the additional layer identities your host built outside the plugin list and
the capability envelope the composition actually holds:

```ts
const kernel = Kernel.make(
  [make({ name: "flows-plugin-model-sonnet", version: "1.4.0" })],
  {},
  { cacheEnvironment: { layers: ["Host=node"], capabilities: { fs: ["/workspace/**"] } } }
)
// CurrentCacheEnvironment:
// { layers: ["flows-plugin-model-sonnet@1.4.0", "Host=node"], capabilities: { fs: ["/workspace/**"] } }
```

The kernel prepends each selected plugin as `name@version`, in resolved order,
ahead of the layers you supplied. Change a plugin's version and the declared
layers change, so the sealed keys change with it.

`Action.CacheEnvironment` is complete by contract: it is the whole authority and
composition envelope, not a hint. Supply the capabilities the composition really
grants. A result computed under a broad envelope must not be served to a run
with an attenuated one.

## Every selected plugin needs a version

Declaring a cache environment makes `version` required on every plugin the
kernel selected:

```ts
const refused = Kernel.make(
  [make({ name: "flows-plugin-model-sonnet" })],
  {},
  { cacheEnvironment: { layers: [], capabilities: {} } }
)
// Fails with PluginError { code: "cache_environment_invalid", plugin: "flows-plugin-model-sonnet", path: "$.version" }
```

A versionless plugin is refused rather than folded in as a bare name, because a
bare name claims that two different builds of that plugin are the same
composition. The refusal names the plugin, so the fix is to add its version or
to drop the cache environment.

## Identity is injective

Both halves of `name@version` escape `%` first and then `@`, so the joined
string can be split back apart:

| Plugin name        | Version | Layer entry            |
| ------------------ | ------- | ---------------------- |
| `flows-plugin-a`   | `1.0.0` | `flows-plugin-a@1.0.0` |
| `flows-plugin-a@b` | `c`     | `flows-plugin-a%40b@c` |
| `flows-plugin-a`   | `b@c`   | `flows-plugin-a@b%40c` |
| `@smthrs/x`        | `1.0.0` | `%40smthrs/x@1.0.0`    |

An ordinary identity stays readable, and two compositions that differ only in
where the delimiter fell never collapse onto one sealed identity.

## The value is copied before the engine sees it

Resolution decodes the environment against the `Action.CacheEnvironment` schema,
copies and freezes every layer entry, capability name, and capability array, and
only then provides it. Invalid or mutable caller data never reaches
`Action.CurrentCacheEnvironment`. A malformed environment fails with
`cache_environment_invalid` and the option path.

## Plugins cannot replace it

The kernel layer seals `Action.CurrentCacheEnvironment` after merging plugin
layers. A plugin layer that provides `Action.layerCacheEnvironment` is
overridden by the declared environment, or by `undefined` when the host
declared none, so no plugin can forge or declare the composition's identity.
