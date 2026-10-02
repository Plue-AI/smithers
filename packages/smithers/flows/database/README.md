# @smthrs/database

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://database.smithers.sh

One transaction boundary for SQL writes in an Effect application. Every write
goes through `DurableWriter.write`, which runs it inside a transaction, replays
it when the database reports a transient lock conflict, and normalizes whatever
comes back into five stable failure codes. Beside the writer, `Migrations`
composes the migration sets of several independent packages into one ordered
pass over one database.

The package adds policy to writes only. Reads stay on Effect's own `SqlClient`
service, unwrapped, so nothing here sits between a query and the driver.

## Install

`@smthrs/database` is not published to npm yet. Its source is on
[GitHub](https://github.com/smithersai/smithers).

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/).

`effect` is a required exact peer. The optional exact peer
`@effect/sql-sqlite-node` is required by `node/NodeDatabase` and
`test/TestDatabase`, including the example below:

```sh
pnpm add @effect/sql-sqlite-node@4.0.0-rc.115
```

PostgreSQL configuration requires the optional `@effect/sql-pg@4.0.0-rc.115`
peer. The driver-neutral root installs no SQL adapter. Two
copies of `effect` in one tree split the `SqlClient` service identity and a
writer built against one copy cannot see a client provided from the other. The
Node driver needs Node.js 26.4.0 or later for its built-in `node:sqlite`
module.

## Write something through the boundary

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: "flows.sqlite" })
)

const program = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter.DurableWriter
  return yield* writer.write(sql`SELECT 1 AS value`)
})

Effect.runPromise(program.pipe(Effect.provide(database), Effect.scoped)).then(console.log)
```

Two layers stack in a fixed order: the driver provides the client, and the
writer adds transaction policy over that client. `Layer.provideMerge` rather
than `Layer.provide`, so both services stay in the output. Add
`Migrations.layer(sets)` on top when your tables come from migration sets.

## Entry points

The root is driver neutral and bundles for browsers. Each driver is platform
specific and lives at its own subpath.

| Import                                       | Exports                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `@smthrs/database`                           | `DurableWriter`, `Migrations`, `DatabaseMetrics`, `UnsupportedBackend` as namespaces |
| `@smthrs/database/DurableWriter`             | the write boundary, its errors, and its layers                                       |
| `@smthrs/database/Migrations`                | the migration composer                                                               |
| `@smthrs/database/DatabaseMetrics`           | the write-retry counter                                                              |
| `@smthrs/database/UnsupportedBackend`        | the connection-string names this release ignores                                     |
| `@smthrs/database/node/NodeDatabase`         | Node only. The `node:sqlite` client layer                                            |
| `@smthrs/database/postgres/PostgresDatabase` | PostgreSQL client with schema-scoped write serialization                             |
| `@smthrs/database/test/TestDatabase`         | Node only. The in-memory client and writer                                           |

`DurableWriter.make` accepts any Effect `SqlClient`, so the retry
classification and the error vocabulary are dialect blind. SQLite and PostgreSQL adapters share the stores and migration ladder. See
[configuration and isolation](docs/concepts/sqlite-only.md).

## What the boundary buys you

- **A retry that replays only what replaying can fix.** A lock or
  serialization conflict is replayed on a bounded exponential backoff; a
  constraint violation never is, because that is the first writer winning.
- **One failure vocabulary.** `DatabaseError` carries `busy`, `constraint`,
  `io`, `unsupported`, or `unknown`, and the same classifier decides both the
  code you are told and whether the write replayed.
- **An affected-row count that reads on any driver.** SQLite reports `changes`
  and node-postgres reports `rowCount`; `affectedRows` reads both and fails
  loudly when it can read neither.
- **Migration ids that cannot collide.** A `MigrationSet` names a package and
  reserves a block of 1000 ids, so a composed ladder stays ordered and every
  applied migration is recorded under its own name.

## Documentation

Full documentation is at [database.smithers.sh](https://database.smithers.sh):

- [Quickstart](https://database.smithers.sh/quickstart/): the same program
  built one piece at a time, down to what the migration ledger holds.
- [The write boundary](https://database.smithers.sh/concepts/write-boundary/):
  the serialization guarantee consumers depend on, savepoint nesting, and what
  replays.
- [The migration ladder](https://database.smithers.sh/concepts/migration-ladder/):
  namespaces, id blocks, and the skip the loader refuses to perform.
- [API reference](https://database.smithers.sh/reference/api/): every public
  export.
- [Troubleshooting](https://database.smithers.sh/troubleshooting/): the
  messages this package produces and what to change.

## License

MIT

## Runtime portability is a required contract

The engine and product flows are platform-independent Effect programs. Node and Bun
provide different SQL and host layers to the same runtime, migrations, journal,
stores, cache, and recovery logic. A Node subprocess is not a Bun compatibility
mechanism. Keep filesystem, process, crypto, HTTP and SQL access behind their
existing Effect services, selected at the executable's composition root.

`@smthrs/flows/Runtime` consumes an injected Effect `SqlClient` and host services.
`@smthrs/flows/NodeRuntime` and `@smthrs/flows/BunRuntime` select matching native
services. Database adapters are `@smthrs/database/node/NodeDatabase` and
`@smthrs/database/bun/BunDatabase`; both share the schema guard, startup retry
policy and `DurableWriter`. Domain code must not open an extra database or create
its own command, job, event, or locking ledger around the durable engine.

Runtime parity must be demonstrated by the same execute, persist, restart, resume
and cancellation scenarios, including opening a Node-created database in Bun and
vice versa. A browser-safe import alone does not prove durable browser execution.
