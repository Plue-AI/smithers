---
title: "Installation"
description: "What @smthrs/scorers needs at run time, which import forms it supports, which subpaths are blocked, and what a persistent composition adds."
sidebar:
  order: 1
---

## Install

Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

[`@smthrs/evals`](/api/evals) is the worked example of the complete pipeline.

## Requirements

- Node.js 26.4.0 or later.
- [`effect`](https://effect.website) 4.0.0-rc.115, the version this package is
  built against. Execution, validation, and persistence use `Effect`; schemas
  use `effect/Schema`. Declaration and pure grading helpers are synchronous;
  [`Scorer.make` throws on invalid declarations](./troubleshooting.md#scorermake-threw-instead-of-failing).
- [`@smthrs/core`](/api/core) for `Flow` and `Digest`. A scorer is a flow
  declaration, and the canonical JSON that derives a `scorerKey` comes from
  `Digest`.
- [`@smthrs/database`](/api/database) for the durable store. Only
  `SqlScoreStore` needs it: a composition that binds `ScoreStore.layerNoop`
  never touches a database.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Binding, Runner, RunnerLive, Sampling, Scorer, ScoreStore, SqlScoreStore } from "@smthrs/scorers"
```

Each module named in the export map is also importable from its own subpath,
which is the form [`@smthrs/evals`](/api/evals) uses:

```ts
import * as Sampling from "@smthrs/scorers/Sampling"
import * as Scorer from "@smthrs/scorers/Scorer"
```

Three subpath families are blocked in the export map:
`@smthrs/scorers/internal/*`,
`@smthrs/scorers/migrations/*`, and `@smthrs/scorers/*/index`. The migration
steps are implementation detail, and the map lists no `Migrations` subpath, so
the aggregator is reachable only as the root `Migrations` namespace. Importing
a blocked or unlisted subpath fails with Node's
`ERR_PACKAGE_PATH_NOT_EXPORTED`, under `import` and `require` alike.
`@smthrs/scorers/package.json` is exported.

## What a persistent composition adds

`SqlScoreStore.layer` needs a SQL client and a durable writer, both from
[`@smthrs/database`](/api/database). In production that is the Node SQLite
driver over a file. Add the database package and its optional Node driver.

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { SqlScoreStore } from "@smthrs/scorers"
import { Layer } from "effect"

const store = SqlScoreStore.layer.pipe(
  Layer.provide(DurableWriter.layer()),
  Layer.provide(NodeDatabase.layer({ filename: "smithers.db" }))
)
```

`NodeDatabase.layer` runs the durable engine on Node.js only: under Bun it
refuses to open with `unsupported_runtime`. For a test or a walkthrough,
`TestDatabase.layer` composes the same driver and writer over a fresh
`:memory:` database in one layer, and the [Quickstart](./quickstart.md) uses
it.

Building the store bootstraps the shared `flows_migrations` ledger through
`@smthrs/database/Migrations` and applies this package's four migrations in
`flows_scorers_migrations`. The shared ledger lets `NodeDatabase.layer` reopen
this standalone file after the store closes; no engine tables or separate
migration step are required. `Migrations.layer` performs the same bootstrap
and migrations without building a store.

## Workspace artifacts

Workspace imports resolve to `src`. Run `pnpm run build` in this package to
regenerate ESM, CommonJS, declarations, and source maps under `dist`.

Repository release packing uses `scripts/pack-release.mjs`. Before staging each
package, it deletes `dist` and runs that package's build script. A failed or
missing build script stops packing even when all export targets already exist.
The release workflow also rebuilds clean artifacts before entering this gate.
Run local packing after source changes have landed; earlier ignored artifacts
are replaced, and a later source edit requires another build before direct
consumption of `dist`.

## Next step

Score two executions, persist them, and read the aggregate back in the
[Quickstart](./quickstart.md).
