---
title: "Installation"
description: "Install @smthrs/run-store, the SQL driver and durable writer it needs, its import forms, and the subpaths that are deliberately not public."
sidebar:
  order: 1
---

## Install the package

Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

The package requires Node.js 26.4.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. Its dependencies install with it:
[`@smthrs/database`](/api/database) for the durable write contract,
[`@smthrs/journal`](/api/journal) for the `OwnerId` fencing token, and
[`@smthrs/observability`](/api/observability) for the shared throughput metric.

[`effect`](https://effect.website) is a peer dependency pinned at
`4.0.0-rc.115`, so install exactly that version. Two copies of `effect` in one
program are two sets of service tags, and a store layer built against one copy
cannot be provided to a program holding the other: the mismatch surfaces as a
missing service rather than as a version error.

Installed is not the same as importable. A package manager that isolates
transitive dependencies puts only `@smthrs/run-store` on your resolution path,
so install any of those packages you import by name as a direct dependency too.
`OwnerId` is the one you would otherwise reach for first: import it from
`@smthrs/run-store/Ownership`, which re-exports the journal's token, rather
than from `@smthrs/journal`.

[`@smthrs/flows`](/api/flows) is not a dependency of this package at all. The
snippets on these pages that type a `NodeRuntime.Options` value need it
installed alongside.

## What a working composition adds

The stores are written against the driver-neutral `@smthrs/database` contract,
so they carry no database of their own. A composition supplies two services:

- `SqlClient.SqlClient` from `effect/unstable/sql/SqlClient`, which the SQL
  driver provides. `@smthrs/database/node/NodeDatabase` opens a `node:sqlite`
  database.
- `DurableWriter` from `@smthrs/database`, which serializes and retries the
  write transactions the stores run inside.

The SQLite and PostgreSQL adapters share this package's migrations and
statements. Both must satisfy the `DurableWriter` serialization contract.
Use `PostgresDatabase` for schema-scoped advisory locking; a bare PostgreSQL
READ COMMITTED client does not serialize writers.

Using `NodeDatabase` or the in-memory `TestRunStore` helper selects the optional
Node SQLite driver:

```bash
pnpm add @effect/sql-sqlite-node@4.0.0-rc.115
```

Both `RunStore.layer` and `AttemptStore.layer` require exactly those two, and
`Migrations.layer` requires the `SqlClient` alone. The layer order that
satisfies them is in [Compose the stores into a host](./guides/compose-the-stores.md).

Most hosts do not wire this by hand. [`@smthrs/engine-store`](/api/engine-store)
composes these stores with the journal, the step cache, and the durable engine
state into one storage ladder, and `@smthrs/flows/NodeRuntime` builds that
ladder over a single SQLite file.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { AttemptStore, Migrations, Ownership, RunStore, RunStoreMetrics } from "@smthrs/run-store"
```

Each module is also importable from its own subpath, which is the form the API
reference uses:

```ts
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
```

Both forms reach the same modules. The root is driver-neutral and bundles for
the browser: nothing under it imports a `node:` built-in.

## The two subpaths that are not namespaces of the root

| Import                                | Platform | What it holds                                                                                                                  |
| ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `@smthrs/run-store/Heartbeat`         | any      | The four lease durations: `heartbeatInterval`, `heartbeatStaleAfter`, `heartbeatSkewAllowance`, and `heartbeatWriteTolerance`. |
| `@smthrs/run-store/test/TestRunStore` | Node     | `layer`, which provides migrated in-memory `RunStore` and `AttemptStore` services.                                             |

`Ownership` re-exports all four durations, so the `Heartbeat` leaf exists for a
consumer that wants the numbers and no store at all:

```ts
import * as Heartbeat from "@smthrs/run-store/Heartbeat"
import * as TestRunStore from "@smthrs/run-store/test/TestRunStore"
```

`@smthrs/run-store/package.json` is exported. Three subpath families are
blocked in the export map and are not public API: `internal/*`, `migrations/*`,
and nested `*/index`. The migration implementations are blocked because the set
is the contract; import `Migrations.set` rather than a numbered file.

## Next step

Run a full lifecycle against an in-memory database in the
[Quickstart](./quickstart.md).
