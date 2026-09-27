---
title: "Installation"
description: "Install @smthrs/plugin, its runtime requirements, its import forms, and the subpaths its export map blocks."
sidebar:
  order: 1
---

## Install the package

Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

Install `effect` explicitly at `4.0.0-rc.115`. The kernel depends on it, but your
plugins import `Effect`, `Layer`, and `Option` directly, so `effect` belongs in
your own dependency list at the release the kernel is built against. A different
`effect` major gives you two copies of the runtime and two sets of service tags.

The package requires Node.js 26.4.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. Its runtime dependencies install with it:
[`@smthrs/flow`](/api/flow) supplies `Action.CacheEnvironment` for
[cache identity](./guides/cache-identity.md), and
[`@smthrs/canonical`](/api/canonical) supplies immutable catalog maps.

## Import forms

The root entry point exports the plugin, hook, and error declarations directly,
and the four stateful modules as namespaces:

```ts
import { Config, Kernel, Plugins, Resolve } from "@smthrs/plugin"
import type { FlowsHooks, FlowsPlugin, PluginInput } from "@smthrs/plugin"
import { engineHooks, make, PluginError } from "@smthrs/plugin"
```

Each module is also importable from its own subpath, which is the form the
[API reference](./api.md) uses:

```ts
import * as Config from "@smthrs/plugin/Config"
import * as Kernel from "@smthrs/plugin/Kernel"
import * as Plugins from "@smthrs/plugin/Plugins"
import * as Resolve from "@smthrs/plugin/Resolve"
```

The full list of public subpaths is `@smthrs/plugin/Config`,
`@smthrs/plugin/Hooks`, `@smthrs/plugin/Kernel`, `@smthrs/plugin/Plugin`,
`@smthrs/plugin/PluginError`, `@smthrs/plugin/Plugins`, and
`@smthrs/plugin/Resolve`. Two forms are blocked in the export map:
`@smthrs/plugin/internal/*` and `@smthrs/plugin/*/index`.
`@smthrs/plugin/package.json` is exported.

## The augmentation specifier

A host that declares its own hooks augments the interface in the root module,
never in a subpath:

```ts
declare module "@smthrs/plugin" {
  interface FlowsHooks {
    // your hooks
  }
}
```

`FlowsHooks` is declared in the entry point precisely so this specifier works:
TypeScript can augment an interface only in the module that declares it. See
[Declare hooks for your host](./guides/host-your-own-hooks.md).

## Next step

Build a host with one hook of its own and run it in the
[Quickstart](./quickstart.md).
