---
title: "Installation"
description: "Depend on @smthrs/flows from a checkout, its Node and effect requirements, its three import forms, the platform packages the barrel leaves to the program that runs, and when to depend on individual engine packages instead."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/docs/installation.md"
---

## Get the package

`@smthrs/flows` is not published to npm at 1.0.0-rc.0, so `pnpm add
@smthrs/flows` does not resolve. Its source lives in the
[smithers repository](https://github.com/smithersai/smithers). Clone that
repository, install its dependencies, and declare the package where you need
it:

```json
{
  "dependencies": {
    "@smthrs/flows": "workspace:*"
  }
}
```

Depending on the barrel brings in the twenty engine packages it re-exports,
`effect`, and `esbuild`, which `SandboxedFlow` uses to bundle a guest entry
module. Node host and SQLite adapters are optional and are selected below.

## Requirements

- Node.js 26.4.0 or later with local SQLite, which is what `package.json`
  declares in `engines`. That is what durable execution needs, and it is also
  what runs a `.ts` file directly, with no build step.
- [`effect`](https://effect.website) 4.0.0-rc.115, as an exact peer dependency.
  This is an Effect library throughout: a flow's payload and result are Effect
  schemas, an action's implementation is an `Effect`, and a host is a `Layer`.
  Pin the same version in the consuming project, so the service tags and
  schemas this package exports are the same classes the project constructs.

The package ships as ESM and CommonJS with TypeScript declarations.

## Import forms

The root entry point is the barrel. Authoring names are flat and infrastructure
packages are namespaces:

```ts
import { Action, Engine, Flow, Interpreter, Journal, Kernel } from "@smthrs/flows"
```

Native compositions are explicit subpaths. The runtime core consumes injected services:

```ts
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as SandboxedFlow from "@smthrs/flows/SandboxedFlow"
```

Two subpath forms are blocked in the export map and are not public:
`@smthrs/flows/internal/*` and `@smthrs/flows/*/index`.
`@smthrs/flows/package.json` is exported.

## Choose a platform package yourself

The barrel re-exports no `@smthrs/platform-*` bundle, for the same reason
`effect`'s own index does not re-export `@effect/platform-node`: a platform is
chosen by the program that runs, not by the library it depends on. Re-exporting
all three would make one import resolve `node:child_process`, ZenFS, and Bun at
once.

There is one platform package per runtime:

- [`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/) supplies the Node host,
  containment, process reaping, and the liveness probe. It is an optional peer
  required by `NodeRuntime`, including `NodeRuntime.layerHost`.
- [`@smthrs/platform-bun`](https://platform-bun.smithers.sh/reference/api/) supplies the Bun host.
- [`@smthrs/platform-browser`](https://platform-browser.smithers.sh/reference/api/) supplies a browser host
  for authoring and inspection.

For `@smthrs/flows/NodeRuntime`, select `@smthrs/platform-node`, `@effect/platform-node`,
`@effect/platform-node-shared`, and `@effect/sql-sqlite-node`. Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

Compose a host yourself and you declare the platform package you compose
against, the same way you declared the barrel:

```json
{
  "dependencies": {
    "@smthrs/platform-node": "workspace:*"
  }
}
```

Test doubles are reached the same way, through their own packages:
`@smthrs/testing/TestHost`, `@smthrs/database/node/NodeDatabase`,
`@smthrs/journal/test/TestJournal`.

## Bundling for a browser is not durable execution

The root entry point bundles for a browser, and so does every package root it
re-exports. What bundles is the authoring and inspection surface: you can
declare flows, read a plan, and decode a journal event in a browser.

Durable execution is a different claim: it needs a native Node.js or Bun host and
SQLite or PostgreSQL. Node.js requires version 26.4.0 or later. A browser or edge runtime is not a supported durable host even
when you supply another SQL client. Native modules are subpaths
precisely so importing the root never opens `node:sqlite`.

## When to depend on individual packages instead

The barrel is a convenience, not a seam. A library published to other consumers
usually wants the narrower dependency: depend on
[`@smthrs/flow`](https://flow.smithers.sh/reference/api/) alone to declare flows and actions, or on
[`@smthrs/engine`](https://engine.smithers.sh/reference/api/) and
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) to execute them. Reach for
`@smthrs/flows` in the program that composes the whole engine, which is where
one dependency saves you twenty.

## Next step

Stand a durable runtime up and run a flow on it in the
[Quickstart](/quickstart/).

## Bun durable execution

Install `@smthrs/platform-bun@1.0.0-rc.0`, `@effect/platform-bun@4.0.0-rc.115`,
`@effect/platform-node-shared@4.0.0-rc.115` and
`@effect/sql-sqlite-bun@4.0.0-rc.115`, then import
`@smthrs/flows/BunRuntime`. Its `layerHost`, `layer`, `make` and `storage`
compositions share the engine with Node. See [runtime portability](/concepts/runtime-portability/).
