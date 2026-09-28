---
title: "Compose a database layer"
description: "Stack the driver, the write policy, and the migrations in the one order that works, and tune the connection and the retry bounds where you need to."
sidebar:
  order: 1
---

Three layers make a usable database, and the order between them is fixed: the
driver provides the client, the writer needs that client, and the migrations
need the client and must finish before any store reads a table.

## The stack

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as Migrations from "@smthrs/database/Migrations"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Layer from "effect/Layer"

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: "flows.sqlite" })
)

const migrated = Layer.provideMerge(Migrations.layer(sets), database)
```

`Layer.provideMerge` rather than `Layer.provide`: the result must keep both
`SqlClient` and `DurableWriter` in its output, because stores ask for both.

The client holds an open connection for the lifetime of a scope, so the program
that consumes this layer runs inside `Effect.scoped`. Closing the scope closes
the database.

## Supply the migration sets

Do not assemble the sets by hand unless you have a reason to.
[`@smthrs/engine-store`](/api/engine-store) exports `Migrations.sets`, the
journal, run store, step cache, engine store, and plan sets together, which is
the complete durable schema an engine needs.
[`@smthrs/time-travel`](/api/time-travel) exports its own `Migrations.sets`,
which is that list plus its own block.

```ts
import * as EngineMigrations from "@smthrs/engine-store/Migrations"

const migrated = Layer.provideMerge(Migrations.layer(EngineMigrations.sets), database)
```

Add your own set to the array when your package owns tables of its own. Each
set must declare a namespace and an id block no other set in the array claims;
see [Add a migration](./add-a-migration.md).

## Create the directory before you open the file

`NodeDatabase.layer` opens a file, it does not create a directory. Where the
path is user supplied, make the parent first, which is what the Node runtime
does:

```ts
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { dirname } from "node:path"

const databaseLayer = (filename: string) =>
  Layer.unwrap(
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      yield* fileSystem.makeDirectory(dirname(filename), { recursive: true })
      return Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
    })
  )
```

NodeDatabase and BunDatabase create new plain-path databases with mode `0o600`,
masked by the process umask. WAL and SHM sidecars inherit the main file's mode.
On Node, set `mode: 0o640` when group-readable state is required. Existing files keep their permissions;
`file:` URIs, temporary databases and read-only opens are left to SQLite.

The default `busyTimeout` is `0`: the open ladder and `DurableWriter` wait
between attempts through Effect, keeping the event loop available to peers.

## Tune the connection

`NodeDatabaseOptions.sqlite` forwards to `@effect/sql-sqlite-node`'s client
config, minus `filename`, which this layer owns. WAL stays enabled unless you
disable it explicitly.

```ts
import * as Duration from "effect/Duration"

NodeDatabase.layer({
  filename: "flows.sqlite",
  busyTimeout: Duration.millis(5)
})
```

`busyTimeout` overrides `sqlite.busyTimeout`; the nested setting remains
supported when the top-level setting is absent. A nonzero timeout blocks the
Node event loop during contention, including WAL conversion at open. Keep it
short and tune the cooperative retry bounds for longer waits. See
[SQLite and PostgreSQL](../concepts/sqlite-only.md).

## Tune the write retries

`DurableWriter.layer` takes the retry bounds. Pass only what you mean to
change:

```ts
DurableWriter.layer({ maxAttempts: 5, baseDelayMs: 25, maxDelayMs: 1_000 })
```

Raise `maxAttempts` for a workload with many short writers contending for one
file. Lower `maxDelayMs` when a caller has its own deadline and would rather
see a `busy` failure than wait out the default 10 second ceiling. Any value
that is not a safe integer of at least 1 clamps to 1, so a mis-tuned option
gives you a single attempt rather than an unbounded one.

## Report a refused open

`NodeDatabase.layer` raises `UnsupportedDatabase` as a defect, so a command
that wants to print a diagnosis catches the defect and narrows it:

```ts
program.pipe(
  Effect.provide(NodeDatabase.layer({ filename })),
  Effect.scoped,
  Effect.catchDefect((defect) =>
    NodeDatabase.isUnsupportedDatabase(defect)
      ? Effect.logError(`${defect.code}: ${defect.message}`)
      : Effect.die(defect)
  )
)
```

Narrow with `isUnsupportedDatabase` rather than by tag string, and re-raise
anything else unchanged.

## Announce the connection strings this release ignores

If your entry point reads the environment, say which names it is dropping. The
package supplies both halves and the caller chooses where they are printed:

```ts
import * as UnsupportedBackend from "@smthrs/database/UnsupportedBackend"

const notices = UnsupportedBackend.ignoredNames(process.env).map(UnsupportedBackend.ignoredNotice)
```

Print them. Do not change the exit code: this is a notice, not a refusal.

## Select the native runtime at the boundary

On Bun, provide `BunDatabase.layer` from `@smthrs/database/bun/BunDatabase`
in place of the Node driver. Both expose the same Effect SqlClient and use the
same schema guard and bounded startup retries. The `DurableWriter` and migration
layers above them remain identical. Flow and product services receive those
services through Effect; they do not construct a second database for their state.
