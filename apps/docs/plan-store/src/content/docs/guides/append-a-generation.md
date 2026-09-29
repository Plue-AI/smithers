---
title: "Append a generation"
description: "Grow a recorded plan: pre-key a subgraph against what is already there, advance the plan row with a compare-and-swap, and keep the approved base digest intact."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/plan-store/docs/guides/append-a-generation.md"
---

A plan elaborates. A step that discovers the shape of its own follow-on work
cannot state that work up front, so the plan grows to hold it. It grows by
appending a generation, and nothing already in it moves.

Appending is two calls: `Plan.append` produces the next generation as a value,
and `PlanStore.append` writes the rows it added.

## Grow the value

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as PlanStore from "@smthrs/plan-store/PlanStore"
import * as KeyMaterial from "@smthrs/plan/KeyMaterial"
import * as Plan from "@smthrs/plan/Plan"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"

/** From "Compile drafts into a plan" and "Persist a plan". */
declare const compiled: Effect.Effect<Plan.Plan, never, Crypto.Crypto>
declare const planStore: Layer.Layer<PlanStore.PlanStore>

export const grow = Effect.gen(function*() {
  const base = yield* compiled
  const grown = yield* Plan.append(base, [{
    id: "post-comment",
    material: {
      version: KeyMaterial.version,
      kind: "sealed",
      body: { action: "post-comment" },
      inputs: [{ _tag: "Pending", from: "run-tests" }],
      layers: [],
      capabilities: ["net:post"]
    },
    effects: { reads: ["report.json"], writes: [], boundaryMode: "hard" }
  }])
  const store = yield* PlanStore.PlanStore
  yield* store.record(base, Date.now())
  yield* store.append(grown)
  return Plan.generationNodes(grown).map((node) => node.id)
}).pipe(Effect.provide(planStore), Effect.provide(NodeCrypto.layer))
```

`Plan.append` advances `generation` by one, keys the new drafts against the
nodes already in the plan, re-runs the conflict and reader-after-writer passes,
and derives a new `digest`. The nodes already in the plan keep their id, key,
edges, and generation byte for byte, so a cache hit on them shows instantly.

`baseDigest` does not move. It is what a human approved and what a running run
pins, so an approval taken at generation 0 still validates against a plan that
has grown three times since.

## Which nodes the append adds

`Plan.generationNodes(plan)` returns the nodes at the plan's current generation.
That is what `PlanStore.append` inserts, and what a scheduler such as
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)'s reports in the
`subgraph-appended` record it writes to the run journal.

## Frozen nodes are annotated one-sidedly

Both plan passes skip nodes an earlier generation froze, because their rows can
never be rewritten. When a new node conflicts with a frozen one, the annotation
lands on the new node only, and so does the ordering edge. The pair is still
fully described; it is described from the side that is still writable.

## The compare-and-swap

`PlanStore.append` verifies the supplied plan, derives the digest of its
verified prefix with `Plan.prefixDigest(plan)`, then advances the plan row
with an UPDATE matching the previous generation, the flow, the approved
`baseDigest`, and that running prefix digest. The digest match proves that
the stored plan envelope is the one the caller grew from.

A successful append does not read, decode, or verify stored node rows. It
inserts only the current generation's nodes, with ordinals starting at the
length of the verified caller prefix. This keeps successive appends from
re-reading an ever-growing history.

If the UPDATE matches nothing, append checks the stored envelope. For an
existing plan it calls `get` to distinguish corruption (reported as
`decode_failed`) from a legitimate mismatch. A missing plan, skipped or
moved generation, flow mismatch, or base digest mismatch fails with
`constraint`:

```text
plan review-4821 was never recorded, or generation 3 was skipped or moved under the append
```

A divergent running prefix digest also fails with `constraint`:

```text
plan review-4821 recorded plan's nodes diverge from the plan this append was grown from
```

Recompile from the stored plan and append again after a divergent branch.
The whole append is one transaction: a failed swap cannot leave new node
rows behind under the append-only triggers. An append with no new nodes is
refused as `invalid_plan`.

## Migration ordering

This package owns `flows_plans`, `flows_plan_nodes`, and `flows_plan_edges` in
migration id block `4000`, the next free block after the journal (`0`), the run
store (`1000`), the step cache (`2000`), and the engine store (`3000`).

[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)'s `Migrations.sets` composes this set
last. [`@smthrs/database`](https://database.smithers.sh/reference/api/)'s migrator uses a global applied
high-water mark, but composition does not silently skip every lower id:
forward additions to an installed lower block are applied transactionally
with their migration ledger rows. Earlier holes and newly introduced lower
blocks are refused instead of silently skipped. Declare the matching recorded
migrations when extending an installed block; put a new package's block above
the high-water mark.

## Next

- [Diff two plans](https://plan.smithers.sh/guides/diff-two-plans/): show what a re-plan changed.
- [The plan value](https://plan.smithers.sh/concepts/plan-value/): why growth is the only move
  available.
