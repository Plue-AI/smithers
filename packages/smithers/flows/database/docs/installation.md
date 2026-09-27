---
title: "Installation"
description: "Install @smthrs/database, the runtime it requires, and the import subpaths for the driver-neutral root, the Node SQLite driver, and the in-memory test database."
sidebar:
  order: 1
---

## Availability

`@smthrs/database` is not published to npm yet. Its source is on
[GitHub](https://github.com/smithersai/smithers), and the storage packages
listed below are the worked examples of everything on this page.

See [Installation](/docs/installation/#use-the-libraries).

`effect` is a required exact peer. The SQLite adapter is an optional exact
peer, needed by `node/NodeDatabase` and `test/TestDatabase`, including the
verification example below. Install it when selecting either subpath:

```bash
pnpm add @effect/sql-sqlite-node@4.0.0-rc.115
```

The driver-neutral root needs no SQLite adapter. Mixing two copies
of `effect` splits the `SqlClient` service identity, and a writer built against
one copy cannot see a client provided from the other.

## Requirements

| Requirement | Value               | Why                                                                                                                   |
| ----------- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Node.js     | 26.4.0 or later     | `NodeDatabase` opens the database through the built-in `node:sqlite` module.                                          |
| Bun         | 1.4.0 or later      | Select `BunDatabase` and the matching `@effect/sql-sqlite-bun` peer. NodeDatabase deliberately refuses use under Bun. |
| Database    | SQLite / PostgreSQL | SQLite is the default; PostgreSQL uses the optional `@effect/sql-pg` adapter.                                         |

## Import subpaths

The root entry point is driver neutral and bundles for browsers. Every driver
is platform specific and lives at its own subpath, the way `effect` keeps its
platform packages out of its root.

```ts
// Driver neutral. Safe in a browser bundle.
import { DatabaseMetrics, DurableWriter, Migrations, UnsupportedBackend } from "@smthrs/database"

// Or one namespace at a time, which keeps the import graph narrow.
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as Migrations from "@smthrs/database/Migrations"

// Node only.
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
```

`@smthrs/database/internal/*` is blocked by the export map. Everything a
consumer needs is reachable from the paths above.

## What a real composition adds

This package provides a client and a write policy. It does not provide tables.
An application that stores run state also depends on the storage packages that
own them, and each one contributes its migration set:
[`@smthrs/journal`](/api/journal), [`@smthrs/run-store`](/api/run-store),
[`@smthrs/step-cache`](/api/step-cache), and
[`@smthrs/engine-store`](/api/engine-store).

`@smthrs/engine-store` exports `Migrations.sets`, the complete list a durable
engine needs, so most applications compose that rather than assembling the sets
by hand. For the wiring, see
[Compose a database layer](./guides/compose-a-database.md).

## Verify the install

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const check = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter.DurableWriter
  return yield* writer.write(sql`SELECT 1 AS value`)
})

Effect.runPromise(check.pipe(Effect.provide(TestDatabase.layer), Effect.scoped))
  .then(console.log)
```

`TestDatabase.layer` opens a fresh `:memory:` database with the production
client and the production writer, so a successful run proves both halves
resolved.
