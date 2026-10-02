---
title: "Quickstart"
description: "Record a compiled plan in SQLite, append a third node at the next generation, and read the whole keyed graph back."
sidebar:
  order: 2
---

This quickstart takes one plan from drafts to durable rows and back. By the end
you will have an append-only SQLite table holding a compiled graph and a third
node added at generation 1 without a single stored row being rewritten.

Nothing here executes a node. A plan is inert: driving one is
[`@smthrs/engine-store`](/api/engine-store)'s `PlanScheduler`.

## Prerequisites

- Node.js 26.4.0 or later.
- A package with the dependencies installed. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/apps/site/docs/installation.mdx).

[`@smthrs/database`](/api/database) supplies the SQLite client and the durable
writer that `PlanStore` writes through. `@effect/platform-node` supplies
Effect's `Crypto` service, which is the only thing compiling a plan asks for.

## Declare two nodes

Create `quickstart.ts`. A `Plan.NodeDraft` is a node without its key: an id, the
key material that decides its identity, and the file effects it declares.

```ts
import * as KeyMaterial from "@smthrs/plan/KeyMaterial"
import * as Plan from "@smthrs/plan/Plan"

/** Everything hashed about one node. `sealed` is the tier that may be reused across runs. */
const material = (body: unknown, inputs: ReadonlyArray<KeyMaterial.InputRef> = []): KeyMaterial.KeyMaterial => ({
  version: KeyMaterial.version,
  kind: "sealed",
  body,
  inputs,
  layers: [],
  capabilities: []
})

/** Two steps: the second consumes the first's result and reads the file it wrote. */
const drafts: ReadonlyArray<Plan.NodeDraft> = [
  {
    id: "read-pr",
    material: material({ action: "read-pr", pr: 4821 }),
    effects: { reads: [], writes: ["pr.json"], boundaryMode: "hard" }
  },
  {
    id: "run-tests",
    material: material({ action: "run-tests" }, [{ _tag: "Ref", from: "read-pr", path: [] }]),
    effects: { reads: ["pr.json"], writes: ["report.json"], boundaryMode: "hard" }
  }
]
```

The `Ref` input is the only place `run-tests` names `read-pr`. That one
declaration becomes both the hashed dependency and the graph edge, so an edge
and a key can never disagree about what a node consumes.

## Compose the store

`PlanStore` needs a SQL client, the durable writer, and the plan schema. The
migrations layer creates the three tables before the store is exposed:

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Migrations from "@smthrs/plan-store/Migrations"
import * as PlanStore from "@smthrs/plan-store/PlanStore"
import * as Layer from "effect/Layer"

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: ":memory:" })
)

const store = Layer.provideMerge(
  PlanStore.layer,
  Layer.provideMerge(Migrations.layer, database)
)
```

Use `:memory:` while you are learning. A real host points `filename` at a file
on disk. The three plan tables carry their own migration id block, so one
database file can hold them alongside the tables other Smithers packages
create without the two migration sets colliding.

## Compile, record, append, read back

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

const program = Effect.gen(function*() {
  const plan = yield* Plan.compile({ planId: "review-4821", flow: "example/Review", nodes: drafts })
  const plans = yield* PlanStore.PlanStore

  const outcome = yield* plans.record(plan, Date.now())
  console.log(outcome._tag, plan.digest)

  const grown = yield* Plan.append(plan, [{
    id: "post-comment",
    material: material({ action: "post-comment" }, [{ _tag: "Pending", from: "run-tests" }]),
    effects: { reads: ["report.json"], writes: [], boundaryMode: "hard" }
  }])
  yield* plans.append(grown)

  const stored = Option.getOrThrow(yield* plans.get("review-4821"))
  for (const node of stored.nodes) {
    console.log(node.generation, node.id, node.key, node.dependsOn)
  }
  console.log(stored.generation, stored.baseDigest === plan.digest)
})

await Effect.runPromise(program.pipe(Effect.provide(store), Effect.provide(NodeCrypto.layer), Effect.orDie))
```

Run the file with your TypeScript runner. The digests on your machine match
these, because a plan is a pure function of its declarations:

```text
Recorded key1_61edccc875ff69b798e0c3874d167f65ff0a250b9fe67d27558b854fa2832302
0 read-pr key1_6353326ab2a03804d6acfe916debc4f04f09f9deb8f0e93c1ebea3cdd983db18 []
0 run-tests key1_e58229e3be2f6abf6f818baf8577fe7045edba6f5e88097b633898478da93985 [ 'read-pr' ]
1 post-comment key1_0ac2aef1d5d4226849c6009450ad987b47dc02cf39d39ab975db3c673698241d [ 'run-tests' ]
1 true
```

## What just happened

`Plan.compile` put the drafts in topological order, substituted each dependency
reference for the already computed key of the node it names, annotated the
overlap between write sets, and derived the plan digest. It read no file, no
clock, and no network: the only service it asked for was `Crypto`.

`record` wrote generation 0 first-writer-wins. Recording the same plan twice
answers `ExistingSame` rather than failing; recording a different plan under the
same id answers `Conflict` with the digest already stored, so nothing is
overwritten silently.

`Plan.append` then produced generation 1. The two original nodes kept their id,
key, edges, and generation byte for byte, and `post-comment` arrived pre-keyed
against them. `plans.append` advanced the plan row with a compare-and-swap on
the previous generation, the flow, and the approved base digest, then inserted
the new rows. The final line prints `true` because `baseDigest` still names the
digest a human would have approved, even though `digest` has moved on.

Read `post-comment`'s edge: it depends on `run-tests`, which it never consumed a
value from. Two separate declarations put it there. Its `Pending` input is an
ordering reference, and it reads `report.json`, which `run-tests` writes, so the
reader-after-writer pass would have ordered it behind the producer anyway.

## Next steps

- [Persist a plan](./guides/persist-a-plan.md): the composition above in
  production shape, and every outcome `record` can answer with.
- [Append a generation](./guides/append-a-generation.md): what an elaboration
  may add, and what the compare-and-swap refuses.
- [Testing](./testing.md): the in-memory database layer and the two-connection
  shape the durability cases use.
- [Troubleshooting](./troubleshooting.md): every failure message, what causes
  it, and what to change.
