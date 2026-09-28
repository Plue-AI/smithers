---
title: "API reference"
description: "Every public export of @smthrs/plan-store: the append-only plan store and the namespaced migration set that owns its three tables."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/plan-store/docs/api.md"
---

`@smthrs/plan-store` exports two modules from its root entry point, and each is
also importable from `@smthrs/plan-store/<Module>`:

```ts
import { Migrations, PlanStore } from "@smthrs/plan-store"
// or
import * as PlanStore from "@smthrs/plan-store/PlanStore"
```

`@smthrs/plan-store/internal/*` and `@smthrs/plan-store/*/index` are not public.
`@smthrs/plan-store/package.json` is exported.

| Namespace    | What it is                                                                       |
| ------------ | -------------------------------------------------------------------------------- |
| `PlanStore`  | Append-only SQL persistence, enforced by triggers rather than by convention.     |
| `Migrations` | The namespaced migration set that owns the three plan tables in id block `4000`. |

The shortest composition that records a compiled plan:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Migrations from "@smthrs/plan-store/Migrations"
import * as PlanStore from "@smthrs/plan-store/PlanStore"
import * as Plan from "@smthrs/plan/Plan"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const layer = PlanStore.layer.pipe(
  Layer.provideMerge(Migrations.layer.pipe(Layer.provideMerge(TestDatabase.layer))),
  Layer.provideMerge(NodeCrypto.layer)
)

const program = Effect.gen(function*() {
  const plan = yield* Plan.compile({
    planId: "review-4821",
    flow: "example/Review",
    nodes: [
      {
        id: "read-pr",
        material: {
          version: "flows/key-material/v2",
          kind: "sealed",
          body: { action: "read-pr", pr: 4821 },
          inputs: [],
          layers: [],
          capabilities: ["net:get"]
        },
        effects: { reads: [], writes: ["pr.json"], boundaryMode: "hard" }
      }
    ]
  })

  const store = yield* PlanStore.PlanStore
  return yield* store.record(plan, Date.now())
}).pipe(Effect.provide(layer))
```

Recording needs `PlanStore.layer` over a `DurableWriter`, a `SqlClient`, and
Effect's `Crypto` service. The package depends on
[`@smthrs/plan`](https://plan.smithers.sh/reference/api/), [`@smthrs/database`](https://database.smithers.sh/reference/api/) and
[`@smthrs/keys`](https://keys.smithers.sh/reference/api/), names no database driver, and is browser-safe.
Compiling a plan without persisting one needs none of those services.

## Entry point

| Import               | Source                                                                                                           | Platform         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| `@smthrs/plan-store` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan-store/src/index.ts) | Node and browser |

## PlanStore

[src/PlanStore.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan-store/src/PlanStore.ts)

`record` is first-writer-wins: an identical re-record is not an error, and a different plan under the same id is a `Conflict` carrying the stored digest rather than a silent overwrite. It accepts generation 0 only, whose `baseDigest` equals its `digest` and every one of whose nodes is at generation 0. `get` returns the verified immutable plan with nodes in recorded order. Admission and reads recompute keys, approval digests, topology, effect ordering and generation relationships. A forged incoming plan fails with `invalid_plan` before writes; corrupt stored content fails with `decode_failed`, including on duplicate admission. Envelope and nodes are read in one SQL statement to avoid mixed generations during concurrent appends. Dependencies come from each verified node's `dependsOn`; `flows_plan_edges` is a derived, unverified index that `get` never reads, so a forged edge row cannot change the returned graph.

`append` advances the plan row with a compare-and-swap on the previous generation, the flow, the approved base digest, and the approval digest of the append's already-verified prefix, and it refuses an append that adds no nodes. Matching the prefix digest proves the recorded prefix is the caller's without re-reading the stored rows. The refusal matters because of the append-only triggers: without it the node rows would land while the plan-row update matched nothing or skipped a generation, leaving rows whose dependencies are missing and that nothing is allowed to delete. The whole append is one transaction, so the refusal takes the rows back with it. New ordinals continue the recorded prefix, whose length the matched digest proves equal to the caller's prefix.

Every failure is a `PlanStoreError` whose `code` is one of `invalid_plan`, `constraint`, `decode_failed`, or `persistence_failed`.

### PlanStore.Service

```ts
interface Service {
  /** Records generation 0 of a plan. */
  readonly record: (plan: Plan.Plan, createdAtMs: number) => Effect.Effect<RecordResult, PlanStoreError>
  /** Appends the newest generation's nodes and edges and advances the digest. */
  readonly append: (plan: Plan.Plan) => Effect.Effect<void, PlanStoreError>
  /** Reads the whole plan back, nodes in recorded order. */
  readonly get: (planId: string) => Effect.Effect<Option.Option<Plan.Plan>, PlanStoreError>
}
```

`createdAtMs` comes from the caller's clock. Constructing the store requires `Crypto.Crypto` alongside SQL and the durable writer; individual operations use that captured implementation.

### PlanStore.RecordResult

```ts
type RecordResult =
  | { readonly _tag: "Recorded" }
  | { readonly _tag: "ExistingSame" }
  | { readonly _tag: "Conflict"; readonly digest: string }
