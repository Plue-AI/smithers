---
title: "@smthrs/plan-store"
description: "Record a compiled plan in an append-only SQL store, grow it a generation at a time, and read it back verified, with rewriting refused by a trigger rather than by convention."
---

`@smthrs/plan-store` is where a [`@smthrs/plan`](/api/plan) plan is kept. It
records a compiled graph in SQLite, appends later generations under a
compare-and-swap, and returns a verified plan on read. It runs nothing itself.

## What it solves

A plan is recorded before it runs, and the question a recorded plan has to
answer later is whether what executed is what somebody approved. Two digests
carry that: `digest`, which moves as the plan elaborates, and `baseDigest`,
which still names the shape a reviewer signed off on.

Convention cannot keep that honest, because the store is a database a dozen
processes can reach. This package keeps it in SQL: rewriting a recorded node,
deleting a plan, or moving a generation backwards is refused by a trigger, so
growth is the only way a recorded plan can change. Admission and reads rebuild
every key and digest, so a row edited outside this package reads as
`decode_failed` rather than as a plan.

It is a separate package from the plan value so that compiling, diffing, and
building node graphs do not install a database. `@smthrs/plan` performs no I/O
at all; this package adds the SQL, and names no driver, so both bundle for the
browser and the platform choice stays the caller's.

## Install

`@smthrs/plan-store` is at `1.0.0-rc.0` and has not reached npm yet. When it
does, the release candidate publishes under the `next` dist tag:

```bash
pnpm add @smthrs/plan-store@next
```

The store writes through a durable writer over a SQL client, and verifying asks
Effect for its `Crypto` service:

```bash
pnpm add @smthrs/database@next @effect/platform-node@4.0.0-rc.115 @effect/platform-node-shared@4.0.0-rc.115 @effect/sql-sqlite-node@4.0.0-rc.115
```

[Installation](./installation.md) covers the import forms, the blocked
migration paths, and browser support.

## Record a plan

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Migrations from "@smthrs/plan-store/Migrations"
import * as PlanStore from "@smthrs/plan-store/PlanStore"
import * as Plan from "@smthrs/plan/Plan"
import { compile, draft } from "@smthrs/plan/test/PlanFixtures"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"

const layer = PlanStore.layer.pipe(
  Layer.provideMerge(Migrations.layer.pipe(Layer.provideMerge(TestDatabase.layer))),
  Layer.provideMerge(NodeCrypto.layer)
)

const program = Effect.gen(function*() {
  const store = yield* PlanStore.PlanStore
  const plan = yield* compile([draft("read-pr", { writes: ["pr.json"] })])

  console.log((yield* store.record(plan, Date.now()))._tag)
  console.log((yield* store.record(plan, Date.now()))._tag)

  const grown = yield* Plan.append(plan, [draft("run-tests", { reads: ["pr.json"] })])
  yield* store.append(grown)

  const stored = Option.getOrThrow(yield* store.get(plan.planId))
  console.log(stored.generation, stored.baseDigest === plan.digest)
})

await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.orDie))
```

```text
Recorded
ExistingSame
1 true
```

`ExistingSame` is answered only after the stored plan verifies, so a corrupt row
can never pass as an identical re-record. The last line is `baseDigest` still
naming the approved shape while `digest` has moved on.

## What is in the package

| Module       | Role                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `PlanStore`  | `record`, `append`, `get`, their outcomes, and the five error codes. |
| `Migrations` | The namespaced migration set that creates the three plan tables.     |

The [API reference](./api.md) documents every export.

## Where this sits

`@smthrs/plan-store` owns plan persistence and nothing else.
[`@smthrs/plan`](/api/plan) compiles the value it stores, and
[`@smthrs/engine-store`](/api/engine-store)'s `PlanScheduler` is what drives a
stored plan. [`@smthrs/flows`](/api/flows) is the whole engine as a single
dependency and composes this package's migration set with the other stores'.

## Next

- [Quickstart](./quickstart.md): record a plan, append a generation, and read
  the keyed graph back.
- [Persist a plan](./guides/persist-a-plan.md): the store composition and every
  outcome `record` can answer with.
- [Append a generation](./guides/append-a-generation.md): what an elaboration
  may add, and what the compare-and-swap refuses.
- [Testing](./testing.md): the in-memory database layer and the two-connection
  durability shape.
- [Troubleshooting](./troubleshooting.md): every refusal this package raises and
  what to change.
