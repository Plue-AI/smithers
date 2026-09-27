---
title: "@smthrs/database"
description: "One transaction boundary for SQL writes in an Effect application: bounded replay of lock conflicts, five stable failure codes, an affected-row count that works on any driver, and a migration ladder several packages can share."
---

`@smthrs/database` gives an Effect application one place to write to SQL. Every
write goes through `DurableWriter.write`, which runs it inside a transaction,
replays it when the database reports a transient lock conflict, and normalizes
whatever comes back into five stable failure codes. Beside the writer,
`Migrations` composes the migration sets of several independent packages into
one ordered pass over one database.

The package adds policy to writes only. Reads stay on Effect's own `SqlClient`
service, unwrapped, so nothing here sits between a query and the driver.

## Why you would reach for it

Reach for it when several independent modules share one SQL database and the
transaction policy, the retry decision, and the failure vocabulary should be
settled once rather than in each of them. Four problems come with that shape,
and each one is quiet rather than loud:

- **A retry that replays the wrong things.** A lock conflict or a serialization
  failure clears if you try again, and a constraint violation never does, so a
  blanket `Effect.retry` either burns a budget on an answer or gives up on a
  fault. `write` replays the whole transaction body against committed state on
  a bounded exponential backoff, and refuses to replay a constraint violation,
  because that is the first writer winning.
- **A failure vocabulary per driver.** Branching on `SQLITE_BUSY` in one place
  and on SQLSTATE `40001` in another leaves half the branches dead on the other
  backend. `DatabaseError` carries `busy`, `constraint`, `io`, `unsupported`,
  or `unknown`, and the same classifier decides both the code you are told and
  whether the write replayed, so the two cannot disagree about one error.
- **An affected-row count that reads `undefined`.** SQLite drivers report
  `changes` and node-postgres reports `rowCount`. A compare-and-swap that casts
  the raw result to one shape reports a successful delete as a no-op on the
  other. `affectedRows` reads both names and fails loudly when it can read
  neither.
- **Migration numbers that collide.** Two packages that both ship an
  `0001_initial` either fight over id 1 or silently shadow each other, and the
  pass still reports success. A `MigrationSet` names a package and reserves a
  block of 1000 ids, so the composed ladder is ordered and every applied
  migration is recorded under its own name.

`DurableWriter.make` accepts an Effect `SqlClient` with serialized write
transactions. Node/Bun SQLite and PostgreSQL adapters share the same stores
and migration ladder. See [SQLite and PostgreSQL](./concepts/sqlite-only.md).

## Install

`@smthrs/database` is not published to npm yet. Its source is on
[GitHub](https://github.com/smithersai/smithers).

It needs Node.js 26.4.0 or later for the built-in `node:sqlite` module, and
`effect` and `@effect/sql-sqlite-node` at the exact version it is built
against: two copies of `effect` in one tree split the `SqlClient` service
identity, and a writer built against one cannot see a client provided from the
other. For those versions, the import subpaths, and the packages a real
composition adds, see [Installation](./installation.md).

## Write something through the boundary

This program creates a table, writes one row through the durable boundary, and
reads it back. Run it twice and the migration does not run again:

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as Migrations from "@smthrs/database/Migrations"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const notes: Migrations.MigrationSet = {
  namespace: "notes",
  idOffset: 0,
  migrations: {
    "0001_initial": Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)`
    })
  }
}

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: "notes.sqlite" })
)

const program = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter.DurableWriter
  yield* writer.write(sql`INSERT INTO notes (id, body) VALUES ('first', 'hello')`)
  return yield* sql<{ readonly body: string }>`SELECT body FROM notes`
})

Effect.runPromise(
  program.pipe(
    Effect.provide(Layer.provideMerge(Migrations.layer([notes]), database)),
    Effect.scoped
  )
).then(console.log)
```

```text
[ { body: 'hello' } ]
```

Three layers stack in a fixed order: the driver provides the client, the writer
adds transaction policy over that client, and the migration layer finishes
before any code reads a table. `Effect.scoped` is required, because the client
holds an open connection for the lifetime of a scope.

## Where this sits

`@smthrs/database` is one package of the Smithers durable flow engine.
[`@smthrs/flows`](/api/flows) is that engine's barrel: it re-exports every
engine package as a namespace, this one included, so
`import { Database } from "@smthrs/flows"` reaches exactly the code
`import * as Database from "@smthrs/database"` reaches. Depend on this package
when the write boundary is all you want, and on the barrel when you want the
whole engine in one dependency.

The stores that keep run state sit above this package and each contributes a
migration set: [`@smthrs/journal`](/api/journal),
[`@smthrs/run-store`](/api/run-store), [`@smthrs/step-cache`](/api/step-cache),
and [`@smthrs/engine-store`](/api/engine-store), whose `Migrations.sets` is the
whole durable schema an engine needs. Above all of them,
[`@smthrs/cli`](/api/cli) is the `smithers` command that runs the engine as a
tool you type, and it opens its run database through the same three layers the
example uses.

## Next steps

- [Quickstart](./quickstart.md): the same program built one piece at a time,
  down to what the migration ledger holds afterwards.
- [Compose a database layer](./guides/compose-a-database.md): the wiring a real
  engine uses, plus connection and retry tuning.
- [The write boundary](./concepts/write-boundary.md): the serialization
  guarantee consumers depend on, savepoint nesting, and what replays.
- [The migration ladder](./concepts/migration-ladder.md): namespaces, id
  blocks, and the skip the loader refuses to perform.
- [API reference](./api.md): every public export.
- [Troubleshooting](./troubleshooting.md): the messages this package produces
  and what to change.