```

`Conflict.digest` is the digest already stored under that plan id. Nothing was written.

### PlanStore.PlanStore

```ts
class PlanStore extends Context.Service<PlanStore, Service>()("@smthrs/plan-store/PlanStore") {}
```

The service tag.

### PlanStore.make

```ts
const make: Effect.Effect<Service, never, DurableWriter | SqlClient.SqlClient | Crypto.Crypto>
```

Builds the SQL-backed store.

### PlanStore.layer

```ts
const layer: Layer.Layer<PlanStore, never, DurableWriter | SqlClient.SqlClient | Crypto.Crypto>
```

Provides `make`.

### PlanStore.PlanStoreError

```ts
class PlanStoreError extends Schema.TaggedError<PlanStoreError>()("@smthrs/plan-store/PlanStoreError", {
  code: typeof PlanStoreErrorCode
  message: Schema.String
  cause: Schema.optional<Schema.Unknown>
})
```

| `code`               | Meaning                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `invalid_plan`       | the plan does not satisfy what the operation requires, or a node is not encodable         |
| `constraint`         | the compare-and-swap matched nothing, the persisted prefix diverged, or SQL refused a row |
| `decode_failed`      | a stored row did not decode                                                               |
| `persistence_failed` | the SQL layer failed for a reason that is not a constraint violation                      |

`PlanStoreErrorCode` is exported as both a schema and a type.

## Migrations

[src/Migrations.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan-store/src/Migrations.ts)

The namespaced set owns `flows_plans`, `flows_plan_nodes`, and `flows_plan_edges`
in id block `4000`, after journal (`0`), run store (`1000`), step cache (`2000`),
and engine store (`3000`). [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)'s
`Migrations.sets` composes all five. The database loader handles forward
additions to already installed lower blocks before the ordinary migration pass;
earlier holes and entirely new lower blocks are refused rather than skipped.

The ordered steps live under `src/internal/migrations`, which the export map blocks, so `set` is the only way to reach them; a step imported on its own would run outside the namespaced ordering that migrator relies on.

### Migrations.set

```ts
const set: DatabaseMigrations.MigrationSet // namespace "plan", idOffset 4000
```

The namespaced migration set, for composition with the other storage packages.

### Migrations.run and Migrations.layer

```ts
const run: Effect.Effect<void, ..., SqlClient.SqlClient>
const layer: Layer.Layer<never, ..., SqlClient.SqlClient>
```

`run` creates the plan schema. `layer` runs the migrations before exposing the database to the plan store, which is what a standalone composition uses.

### The migrations

Append-only is enforced in SQL rather than by convention.

| Step                         | What it does                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_initial`               | Creates the three tables, the `flows_plan_nodes_order` index, and triggers that raise on any UPDATE or DELETE of a node or edge row and on any backward move of a plan row.     |
| `0002_append_only_hardening` | Forbids deleting a plan row, extends the forward-only trigger to pin `flow` and `created_at_ms`, and makes `(plan_id, ordinal)` unique so recorded node order is deterministic. |
| `0003_forward_only_identity` | Recreates the forward-only trigger with `plan_id` pinned, so a forward UPDATE cannot rename a plan and strand its immortal node and edge rows under the old id.                 |
