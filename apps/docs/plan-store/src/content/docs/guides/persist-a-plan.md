---
title: "Persist a plan"
description: "Compose PlanStore over SQLite, record generation 0 first-writer-wins, handle every RecordResult, and read the whole graph back."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/plan-store/docs/guides/persist-a-plan.md"
---

`PlanStore` keeps a compiled plan: nodes, edges, computed keys, effect
declarations, conflict annotations, and the digest an approval binds to. It
never interprets a plan. It records what `Plan.compile` produced and hands it
back.

## Compose the store

The store needs a `SqlClient` and a `DurableWriter` from
[`@smthrs/database`](https://database.smithers.sh/reference/api/), and it needs this package's three tables to
exist. `Migrations.layer` runs them before the store is exposed:

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Migrations from "@smthrs/plan-store/Migrations"
import * as PlanStore from "@smthrs/plan-store/PlanStore"
import * as Layer from "effect/Layer"

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: "smithers.db" })
)

export const planStore = Layer.provideMerge(
  PlanStore.layer,
  Layer.provideMerge(Migrations.layer, database)
)
```

A host that already composes the other storage packages should compose
`Migrations.set` with theirs instead, through
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)'s `Migrations.sets`, rather than
running this set on its own. [Append a generation](/guides/append-a-generation/)
covers why the ordering matters.

## Record generation 0

`record` is first-writer-wins:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import type * as Plan from "@smthrs/plan/Plan"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

/** The effect from "Compile drafts into a plan", before its Crypto layer is provided. */
declare const compiled: Effect.Effect<Plan.Plan, never, Crypto.Crypto>

export const record = Effect.gen(function*() {
  const plan = yield* compiled
  const store = yield* PlanStore.PlanStore
  const outcome = yield* store.record(plan, Date.now())
  if (outcome._tag === "Conflict") {
    return `a different plan is already stored under ${plan.planId}: ${outcome.digest}`
  }
  const reread = yield* store.get(plan.planId)
  return Option.isSome(reread) ? reread.value.digest : "missing"
}).pipe(Effect.provide(planStore), Effect.provide(NodeCrypto.layer))
```

Three outcomes, and each one means something different:

| `_tag`         | What happened                                                                        |
| -------------- | ------------------------------------------------------------------------------------ |
| `Recorded`     | The rows were written. This call is the first writer.                                |
| `ExistingSame` | The identical plan is already stored. Not an error; retry safely.                    |
| `Conflict`     | A different plan holds this id. `digest` is the one stored, and nothing was written. |

Handle `Conflict` rather than retrying it. The store refuses to overwrite
because the stored plan may already be approved, running, or both.

`createdAtMs` is the caller's clock. This package performs no I/O of its own, so
the timestamp comes in as an argument rather than from a clock service.

## What record requires of the plan

`record` accepts generation 0 only, and it checks three things before it writes:

- `plan.generation` is 0.
- `plan.baseDigest` equals `plan.digest`, which is what generation 0 means.
- Every node is at generation 0.

Anything else fails as `invalid_plan` with a message naming the offending value.
Pass the value `Plan.compile` returned and all three hold by construction.

## Read a plan back

`get` returns the whole plan, nodes in recorded order, or `Option.none()` when
the id is unknown:

```ts
export const read = Effect.gen(function*() {
  const store = yield* PlanStore.PlanStore
  const stored = yield* store.get("review-4821")
  return Option.map(stored, (plan) => plan.nodes.map((node) => node.id))
}).pipe(Effect.provide(planStore))
```

The nodes come back in the ordinal order they were inserted in: the
topological order of material dependencies within each generation. Inferred
reader-after-writer edges can point to later ordinals. Schedule nodes from the
complete `dependsOn` graph. `(plan_id, ordinal)` is unique in SQL, so recorded
order is stable across reads.

`get` builds each node's dependencies from its verified `node_json`.
`flows_plan_edges` is a derived index of those `dependsOn` lists for SQL
inspection; nothing verifies it and `get` never reads it, so an edge row
written by anything other than `record` or `append` cannot add or remove a
dependency. Read the graph through `get`, never from the edge table.

This clarification preserves existing ordinals, keys, and approval digests.
`append` retains the recorded prefix and adds new nodes in material-dependency
order; `verify` checks that same order without sorting inferred edges. Existing
plans require no migration. Reordering a stored node array changes its approval
payload and is not a compatible way to obtain an execution order.

## Append-only is enforced in SQL

Triggers raise on any UPDATE or DELETE of `flows_plan_nodes` and
`flows_plan_edges`, on any DELETE of a `flows_plans` row, and on any UPDATE of a
plan row that would change its id, flow, base digest, or creation time, or move
its generation backwards.

That is deliberate: convention would leave the guarantee to whoever writes the
next caller, and a plan an operator approved has to be the plan the run
executed. If you see `a plan only grows` from SQLite, a caller tried to rewrite
history.

## Failures

Every failure is a `PlanStoreError` whose `code` is one of `invalid_plan`,
`constraint`, `decode_failed`, or `persistence_failed`.
[Troubleshooting](/troubleshooting/) states what causes each and what to
change.

## Next

- [Append a generation](/guides/append-a-generation/): grow a recorded plan without
  rewriting it.
- [Diff two plans](https://plan.smithers.sh/guides/diff-two-plans/): report what a re-plan changed.
