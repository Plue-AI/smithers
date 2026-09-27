---
title: "Troubleshooting"
description: "The messages @smthrs/database produces, what causes each one, and what to change: refused opens, migration rejections, write failures, and the composition mistakes that look like driver bugs."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/database/docs/troubleshooting.md"
---

Every message below comes from this package's own source. Match on the text,
then read the cause.

## Refused opens

These arrive as defects from `NodeDatabase.layer`, carrying
`UnsupportedDatabase`. Narrow them with `isUnsupportedDatabase`.

### `1.0.0-rc.0 runs the durable engine on Node.js >=26.4.0 only`

**Code:** `unsupported_runtime`.

**Cause:** `process.versions.bun` is set. The check runs before the file is
touched, so nothing about your database path is implicated.

**Fix:** run the durable engine on Node.js 26.4.0 or later. There is no flag.

### `<path> is not a Smithers 1.0 database (1.0.0-rc.0 does not load a 0.x smithers.db)`

**Code:** `unsupported_database_file`.

**Cause:** the file has at least one table and no `flows_migrations` table,
which is what a 0.x `smithers.db` looks like. Opening it would add `flows_*`
tables beside its `_smithers_*` ones and mix two schemas.

**Fix:** point the runtime at a new path. rc.0 does not load 0.x run state, and
there is no in-place conversion in this release.

**If the file is not a 0.x database:** check what it actually contains with
`sqlite3 <path> ".tables"`. A file with tables from some other application
looks exactly the same to the guard.

### `<path> could not be inspected because another process holds it`

**Code:** `database_locked`.

**Cause:** a peer held the file for the whole open ladder, roughly 40 attempts
with delays capped at 250 ms, plus whatever `busyTimeout` each contended
attempt spent inside SQLite. The guard never learned whether the file was a 0.x
database, and refuses rather than waving it through.

**Fix:** find the holder and stop it. A stale `smithers.db-shm` or `-wal`
beside the file is a hint that a process exited without closing. If two of your
own processes legitimately share the file, they will normally serialize inside
the ladder: a refusal means the lock outlived it.

## Migration rejections

These arrive as `Migrator.MigrationError` of kind `BadState` from `loader`,
`run`, and `layer`.

### `Migration <id>_<name> would be skipped: the database has already applied migration id <highWater>`

```text
Migration 1_alpha_initial would be skipped: the database has already applied migration id 1001, and this is not a forward append in a declared, installed package block. Compose each installed package's recorded migrations when appending to its block; introduce new packages above 1001.
```

**Cause:** the pending migration is a historical hole in an installed block
or belongs to a new block below the global cursor.

**Fix:** distinguish the package's block cursor from the global cursor:

- An installed package may append an id greater than every applied id in its
  own block, even below the global cursor. Retain its recorded migration
  identities in the declaration.
- Missing matching history is an ownership rejection, described below.
  Restore the installed package's recorded declarations before appending.
- A historical hole cannot be filled behind the block's applied cursor.
  Put new migration work after that cursor; preserve recorded identities.
- A genuinely new package needs an unused block above every installed block.
  On a fresh database, compose every package's set from its first migration.

