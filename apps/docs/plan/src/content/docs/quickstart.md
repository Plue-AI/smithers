---
title: "Quickstart"
description: "Compile a two-node plan, read its step keys, append a third node at the next generation, and diff the two graphs."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/plan/docs/quickstart.md"
---

This quickstart takes one plan from drafts to a keyed graph and grows it. By the
end you will have a compiled graph with real step keys, a third node added at
generation 1 with the first two untouched, and a diff that says exactly what
changed.

Nothing here executes a node or writes a row. A plan is inert: persisting one is
[`@smthrs/plan-store`](https://plan-store.smithers.sh/reference/api/), and driving one is
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)'s `PlanScheduler`.

## Prerequisites

- Node.js 26.4.0 or later.
- A package with the dependencies installed. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

`@effect/platform-node` supplies Effect's `Crypto` service, which is the only
thing compiling a plan asks for.

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

## Compile, append, diff

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as PlanDiff from "@smthrs/plan/PlanDiff"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const plan = yield* Plan.compile({ planId: "review-4821", flow: "example/Review", nodes: drafts })
  console.log(plan.digest)

  const grown = yield* Plan.append(plan, [{
    id: "post-comment",
    material: material({ action: "post-comment" }, [{ _tag: "Pending", from: "run-tests" }]),
    effects: { reads: ["report.json"], writes: [], boundaryMode: "hard" }
  }])

  for (const node of grown.nodes) {
    console.log(node.generation, node.id, node.key, node.dependsOn)
  }
  console.log(grown.generation, grown.baseDigest === plan.digest)
  console.log(PlanDiff.diff(plan, grown).added)
})

await Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer), Effect.orDie))
```

Run the file with your TypeScript runner. The digests on your machine match
these, because a plan is a pure function of its declarations:

```text
key1_61edccc875ff69b798e0c3874d167f65ff0a250b9fe67d27558b854fa2832302
0 read-pr key1_6353326ab2a03804d6acfe916debc4f04f09f9deb8f0e93c1ebea3cdd983db18 []
0 run-tests key1_e58229e3be2f6abf6f818baf8577fe7045edba6f5e88097b633898478da93985 [ 'read-pr' ]
1 post-comment key1_0ac2aef1d5d4226849c6009450ad987b47dc02cf39d39ab975db3c673698241d [ 'run-tests' ]
1 true
[ 'post-comment' ]
```

## What just happened

`Plan.compile` put the drafts in topological order, substituted each dependency
reference for the already computed key of the node it names, annotated the
overlap between write sets, and derived the plan digest. It read no file, no
clock, and no network: the only service it asked for was `Crypto`.

`Plan.append` then produced generation 1. The two original nodes kept their id,
key, edges, and generation byte for byte, and `post-comment` arrived pre-keyed
against them. The `true` line is `baseDigest` still naming the digest a human
would have approved, even though `digest` has moved on.

Read `post-comment`'s edge: it depends on `run-tests`, which it never consumed a
value from. Two separate declarations put it there. Its `Pending` input is an
ordering reference, and it reads `report.json`, which `run-tests` writes, so the
reader-after-writer pass would have ordered it behind the producer anyway.

## Next steps

- [The plan value](/concepts/plan-value/): generations, digests, and why a
  plan grows instead of being rewritten.
- [Step keys](/concepts/step-keys/): what goes into a key, what deliberately
  does not, and why invalidation is re-keying.
- [Diff two plans](/guides/diff-two-plans/): report what a re-plan changed,
  attributed to the field that changed it.
- [Persist a plan](https://plan-store.smithers.sh/guides/persist-a-plan/): the
  append-only store, in production shape.
