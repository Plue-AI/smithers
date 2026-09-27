---
title: "Compose the stores into a host"
description: "Wire RunStore and AttemptStore over a SQL driver: the layer order that satisfies migrations, the attempt-store policy options, the stubs, and where the composed storage ladder already exists."
sidebar:
  order: 1
---

Both stores require a `SqlClient` and a `DurableWriter`, and both require their
tables to exist. This guide builds that composition from the bottom up.

## Check whether you need to build it

If you are running the Smithers engine, the composition already exists and
building a second one over the same database is a way to get two engines
fighting over one set of rows. [`@smthrs/engine-store`](/api/engine-store)
composes these stores with the journal, the step cache, and the durable engine
state, and `@smthrs/flows/NodeRuntime` builds that ladder over one SQLite file.
Reach for the layers here when you are writing a host, an adapter, or a sweeper
that has to agree with the engine about ownership.

## The layer order

Migrations must finish before either store is exposed, and both stores need the
writer and the client:

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { AttemptStore, Migrations, RunStore } from "@smthrs/run-store"
import * as Layer from "effect/Layer"

export const storage = (filename: string) =>
  Layer.mergeAll(RunStore.layer, AttemptStore.layer).pipe(
    Layer.provideMerge(Migrations.layer),
    Layer.provideMerge(DurableWriter.layer()),
    Layer.provideMerge(NodeDatabase.layer({ filename }))
  )
```

`Layer.provideMerge` is what keeps the database and the writer in the output
context, so the rest of the host can reach them too.

The SQLite and PostgreSQL adapters share this package's migrations and
statements. The composition must satisfy the `DurableWriter` serialization
contract: concurrent write transactions cannot both commit from snapshots
that exclude each other's writes. Use `NodeDatabase`, `BunDatabase`, or
`PostgresDatabase` from `@smthrs/database`; a bare PostgreSQL READ COMMITTED
client does not provide the required serialization.

Store writes nested inside `DurableWriter.write` join it as savepoints. A
transient database conflict retries the entire outer transaction. Persistence
errors retain a payload-free `DatabaseError` in their cause chain so redaction
does not remove that retry classification. SQL text and bound values are not
included.

## Compose the migration set, do not run it twice

`Migrations.layer` installs this package's tables and nothing else. A host that
also runs the journal, the step cache, or the engine state should compose the
migration sets instead, so one migrator applies them in one pass:

```ts
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import { Migrations } from "@smthrs/run-store"

const runAll = DatabaseMigrations.run([Migrations.set /* , the other packages' sets */])
```

`Migrations.set` reserves id block 1000, so its ids can never collide with
another package's. `@smthrs/engine-store` already composes the full set list.

## Choose the attempt-store policy

`AttemptStore.layer` takes the defaults: only `running` counts as in progress,
checkpoints cap at 1 MiB, and `put` is first-writer-wins. `layerWith` takes a
policy instead:

```ts
import { AttemptStore } from "@smthrs/run-store"

const attempts = AttemptStore.layerWith({
  inProgressStates: ["running", "retrying"],
  maxCheckpointBytes: 4 * 1024 * 1024,
  putMode: "upsert"
})
```

- `inProgressStates` names the states that mean "this attempt is still moving".
  `heartbeat` and `finish` fence on membership, and `finish` refuses them as
  targets. The names must be unique, non-empty durable text.
- `maxCheckpointBytes` must be between 1 and `AttemptStore.maximumCheckpointBytes`.
- `putMode: "upsert"` lets a re-`put` overwrite an attempt that is still in
  progress and report `Upserted`. A terminal attempt stays immutable in both
  modes.

All three are validated, detached, and frozen when the store is built, so an
invalid policy fails at composition time with `AttemptStoreError`.

## Stubs for compositions that must not persist

Both services ship an explicit absence, so a composition that cannot reach a
database still type-checks and still says so out loud:

| Layer                      | Behavior                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunStore.layerNoop()`     | `create` and `get` fail with `persistence_failed`. Every compare-and-swap reports its "you lost" outcome: `NotFound`, or `ClaimLost` for `activate` and `abandonClaim`. |
| `AttemptStore.layerNoop()` | Every operation fails with the `unknown` code.                                                                                                                          |

Both take partial overrides, which is how a test replaces one operation without
building a whole store:

```ts
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"

const alwaysFenced = RunStore.layerNoop({
  heartbeat: () => Effect.succeed({ _tag: "FenceLost" })
})
```

## Verify the composition

Read a run back through the layer you built. If migrations did not run, `get`
fails with `persistence_failed` rather than returning nothing:

```ts
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"

const check = Effect.gen(function*() {
  const runs = yield* RunStore.RunStore
  yield* runs.create("composition-check", "{}")
  return yield* runs.get("composition-check")
})
```

## Next steps

- [Claim a run and finish it](./claim-and-finish-a-run.md): what to do with the
  composed services.
- [Test against the real stores](./testing.md): the in-memory layer that skips
  all of this.
