---
title: "Installation"
description: "Install @smthrs/registry, its runtime requirements, its import forms, and the packages a filesystem-backed or runnable composition adds."
sidebar:
  order: 1
---

## Install the package

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

[`effect`](https://effect.website) is a peer dependency pinned at
`4.0.0-rc.115`. Declare it yourself at that version: your own code imports
`effect/Effect` and `effect/Layer` directly, and two copies of `effect` in one
program are two sets of service tags. Everything else installs with the
package: the `yaml` parser frontmatter is read with, and the `@smthrs/*`
packages the descriptor model is built from.

The package requires Node.js 26.4.0 or later and ships as both ESM and
CommonJS with TypeScript declarations.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Descriptor, Discovery, Executable, Registry } from "@smthrs/registry"
```

Each module is also importable from its own subpath, which is the form the
[API reference](./api.md) uses in its examples:

```ts
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
```

Two subpath forms are not public: `@smthrs/registry/internal/*` and
`@smthrs/registry/*/index`. Both are blocked in the package's export map.
`@smthrs/registry/package.json` is exported.

## What a filesystem composition adds

The package itself has no platform bindings. `Discovery` is written against
`effect`'s portable `FileSystem` and `Path` services, so scanning a real
directory means providing an implementation of both:

```bash
pnpm add @effect/platform-node@4.0.0-rc.115 @effect/platform-node-shared@4.0.0-rc.115
```

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Layer from "effect/Layer"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
```

A composition that reads descriptors it already holds, or that stubs the
registry entirely, needs neither: `Registry.layerNoop` requires nothing, and
`Registry.layerFromDescriptors` requires only `FileSystem` and `Path` so it can
still load a body on demand. See
[Test against a registry](./guides/testing.md).

## What a runnable composition adds

`Executable` turns a descriptor into a durable flow, so it needs the authoring
and runtime packages the flow is built from:

- [`@smthrs/flow`](/api/flow) supplies `Action`, `Interpreter`, and the flow
  values a descriptor delegates to.
- [`@smthrs/core`](/api/core) supplies the annotations and placement values a
  loaded body carries.
- [`@smthrs/plan`](/api/plan) supplies the plan nodes a delegation becomes.

Those three are runtime dependencies of this package, so they install with it.
The durable engine does not: add [`@smthrs/flows`](/api/flows), whose
`NodeRuntime.layerHost` takes a registry layer as an argument and settles a
registered flow on a SQLite-backed engine.

See [Run a discovered flow](./guides/run-a-discovered-flow.md) for the whole
composition.

## Next step

Scan a real directory and read what came back in the
[Quickstart](./quickstart.md).
