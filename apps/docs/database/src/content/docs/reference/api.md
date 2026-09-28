---
title: "API reference"
description: "Every public export of @smthrs/database: the DurableWriter service and its layers, the DatabaseError vocabulary, the Migrations composer, the Node SQLite driver, the in-memory test layer, and the metric handle."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/database/docs/api.md"
---

The root entry point is driver neutral and bundles for browsers. Each driver is
platform specific and lives at an explicit subpath.

| Import                                | Exports                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `@smthrs/database`                    | `DurableWriter`, `Migrations`, `DatabaseMetrics`, `UnsupportedBackend` as namespaces |
| `@smthrs/database/DurableWriter`      | the write boundary, its errors, and its layers                                       |
| `@smthrs/database/Migrations`         | the migration composer                                                               |
| `@smthrs/database/DatabaseMetrics`    | the write-retry counter                                                              |
| `@smthrs/database/UnsupportedBackend` | the ignored connection-string names                                                  |
| `@smthrs/database/node/NodeDatabase`  | Node only. The `node:sqlite` client layer                                            |
| `@smthrs/database/test/TestDatabase`  | Node only. The in-memory client and writer                                           |

`@smthrs/database/internal/*` is blocked by the export map.

## Example

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const insertNote = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter.DurableWriter
  yield* writer.write(sql`INSERT INTO notes (id, body) VALUES ('first', 'hello')`)
})
```

## DurableWriter

The write boundary shared by the durable stores, free of journal or host
knowledge. Queries go through Effect's `SqlClient` directly; only writes come
here.

### DurableWriter

```ts
class DurableWriter extends Context.Service<DurableWriter, Service>()("@smthrs/database/DurableWriter") {}
```

The service tag. `yield* DurableWriter.DurableWriter` resolves the writer.

### Service

```ts
interface Service {
  readonly write: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, Exclude<E, SqlError.SqlError> | DatabaseError, R>
}
```

`write` runs `effect` inside one transaction with transaction-scoped retries,
and widens the error channel with `DatabaseError`. Every `SqlError` in a failed
cause is normalized to a `DatabaseError` on the way out.

Two guarantees are contract rather than implementation detail:

- **Serialization.** Two concurrent `write` transactions are mutually
  serialized. They may not both commit results computed from snapshots that
  exclude each other's writes.
- **Acquisition.** Outermost writes sharing one writer queue for its permit
  before entering SQL, at the caller's own interruptibility. An interruptible
  caller cancelled or timed out while queued acquires nothing; a caller that
  masked interruption keeps waiting, so a finalizer's cleanup write still
  commits.
- **Nesting.** A `write` inside the client's open transaction joins it as a
  savepoint and does not retry. Only the outermost `write` retries, replaying
  the whole transaction body verbatim against committed state. Its
  classification follows `cause` chains, so a nested store's domain error that
  preserves `cause` still keeps the outermost transaction replaying.

See [the write boundary](/concepts/write-boundary/).

### afterCommit

```ts
const afterCommit: (update: Effect.Effect<void>, client?: SqlClient.SqlClient) => Effect.Effect<boolean>
```

Registers a short, non-failing process-local update inside a managed `write`.
The outermost successful commit runs it once, outside SQL retries. Failed
attempts and rolled-back savepoints discard their registrations. The update
runs uninterruptibly; it must not block or perform external deliveries.

`client` scopes the registration to that client's managed write. A store passes
its captured client, `DurableWriter.afterCommit(publish, sql)`, so an update
that belongs to one database cannot ride the commit of a nested write to
another one: the call answers `false` when the open scope belongs to a
different client. Omitting `client` accepts whichever managed write is open.

Returns `false` without running the update when the current transaction is not
owned by the writer, including raw SQL transactions/savepoints. Skip optional
cache publication in that case; never publish uncommitted data as a fallback.
See [commit ownership](/concepts/write-boundary/#process-local-state-follows-the-outer-commit).

### make

```ts
const make: (sql: SqlClient.SqlClient, options?: WriteRetryOptions | undefined) => Service
```

Builds the writer around an existing SQL client. Accepts any Effect
`SqlClient`, which is why the retry classification is dialect blind.

### layer

```ts
const layer: (options?: WriteRetryOptions | undefined) => Layer.Layer<DurableWriter, never, SqlClient.SqlClient>
```

Provides the writer over the context's SQL client. Compose it above a driver
layer with `Layer.provideMerge` so both services stay in the output.

### makeNoop

```ts
const makeNoop: () => Service
```

A writer stub whose every write fails with `DatabaseError` code `unsupported`.

### layerNoop

```ts
const layerNoop: Layer.Layer<DurableWriter>
```

Provides the unsupported writer stub.

### WriteRetryOptions

```ts
interface WriteRetryOptions {
  readonly maxAttempts?: number | undefined
  readonly baseDelayMs?: number | undefined
  readonly maxDelayMs?: number | undefined
}
```

| Field         | Default | Meaning                                                |
| ------------- | ------- | ------------------------------------------------------ |
| `maxAttempts` | `10`    | Total attempts, including the initial write.           |
| `baseDelayMs` | `50`    | Initial exponential backoff delay, in milliseconds.    |
| `maxDelayMs`  | `10000` | Upper bound for a single retry delay, in milliseconds. |

Jitter is applied before the cap, so `maxDelayMs` bounds the delay that is
actually slept. Any value that is not a safe integer of at least 1 clamps to 1.
Delays use Effect's `Clock`, so `TestClock` drives them.

### DatabaseErrorCode

```ts
const DatabaseErrorCode: Schema.Literals<["busy", "constraint", "io", "unsupported", "unknown"]>
type DatabaseErrorCode = typeof DatabaseErrorCode.Type
```

The stable failure categories this package exposes.

### DatabaseError

```ts
class DatabaseError extends Schema.TaggedError<DatabaseError>()("@smthrs/database/DatabaseError", {
  code: DatabaseErrorCode,
  cause: Schema.optional(Schema.Defect())
}) {}
```

A normalized database failure, suitable for consumers outside a driver. Narrow
it with `Schema.is(DatabaseError)` or catch it by its tag
`@smthrs/database/DatabaseError`.

| Code          | Meaning                                                                                |
| ------------- | -------------------------------------------------------------------------------------- |
| `busy`        | A transient lock or serialization conflict. The only category that is replayed.        |
| `constraint`  | A constraint or unique violation. Never replayed: it is the first-writer-wins signal.  |
| `io`          | An I/O failure. Normalized but never replayed, even when a busy cause sits beneath it. |
| `unsupported` | The noop writer, or a raw result with no readable affected-row count.                  |
| `unknown`     | A SQL failure in none of the above categories.                                         |

### fromSqlError

```ts
const fromSqlError: (error: SqlError.SqlError) => DatabaseError
```

Converts an Effect SQL error into the stable vocabulary. The category comes
from the same classifier the retry decision reads, so the code a caller is told
and the decision to replay cannot disagree about one error.

Classification, in precedence order: a lock timeout is `busy`; a constraint or
unique violation is `constraint`; an I/O cause is `io`; a busy cause is `busy`;
anything else is `unknown`.

The busy vocabulary is `SQLITE_BUSY*`, `SQLITE_LOCKED*`, SQLSTATE `40001`,
`40P01`, `55P03`, and the texts `database is locked`, `database is busy`,
`could not serialize access`, `deadlock detected`, and
`cannot rollback - no transaction is active`. The I/O vocabulary is
`SQLITE_IOERR*` and the text `disk i/o error`.

### affectedRows

```ts
const affectedRows: (raw: unknown) => Effect.Effect<number, DatabaseError>
```

Reads how many rows a write statement affected from a driver's raw result,
which `SqlClient` exposes as `.raw`. Reads an own `changes` property (SQLite
drivers) or an own `rowCount` property (node-postgres).

A count is accepted as a non-negative safe integer, or as an exact `bigint` in
that range, which is what `node:sqlite` returns when `SqlClient.SafeIntegers`
is enabled. Only an own data property counts, so an inherited field is ignored
and an accessor is never executed.

Fails with code `unsupported` when neither field is readable. The failure's
`cause` carries the shape of the result and never its values: its type, up to
eight key names, and its length if it was an array.

See [Read a write's affected-row count](/guides/count-affected-rows/).

## Migrations

Composes per-package SQL migration sets over one migrations table.

### table

```ts
const table: "flows_migrations"
```

The single table every Smithers package records its applied migrations in. Its
presence is also what tells the Node driver that a file is a Smithers 1.0
database.

### idBlock

```ts
const idBlock: 1000
```

The spacing between the migration id blocks packages reserve with
`MigrationSet.idOffset`. A package may ship this many migrations before it
would reach its neighbour.

### MigrationSet

```ts
interface MigrationSet {
  readonly namespace: string
  readonly idOffset: number
  readonly migrations: Readonly<Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>>
}
```

One package's migrations, namespaced so they cannot collide with another
package's.

| Field        | Meaning                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `namespace`  | Prefixes every migration name in the ledger. Unique among the sets composed together.                                                             |
| `idOffset`   | A non-negative safe integer multiple of `idBlock`, unique among the sets composed together. Lifts the set's local ids into the block it reserves. |
| `migrations` | Keyed `<localId>_<name>`, with the local id in `0..idBlock - 1`.                                                                                  |

### loader

```ts
const loader: (sets: ReadonlyArray<MigrationSet>) => Migrator.Loader<SqlClient.SqlClient>
```

Builds a `Migrator` loader from namespaced sets, resolved into one list ordered
by global migration id rather than by the order the sets were given.

The set list and each migration record are snapshotted when this function is
called, so later caller mutation cannot change a loader already returned.

It fails the migration, as a `Migrator.MigrationError` of kind `BadState`,
rather than returning a list the migrator would quietly mishandle:

| Rejected                             | Message                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Duplicate namespace                  | `Duplicate migration namespace: <namespace>`                                                                   |
| Duplicate offset                     | `Duplicate migration id offset <offset> for namespace <namespace>`                                             |
| Negative or fractional offset        | `... an id offset must be a non-negative integer`                                                              |
| Unsafe integer offset                | `... an id offset must be a safe integer in the range 0..<max>`                                                |
| Misaligned offset                    | `... an id offset must be a multiple of idBlock (1000)`                                                        |
| Malformed key                        | `Malformed migration key "<key>" in namespace <namespace>`                                                     |
| Local id at or above `idBlock`       | `Local migration id <id> ... is outside the block range 0..999 and would claim a neighbouring package's block` |
| Two keys realizing one id            | `Migration id <id> is claimed twice: <owner> and <claimant>`                                                   |
| A historical hole or new lower block | `Migration <id>_<name> would be skipped: the database has already applied migration id <highWater> ...`        |
| A recorded id/name mismatch          | `Migration <id> was recorded as <name>, but this package declares <otherName>`                                 |
| An unreadable ledger id              | `flows_migrations contains an invalid migration_id: <value>`                                                   |

