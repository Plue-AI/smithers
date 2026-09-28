---
title: "Compose a durable step cache"
description: "Wire the SQL step cache over a real database: the driver, the write boundary, the migrations that must run first, and where the composition belongs in a durable engine."
sidebar:
  order: 1
---

`CacheStore.layer` requires two services and one precondition: Effect's
`SqlClient`, the `DurableWriter` write boundary from
[`@smthrs/database`](/api/database), and the two tables already created. This
guide composes all three.

## Build the database pair

`NodeDatabase.layer` provides the SQL client and nothing else.
`DurableWriter.layer` adds the write policy above it, and it accepts any Effect
`SqlClient`, so the retry classification is the same whichever driver you
compose:

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Layer from "effect/Layer"

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: "flows.sqlite" })
)
```

## Run the migrations beneath the store

`Migrations.layer` creates `flows_step_cache` and
`flows_step_cache_recorded`. Compose it under the store so the tables exist
before the service is exposed:

```ts
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Migrations from "@smthrs/step-cache/Migrations"

const cache = CacheStore.layer.pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, database))
)
```

`Layer.provideMerge` keeps the database services in the output of the inner
layer so `CacheStore.layer` can reach them; `Layer.provide` hides them again
above the store, leaving `Layer<CacheStore.CacheStore>`. Use `Layer.provideMerge`
for the outer composition too if the rest of your program also needs the SQL
client.

The migration set reserves id block `2000`, so it composes with the journal's
and the run store's without collision.

## Use the store

```ts
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const store = yield* CacheStore.CacheStore
  return yield* store.get("compile-server-v1")
})

Effect.runPromise(Effect.provide(program, cache).pipe(Effect.scoped, Effect.orDie))
```

The database layer is scoped, so the program is run under `Effect.scoped`.

## Prefer the engine's composition

A host that runs flows rarely builds this by hand.
[`@smthrs/engine-store`](/api/engine-store) already composes the step cache
with the journal and the run store. The database loader runs migrations
sorted by migration id regardless of the order the sets are supplied in.
Its single high-water mark does not prevent appending to an installed lower
block, but introducing a new lower block after a higher block is already installed
is refused. Reach for this guide when you need the store on its own, for a tool
that inspects or prunes a cache file, or when you are composing a shared tier
under a custom engine.

## Where to go next

- [Share results across machines](./share-results-across-machines.md): put a
  shared HTTP tier behind this local one.
- [Test against the step cache](./test-with-the-cache.md): the same store over
  an in-memory database.
- [The head and the ledger](../concepts/head-and-ledger.md): what the two
  tables you just created are for.
