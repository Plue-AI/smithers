---
title: "The plan value"
description: "What a compiled plan is: a keyed graph, two digests, a generation counter, and a snapshot nothing can mutate after the fact."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/plan/docs/concepts/plan-value.md"
---

A plan is the whole of what a run intends to do, computed before anything runs
and expressed as one value. It is a `Plan` struct: an id, the flow it was
compiled for, a generation counter, two digests, and an ordered list of keyed
nodes.

```ts
import * as Plan from "@smthrs/plan/Plan"

declare const plan: Plan.Plan
plan.planId //    "review-4821"
plan.flow //      "example/Review"
plan.generation // 0
plan.baseDigest // the digest a human approved
plan.digest //    the digest as of this generation
plan.nodes //     every keyed node, in material-dependency order
```

Everything else in this package either produces that value, persists it,
compares two of them, or supplies the vocabulary its fields are written in.

## The four rules

Four properties shape every design decision here. Read them once and most of the
API stops being surprising.

### Planning demands nothing

A `Node` carries Effect's requirement channel, `R`, as a phantom. No combinator
reads it, so building a graph asks for no service at all. The channel states
which implementations running the plan will need, and the place that runs it is
where the compiler asks for them.

`Plan.compile` is the one exception, and a narrow one: it asks for Effect's
`Crypto` service, because it hashes. It asks for nothing else.

### Planning performs no I/O

Nothing here reads a file, a clock, or a network. A node's declared `effects`
carry read and write _paths_, never digests, because measuring a path is the
scheduler's run-time job. That is what makes a plan reproducible: compile the
same drafts twice, on two machines, and you get the same keys and the same
digest.

### Invalidation is re-keying

A node's key is a function of what it consumes, so an edited declaration
re-keys that node and its dependent cone and nothing else. There is deliberately
no reverse-dependency index and no invalidating node visitor in this package,
and there must never be one: content addressing subsumes both. [Step keys](/concepts/step-keys/) covers what a key folds in.

### A plan grows; it is never rewritten

`Plan.append` adds a pre-keyed subgraph at the next generation. Recorded nodes
keep their id, key, edges, and generation byte for byte, and the SQL raises
rather than letting a caller update or delete one. Re-ordering after a
reconciliation happens by re-keying _future_ steps, never by rewriting history.

## Nodes

Within each generation, `plan.nodes` follows the topological order of material dependencies.
Inferred reader-after-writer edges can point to later array entries. Schedule
nodes from the complete `dependsOn` graph.

Each entry of `plan.nodes` is a `PlanNode`:

| Field        | What it holds                                                                  |
| ------------ | ------------------------------------------------------------------------------ |
| `id`         | The durable lookup address. Never hashed, so renaming a node re-keys nothing.  |
| `kind`       | `step`, `agent`, or `merge`.                                                   |
| `key`        | The computed step key, in the same `key1_` format the engine dispatches under. |
| `material`   | The declaration the key was derived from.                                      |
| `effects`    | The reads, writes, removals, and boundary mode this node declares.             |
| `dependsOn`  | The scheduling edge set, including dependencies on later array entries.        |
| `conflicts`  | One annotation per overlapping writer no dependency path already orders.       |
| `strategy`   | This declaration's preferred plan-time verdict for an overlap.                 |
| `runtime`    | This declaration's preferred response when a predicted overlap actually bites. |
| `priority`   | The scheduler's tie-break among ready work. Higher runs first.                 |
| `generation` | Which append added this node. Generation 0 is what `compile` produced.         |

`dependsOn` is wider than the material references alone. It also carries the
ordering edge a `serialize` verdict added and the reader-after-writer edges that
put a node behind whoever produces the paths it reads. Ordering edges are
deliberately not key material: a node serialized behind another still computes
the same result, so re-keying it would throw away a legitimate cache hit.
[Declared effects and conflicts](/concepts/effects-and-conflicts/) covers both passes.

`priority` is not key material either, for the same reason. It changes latency
and nothing else.

## Two digests

`baseDigest` is the digest at generation 0: what a human approved and what a
running run pins. `digest` advances with every appended elaboration. A control
plane binds an approval to `baseDigest`, so a plan that grew during the run
still validates against the decision that admitted it.

Both digests cover node identity, every computed key, the edge set, the conflict
annotations, the declared effects, the priority, and each node's own conflict
and runtime strategies. They do not cover anything presentational, and they do
not cover a diff's attribution report.

The command line prints the same projection: [`smthrs flow plan`](https://smithers.sh/docs/reference/cli/flow/)
renders the plan card and the approval payload that
[`smthrs approvals approve`](https://smithers.sh/docs/reference/cli/approvals/) and `smthrs flow execute` accept.

## Generations

`compile` produces generation 0. Every `append` produces the next one, and
`Plan.generationNodes` reads back only the nodes the newest generation added,
which is exactly what [`@smthrs/plan-store`](https://plan-store.smithers.sh/reference/api/)'s `PlanStore.append` inserts.

A generation exists because plans elaborate. A step that discovers the shape of
its own follow-on work cannot state that work up front, so the plan grows to
hold it. What it must never do is change what an operator already saw, which is
why growth is the only move available.

## An immutable snapshot

A compiled plan is a deep-frozen snapshot of the drafts it was given. Material
is stored as the inert JSON mirror its key already covers, so a `Date`, a `URL`,
or any value with a data-valued callable `toJSON` is stored as the value it
serializes to. Mutating a caller's draft after compiling cannot change the plan,
its keys, or its digest.

A material accessor, or a prototype with no JSON representation, is refused as
`invalid_node` naming the node and the payload path rather than stored by
reference. A `Planned` placeholder is left intact so canonical serialization
still refuses it.

## Payloads are plaintext

Material is identity: the body and inputs of a node are hashed into its step
key and written verbatim as plaintext into `node_json` and the approval card an
operator reads. This package never redacts them, and redacting after hashing
would break `Plan.verify`. Keep credentials out of payloads. A secret belongs in
a layer, a capability, or the environment, resolved at dispatch.

## Where a plan comes from

`Plan.compile` takes `NodeDraft` values. Flow authors do not write those by
hand: [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) walks a flow body into drafts through
`Graph.build` and `Graph.drafts`, and hands them here. `Plan.NodeDraft` is the
type in the middle, and it is the whole contract between the two packages.

[Author a node graph](/guides/author-a-node-graph/) walks that seam.

## Bounds

One compiled plan holds at most `Plan.maximumPlanNodes` nodes, which is 10,000.
A plan above the ceiling is refused with `graph_too_large` before effect
analysis. Analysis also refuses more than 250,000 candidate pairs or 10,000,000
work units, including overlap comparisons, bitset merges and graph traversal.
This budget applies across all generations replayed by `verify`. Split plans
that exceed either budget across flow boundaries.

Reachability is cached in bitsets and updated when ordering edges are inferred.
Analysis yields periodically so cancellation and other fibers can run. Imported
plans reuse one effect expansion map and candidate index across generations.

Compilation itself walks with explicit stacks and never recurses per edge, so
depth is a data structure rather than native stack frames.