On a fresh database the loader applies global id zero itself, inside the
migrator's transaction, because the migrator's high-water mark starts at zero
and would silently skip it. A caller wiring the loader into its own `Migrator`
therefore gets id zero applied. The loader also applies forward additions to
an installed package block below the global high-water mark. Each such block
must include a declaration matching an already recorded id and name. Earlier
holes, changed recorded names, and newly introduced lower blocks are refused.
All applications share the migrator transaction. The upstream migrator's
completed list omits loader-applied entries; use `run` to receive the complete
list.

### run

```ts
const run: (sets: ReadonlyArray<MigrationSet>) => Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError,
  SqlClient.SqlClient
>
```

Runs every migration in the given sets that has not been applied yet, and
answers the `[id, name]` pairs it applied on this pass, including id zero and installed lower-block appends. A
pass with nothing to do answers an empty array.

The whole migrator pass, the `BEGIN IMMEDIATE`, the loader, and the pending
migrations, retries on the same transient-lock vocabulary the durable writer
uses, so two connections migrating one SQLite file serialize instead of failing
on the peer's write lock.

A failing migration takes the whole pass with it: the partial DDL and the
ledger rows roll back, and it surfaces as a `Failed` `MigrationError` on the
defect channel.

### layer

```ts
const layer: (sets: ReadonlyArray<MigrationSet>) => Layer.Layer<
  never,
  Migrator.MigrationError | SqlError,
  SqlClient.SqlClient
>
```

