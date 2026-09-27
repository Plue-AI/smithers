---
title: "@smthrs/plan"
description: "Compile what a run intends to do into one keyed, content-addressed graph, grow it later without rewriting a node, and diff two graphs to say exactly what changed."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/plan/docs/README.md"
---

`@smthrs/plan` turns a description of work into one durable value. It compiles a
list of declared steps into a graph in which every node carries a content key
derived from what that node declares, grows that graph a generation at a time
without rewriting a node, and compares two graphs to say exactly what changed.
It runs nothing itself and performs no I/O at all.

## What it solves

A long run that calls models, builds code, and touches files has to answer two
questions that are awkward to answer after the fact.

The first is which work is the same work as last time. If identity is a name or
a position in a list, a harmless edit invalidates everything downstream and a
meaningful edit sometimes invalidates nothing. This package makes identity
computable: a node's key is a hash of its payload, its declared dependencies,
its layers, and its capabilities, so an edit re-keys that node and the nodes
that depend on it, and leaves every other key untouched. Renaming a node changes
no key at all, because ids are lookup addresses rather than identity.

The second is whether what executed is what somebody approved. A plan carries
two digests: `digest`, which moves as the plan elaborates, and `baseDigest`,
which still names the shape a reviewer signed off on. `Plan.append` is the only
way a plan changes, and it leaves every earlier node byte for byte.
[`@smthrs/plan-store`](https://plan-store.smithers.sh/reference/api/) keeps that honest in SQL rather than by
convention, with triggers that refuse a rewritten node.

Reach for this package when you are building a scheduler, a cache, or an
approval flow over declared work and you need step identity, declared file
effects, and an auditable history as values you can hold, hash, and store.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

Compiling asks Effect for its `Crypto` service, which a platform package
supplies:

```bash
pnpm add @effect/platform-node@4.0.0-rc.115 @effect/platform-node-shared@4.0.0-rc.115
```

[Installation](/installation/) covers the import forms, the package
persistence lives in, and browser support.

## Compile a plan

Two steps, where the second consumes the first's result and reads the file the
first writes:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as KeyMaterial from "@smthrs/plan/KeyMaterial"
import * as Plan from "@smthrs/plan/Plan"
import * as Effect from "effect/Effect"

/** Everything hashed about one node. `sealed` is work whose result may be reused across runs. */
const sealed = (body: unknown, inputs: ReadonlyArray<KeyMaterial.InputRef> = []): KeyMaterial.KeyMaterial => ({
  version: KeyMaterial.version,
  kind: "sealed",
  body,
  inputs,
  layers: [],
  capabilities: []
})

const drafts: ReadonlyArray<Plan.NodeDraft> = [
  {
    id: "run-tests",
    material: sealed({ action: "run-tests" }, [{ _tag: "Ref", from: "read-pr", path: [] }]),
    effects: { reads: ["pr.json"], writes: ["report.json"], boundaryMode: "hard" }
  },
  {
    id: "read-pr",
    material: sealed({ action: "read-pr", pr: 4821 }),
    effects: { reads: [], writes: ["pr.json"], boundaryMode: "hard" }
  }
]

const plan = await Effect.runPromise(
  Plan.compile({ planId: "review-4821", flow: "example/Review", nodes: drafts }).pipe(
    Effect.provide(NodeCrypto.layer),
    Effect.orDie
  )
)

console.log(plan.digest)
for (const node of plan.nodes) console.log(node.id, node.key, node.dependsOn)
```

`layers` and `capabilities` are empty here. They name the composition a node
runs under and the authority it claims, and both are hashed into the node's
key. `boundaryMode` is `hard` or `expected`: the plan carries it through to
whatever measures the boundary at run time and never interprets it itself.
[Step keys](/concepts/step-keys/) tables every field.

The digests on your machine match these, because a plan is a pure function of
its declarations. Compiling reads no file, no clock, and no network:

```text
key1_61edccc875ff69b798e0c3874d167f65ff0a250b9fe67d27558b854fa2832302
read-pr key1_6353326ab2a03804d6acfe916debc4f04f09f9deb8f0e93c1ebea3cdd983db18 []
run-tests key1_e58229e3be2f6abf6f818baf8577fe7045edba6f5e88097b633898478da93985 [ 'read-pr' ]
```

The drafts went in out of order and came back topologically sorted.
`run-tests` names `read-pr` once, in its key material, and that single
declaration became both the hashed dependency and the graph edge, so an edge and
a key can never disagree about what a node consumes. Change `pr: 4821` to
another number and both keys move; rename `read-pr` to `fetch-pr` and neither
does.

## What is in the package

| Module        | Role                                                                            |
| ------------- | ------------------------------------------------------------------------------- |
| `Node`        | The pure authoring AST: `succeed`, `all`, `map`, `andThen`, `branch`, `catch`.  |
| `Planned`     | The placeholder a body sees where a step result will be.                        |
| `KeyMaterial` | What a planner declares about a node: body, inputs, layers, capabilities.       |
| `StepKey`     | The compiler that turns material and resolved dependencies into a key.          |
| `FileSet`     | Patterns, globs, tree artifacts, and filegroups: the vocabulary `effects` uses. |
| `Plan`        | `compile`, `append`, the node schemas, and the digest an approval binds to.     |
| `PlanDiff`    | A comparison of two plans as a value, with each re-key attributed to a field.   |
| `Placement`   | Where a node runs: four directives, their host detail, and the annotation key.  |

The [API reference](/reference/api/) documents every export.

## Where this sits

`@smthrs/plan` is one package of the Smithers durable flow engine, and it owns
the plan phase: step identity, graph compilation, and declared file effects.
Storing a plan is [`@smthrs/plan-store`](https://plan-store.smithers.sh/reference/api/), which is a separate
package so that compiling does not drag a database in.
[`@smthrs/flows`](https://flows.smithers.sh/reference/api/) is the whole engine as a single dependency, and it
re-exports this package as its `Plan` namespace, so `Plan.compile` there is
`Plan.Plan.compile`. If you are writing an application rather than a scheduler,
install `@smthrs/flows` and reach for this package's names through it; install
`@smthrs/plan` on its own when you want the plan value without the engine that
executes it.

Nothing here executes a node. A compiled plan is inert until a scheduler drives
it, which is [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)'s `PlanScheduler`.
Above this layer, [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) is the authoring API most flow
authors write against, and it produces the drafts that arrive here. Above all of
it, [`@smthrs/cli`](https://cli.smithers.sh/reference/api/) is the `smthrs` command line that plans, approves,
runs, and inspects flows for someone who never imports a package at all.

## Next

- [Quickstart](/quickstart/): compile a plan, append a generation, and diff
  the two graphs.
- [The plan value](/concepts/plan-value/): generations, the two digests, and
  why a plan grows instead of being rewritten.
- [Step keys](/concepts/step-keys/): what goes into a key, what deliberately
  stays out, and why invalidation is re-keying.
- [Declared effects and conflicts](/concepts/effects-and-conflicts/): how
  reads and writes become ordering edges.
- [Persist a plan](https://plan-store.smithers.sh/guides/persist-a-plan/): the
  store composition and every outcome `record` can answer with.
- [Troubleshooting](/troubleshooting/): every refusal this package raises and
  what to change.
