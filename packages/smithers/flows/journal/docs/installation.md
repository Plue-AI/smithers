---
title: "Installation"
description: "Install @smthrs/journal, choose a database layer, install the migration sets a journal needs, and learn which extra table the fenced write path reads."
sidebar:
  order: 1
---

## Install the package

Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

The package requires Node.js 26.4.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. Its only runtime dependencies are
[`effect`](https://effect.website) and [`@smthrs/database`](/api/database).
Composing a journal layer imports from both of them by name, so install them as
direct dependencies rather than relying on them being hoisted.

`effect` is a peer dependency pinned at `4.0.0-rc.115`. Install exactly that
version: two copies of `effect` in one program are two sets of service tags, so
a journal layer built against one copy cannot be provided to a program holding
the other, and the mismatch shows up as a missing service rather than as a
version error.

## Add a database

`SqlJournal.layer` needs two services from `@smthrs/database`: a
`SqlClient.SqlClient` to read through and a `DurableWriter` to write through.
On Node, `NodeDatabase.layer` provides the client and `DurableWriter.layer()`
provides the writer. This composition selects the optional Node SQLite driver:

```bash
pnpm add @effect/sql-sqlite-node@4.0.0-rc.115
```

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Layer from "effect/Layer"

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: "flows.db" })
)
```

SQLite is the supported backend at `1.0.0-rc.0`. PostgreSQL and PGlite are
not; see [storage compatibility](/docs/migration/compatibility#storage).

## Install the migrations

`Migrations.layer` creates this package's two tables and nothing else:
`flows_journal_events` with its event-type index, and
`flows_journal_checkpoints`.

```ts
import { Migrations, SqlJournal } from "@smthrs/journal"
import * as Layer from "effect/Layer"

const journal = SqlJournal.layer({ capacity: 1024, overflow: "reject" }).pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, database))
)
```

An application that also needs run, cache, or engine tables composes migration
sets rather than stacking layers. `Migrations.set` is the journal's namespaced
set, and `@smthrs/database`'s `Migrations.layer` runs several sets over one
`flows_migrations` table, giving each package a reserved id block so two
packages' `0001_initial` cannot collide:

```ts
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as RunStoreMigrations from "@smthrs/run-store/Migrations"

const migrations = DatabaseMigrations.layer([
  JournalMigrations.set,
  RunStoreMigrations.set
])
```

`@smthrs/engine-store/Migrations` already exports `sets`, the whole durable
schema a durable engine needs, in dependency order. Take that list if you are
composing an engine rather than a standalone journal.

## What a fenced write needs

`emitDurable`, `checkpoint`, and `compact` gate their write on a `flows_runs`
row that still names the supplied owner. That table belongs to
[`@smthrs/run-store`](/api/run-store), so a composition that installs only the
journal's migrations has no table for the fence to read, and all three fail
with `sink_failed` carrying `no such table: flows_runs`.

Install `@smthrs/run-store`'s migration set alongside the journal's whenever
you intend to write on the fenced channel. `emitLossy`, `emitDurableUnfenced`,
`entries`, `stream`, `project`, and `flush` read no table but the journal's
own, so a standalone journal serves them without run-store.

For why the fence exists and when the unfenced channel is the correct one, see
[the owner fence](./concepts/owner-fence.md).

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Journal, JournalEvent, Migrations, Redaction, SqlJournal } from "@smthrs/journal"
```

Each module is also importable from its own subpath, which is the form the API
reference uses:

```ts
import * as Journal from "@smthrs/journal/Journal"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
```

The root is written against the driver-neutral `@smthrs/database` contract and
bundles for the browser. Neither test double is exported from the root, so both
are imported by subpath. `TestJournal` binds a Node SQLite database and runs on
Node only; `Notifying` wraps a service and is platform independent:

```ts
import * as Notifying from "@smthrs/journal/test/Notifying"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
```

Three subpath forms are not public and are blocked in the export map:
`@smthrs/journal/internal/*`, `@smthrs/journal/migrations/*`, and
`@smthrs/journal/*/index`. `@smthrs/journal/package.json` is exported.

## Next step

Write and read one run in the [Quickstart](./quickstart.md).