Runs the given migration sets before exposing the database to durable services.

See [the migration ladder](/concepts/migration-ladder/) and
[Add a migration](/guides/add-a-migration/).

## DatabaseMetrics

Metric definitions for the durable write boundary. This module defines handles
only. No exporter ships here: provide one, for example from
[`@smthrs/observability`](https://observability.smithers.sh/reference/api/), and the counter appears in it.

### writeRetries

```ts
const writeRetries: Metric.Counter<number>
```

Counter `flows_db_write_retries`, described as "Durable write transaction
replays after transient conflicts". Incremented once per scheduled retry of a
recognized transient conflict, across every store that writes through the
boundary. The attempt that finally fails past the retry budget is not counted:
it surfaces on the error channel instead.

## UnsupportedBackend

Notices for unsupported legacy configuration names. This string-only module
is browser safe.

### ignoredNames

```ts
const ignoredNames: (environment: Readonly<Record<string, string | undefined>>) => ReadonlyArray<string>
```

Production ignores `SMITHERS_TEST_PG_URL` and legacy `SMITHERS_POSTGRES_*`
knobs other than `SMITHERS_POSTGRES_URL` and `SMITHERS_POSTGRES_SCHEMA`. Sorted, so an operator reading two runs
compares two identical lists. An exported-but-blank name counts as unset.

The separator is part of the prefix, so `SMITHERS_POSTGRESQL_URL`, a name
neither release reads, is not announced.

### ignoredNotice

```ts
const ignoredNotice: (name: string) => string
```

The one line an ignored name gets:

```text
ignored: SMITHERS_TEST_PG_URL has no effect in 1.0.0-rc.0 (use SMITHERS_POSTGRES_URL to select PostgreSQL)
```

It is a notice, not a refusal: it changes no exit code and no result.

## NodeDatabase

Node only. `import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"`.

Defaults to `node:sqlite` through `@effect/sql-sqlite-node`; a configured
PostgreSQL URL selects `PostgresDatabase` instead. The write policy lives in `DurableWriter.layer`, composed on top.

### layer

```ts
const layer: (options: NodeDatabaseOptions) => Layer.Layer<SqlClient.SqlClient>
```

Provides the SQL client. WAL is enabled by the underlying client by default.

The error channel is `never` by design, so every durable package composes it
unchanged. A refused open is raised as a defect carrying `UnsupportedDatabase`,
and a lock during construction is retried on a fixed ladder of 40 attempts with
a 5 ms base delay capped at 250 ms. That ladder is not configurable: it bounds a
driver-internal race during layer construction, before any service exists to
configure.

### NodeDatabaseOptions

```ts
interface NodeDatabaseOptions {
  readonly filename: string
  readonly mode?: number | undefined
  readonly busyTimeout?: Duration.Input | undefined
  readonly sqlite?: Omit<SqliteClient.SqliteClientConfig, "filename"> | undefined
}
```

| Field         | Meaning                                                                                                                                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filename`    | The SQLite database filename. A `file:` URI is accepted, and `:memory:` opens a private in-memory database. The parent directory is not created.                                                                                              |
| `mode`        | Creation permissions for a new plain-path database, masked by the process umask. Defaults to `0o600`; WAL and SHM sidecars inherit the main file's mode. Existing files, `file:` URIs, temporary databases and read-only opens are unchanged. |
| `busyTimeout` | Synchronous SQLite lock wait. Defaults to `0` so open and durable-write retries wait cooperatively. Overrides `sqlite.busyTimeout` when supplied.                                                                                             |
| `sqlite`      | Additional driver configuration. WAL remains enabled unless explicitly disabled. An explicit `sqlite.busyTimeout` is honored when `busyTimeout` is absent.                                                                                    |

### UnsupportedDatabaseCode

```ts
const UnsupportedDatabaseCode: Schema.Literals<[
  "unsupported_runtime",
  "unsupported_database_file",
  "database_locked"
]>
type UnsupportedDatabaseCode = typeof UnsupportedDatabaseCode.Type
```

### UnsupportedDatabase

```ts
class UnsupportedDatabase extends Schema.TaggedError<UnsupportedDatabase>()(
  "@smthrs/database/UnsupportedDatabase",
  { code: UnsupportedDatabaseCode, message: Schema.String }
) {}
```

A refusal to open a durable database in 1.0.0-rc.0, raised as a defect rather
than a typed failure because neither refusal is recoverable at run time.

| Code                        | Refused when                                                    | Message                                                                                  |
| --------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `unsupported_runtime`       | `process.versions.bun` is set                                   | `Use @smthrs/database/bun/BunDatabase under Bun; NodeDatabase requires Node.js >=26.4.0` |
| `unsupported_database_file` | the file has at least one table and no `flows_migrations` table | `<path> is not a Smithers 1.0 database (1.0.0-rc.0 does not load a 0.x smithers.db)`     |
| `database_locked`           | a peer held the file for the whole open ladder                  | `<path> could not be inspected because another process holds it`                         |

### isUnsupportedDatabase

```ts
const isUnsupportedDatabase: (input: unknown) => input is UnsupportedDatabase
```

Narrows an unknown defect to this driver's refusal. Use it in
`Effect.catchDefect` and re-raise anything else unchanged.

## BunDatabase

Bun only. `import * as BunDatabase from "@smthrs/database/bun/BunDatabase"`.

`layer(options: BunDatabaseOptions): Layer.Layer<SqlClient.SqlClient>` provides
a `bun:sqlite` client with the same schema guard, bounded open retries and
failed-commit recovery as NodeDatabase. As on Node, `.raw` on a write without
result columns returns `{ changes, lastInsertRowid }`, so `affectedRows` reads
its count; the upstream `@effect/sql-sqlite-bun` client returns `[]` there.
Options contain `filename` and optional
`sqlite` settings from that Bun driver. A new plain-path database is created
with mode `0o600`, masked by the process umask, and its WAL and SHM sidecars
inherit that mode. Existing files, `file:` URIs, temporary databases and opens
whose settings disable creation are left to SQLite. Install its matching optional peer;
consumers using only Node do not need it. Both subpaths re-export the same
`UnsupportedDatabase` constructor and refinement.

## TestDatabase

Node only. `import * as TestDatabase from "@smthrs/database/test/TestDatabase"`.

### layer

```ts
const layer: Layer.Layer<DurableWriter.DurableWriter | SqlClient.SqlClient>
```

Provides the production Node SQLite client and the production durable writer
over a fresh in-memory database. `:memory:` is private to a connection, so both
halves share one connection and serialization comes from the client's
in-process transaction mutex rather than from the database.

See [Test against a database](/guides/test-against-a-database/).

## PostgresDatabase

Import `@smthrs/database/postgres/PostgresDatabase` and provide
`layer({ url, schema?, postgres? })`. The optional `postgres` field passes
Effect PostgreSQL pool/connection options; Smithers owns the type registry.
The resulting layer provides `SqlClient`; compose `DurableWriter.layer()`
and the owning migration set as with SQLite. See
[configuration and isolation](/concepts/sqlite-only/).