Inspect `SELECT migration_id, name FROM flows_migrations ORDER BY migration_id;`
to identify the installed blocks and their cursors. See the
[forward-append rule](/guides/add-a-migration/#3-append-within-the-packages-existing-block).

### `Migration <id>_<name> cannot append to installed block <offset> without declaring a matching recorded migration`

**Cause:** the composition has pending work in an installed block but declares
none of that block's recorded migration identities. The check applies above
and below the global cursor, including when the namespace is unchanged.

**Fix:** restore the owning package's recorded declarations, with the same ids
and names, alongside its append. A foreign namespace must reserve a new block.
Changing a recorded name instead fails with
`Migration <id> was recorded as <recordedName>, but this package declares <declaredName>`.

### `Duplicate migration namespace: <namespace>`

**Cause:** two sets in one array declare the same namespace, usually because a
package's set was added twice through two different composition helpers.

**Fix:** compose each package's set once. Prefer an exported `sets` array over
assembling the list by hand.

### `Duplicate migration id offset <offset> for namespace <namespace>`

**Cause:** two sets composed together reserve the same block.

**Fix:** give the newer set the next free multiple of `idBlock`. Offsets need
to be unique only among the sets composed into one database.

### `Invalid migration id offset <offset> for namespace <namespace>`

**Cause:** the offset is negative, fractional, outside the safe integer range,
or not a multiple of `idBlock` (1000). The message says which.

**Fix:** use `Migrations.idBlock * n`.

### `Malformed migration key "<key>" in namespace <namespace>`

**Cause:** a key that is not `<digits>_<name>`. A key of only digits, or one
beginning with a letter, fails here.

**Fix:** rename the key. `0002_add_tag`, not `add_tag` and not `0002`.

### `Local migration id <id> for key "<key>" ... is outside the block range 0..999`

**Cause:** a local id at or above `idBlock`, which would claim the neighbouring
package's block.

**Fix:** keep local ids in `0..999`. A package that needs more than 1000
migrations needs a second reserved block, not a larger local id.

### `Migration id <id> is claimed twice: <owner> and <claimant>`

**Cause:** two keys in one set parse to the same number, for example
`0001_first` beside `01_second`. Zero padding differs, the realized id does
not.

**Fix:** renumber one of them. Both claimants are named in the message.

### `flows_migrations contains an invalid migration_id: <value>`

**Cause:** the ledger holds a `migration_id` that is not a non-negative safe
integer, most often a bigint written outside the range while
`SqlClient.SafeIntegers` was enabled.

**Fix:** inspect the ledger. A row written by something other than this package
is the usual explanation.

### `Could not read flows_migrations`

**Cause:** `loader` was called against a database that was never migrated, so
the table does not exist. The loader normally runs inside the migrator's
transaction, after the table has been ensured.

**Fix:** use `Migrations.run` or `Migrations.layer`. If you are wiring a
`Migrator` by hand, ensure the table first.

### `Migration "0_<name>" failed`

**Cause:** the global id-zero migration failed. It is applied by the loader
itself, so it surfaces as a `Failed` `MigrationError` on the defect channel
rather than as a typed failure.

**Fix:** read the cause. The whole pass rolled back, so the database is
unchanged and the corrected migration reapplies from the start.

## Write failures

### A write fails with `busy` instead of succeeding

**Cause:** the retry budget was exhausted. The default is 10 attempts with
delays growing from 50 ms to a 10 second ceiling.

**Fix:** raise `maxAttempts`, or find the writer holding the lock. A long
`busyTimeout` compounds this: each contended attempt waits inside SQLite before
the ladder's own delay.

### A transient failure is not retried at all

**Cause:** one of three things, in order of likelihood.

1. Your domain error dropped `cause`. The classifier walks `cause` chains to
   find an Effect `SqlError`, and a failure with no such link is never
   replayed.
2. The write is nested inside another `write`. A nested write is a savepoint
   and never retries, by design: only the outermost transaction replays.
3. The failure is classified `io`. An I/O failure is never replayed, even when
   a busy cause sits beneath it, because the write reached the disk.

**Fix:** preserve `cause` when you map an error, and let a nested failure
propagate to the outermost `write`.

### An application error is retried unexpectedly

It is not. A failure must carry an Effect `SqlError` in its cause chain to
qualify, on the defect channel as much as the typed one. If you are seeing
replays, the effect inside `write` is genuinely failing with a database error.
An `Effect.die` whose message merely quotes lock text is never replayed.

### `unsupported` from a write that should have worked

**Cause:** either the composition provided `DurableWriter.layerNoop`, or
`affectedRows` could not read a count from the raw result.

**Fix:** check which layer is in the composition. If it is `affectedRows`, read
the failure's `cause`: it carries the result's type and up to eight key names,
which usually names the driver that returned an unexpected shape. See
[Read a write's affected-row count](/guides/count-affected-rows/).

## Composition mistakes

### A store cannot find `SqlClient` or `DurableWriter`

**Cause:** `Layer.provide` was used where `Layer.provideMerge` was needed.
`provide` consumes the client and keeps it out of the output.

**Fix:** `Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))`.

### The connection closes immediately, or the program exits before the write lands

**Cause:** the client layer is scoped, and the scope closed.

**Fix:** wrap the program in `Effect.scoped`, or run it inside a longer-lived
scope. Closing the scope closes the database.

### Two copies of `effect` in the tree

**Cause:** the writer and the client resolved different copies of `effect`, so
the `SqlClient` service identities do not match and the writer cannot see the
client.

**Fix:** deduplicate `effect` to one version. This looks like a missing service
rather than a version error.

### Tables are missing after a successful migration

**Cause:** in almost every case this is the high-water mark skip described
earlier, on a database migrated with a partial set list at some point in its
history. The loader now refuses that pass rather than performing it.

**Fix:** compare `SELECT migration_id, name FROM flows_migrations ORDER BY migration_id`
against the sets you compose. A gap where a block should be is the answer.

### The database directory does not exist

**Cause:** `NodeDatabase.layer` opens a file, it does not create a directory.

**Fix:** create the parent first. See
[Compose a database layer](/guides/compose-a-database/).

## Backend and environment

### PostgreSQL configuration

`SMITHERS_POSTGRES_URL` selects PostgreSQL for native filename opens unless
`SMITHERS_BACKEND=sqlite` is set. `DATABASE_URL` counts only with
`SMITHERS_BACKEND=postgres`. An explicit PostgreSQL URL selects it directly.
Install the optional `@effect/sql-pg` peer at the version pinned by this package.

Migrate the full composed set before starting stores. Independently racing
package ladders can install a higher block before a lower package exists; the
migration validator correctly refuses that gap. See
[SQLite and PostgreSQL](/concepts/sqlite-only/).
