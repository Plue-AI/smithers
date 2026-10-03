---
title: "Installation"
description: "Install @smthrs/engine-store, its runtime requirements and import forms, the storage packages a runnable composition adds, and the browser boundary."
sidebar:
  order: 1
---

## Install the package

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

The package requires Node.js 26.4.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. Its runtime dependencies, including
[`effect`](https://effect.website) and the `@smthrs/*` storage packages it
composes, install with it. Every surface on this site is an Effect service:
`layer` values you compose and `Effect` values you run.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { DurableEngineState, EngineStore, Migrations, StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
```

Each module is also importable from its own subpath, which is the form the API
reference uses:

```ts
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as Retention from "@smthrs/engine-store/Retention"
```

Three subpath forms are not public and are blocked in the export map:
`@smthrs/engine-store/internal/*`, `@smthrs/engine-store/migrations/*`, and
`@smthrs/engine-store/*/index`. `@smthrs/engine-store/package.json` is exported.

The deterministic store bundle for tests lives at
`@smthrs/engine-store/test/TestStores`. See
[Test against a durable store](./guides/testing.md).

## What a runnable composition adds

This package composes storage rather than providing it. A composition that
executes a flow supplies the four stores, a database, an artifact store, a
workspace root, and a platform.

| Package                                 | What it supplies                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [`@smthrs/journal`](/api/journal)       | `Journal`, the durable event log every engine decision is written to.                                                       |
| [`@smthrs/run-store`](/api/run-store)   | `RunStore` and `AttemptStore`, the run rows and attempt rows ownership is fenced on, plus the `Ownership` liveness helpers. |
| [`@smthrs/step-cache`](/api/step-cache) | `CacheStore`, the content-addressed step result cache.                                                                      |
| [`@smthrs/database`](/api/database)     | `SqlClient` and `DurableWriter`, and the `Migrations` runner the schema installs through.                                   |
| [`@smthrs/artifacts`](/api/artifacts)   | `ArtifactStore`, where outputs too large to inline are spilled by digest.                                                   |
| [`@smthrs/kernel`](/api/kernel)         | `Jj` for snapshot boundaries and `Workspace` for the workspace root.                                                        |
| [`@smthrs/plan`](/api/plan)             | `PlanStore`, required only when you drive plans with `PlanScheduler`.                                                       |

[`@smthrs/flows`](/api/flows) ships `NodeRuntime`, which wires all of the above
over one SQLite file. Reach for it when you want the composition rather than
control over it; reach for `EngineStore.layer` when you are building a host.

## Install the schema before anything reads it

`Migrations.sets` is the complete durable engine schema in dependency order
(journal, run store, step cache, this package's own tables, then the plan
store), and `Migrations.layer` installs it:

```ts
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Migrations } from "@smthrs/engine-store"
import * as Layer from "effect/Layer"

const database = (filename: string) =>
  Layer.provideMerge(
    Migrations.layer,
    Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
  )
```

Provide the stores over that layer, never beside it: a store built before the
migration runs reads a table that does not exist yet.

## The browser boundary

This entry point bundles for a browser. The two host reads it once made
directly, `process.pid` and `randomUUID` from `node:crypto`, enter through the
injectable `OwnerIdentity` service, and every package it composes is
browser-bundleable. A release that broke the bundle would fail the build before
it shipped.

Bundling is not running. The only durable backing shipped here is local SQLite
through Node.js `node:sqlite` and `@effect/sql-sqlite-node`. A browser or edge
deployment can import the types and the browser-safe in-memory helpers
(`DurableEngineState.layerMemory`, `WorkspaceSandbox.makeMemory`,
`StepSandbox.layerNoop`), but cannot execute durable flows. Supplying an
alternative browser SQL client is not a supported runtime.

## Next step

Compose the engine and run a flow twice over one file in the
[Quickstart](./quickstart.md).
