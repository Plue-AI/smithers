---
title: "Bodies are plans"
description: "Why a flow body runs at plan time, what a planned value is and the one rule it obeys, and how branches, fan-out, and recovery stay static topology."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/flow/docs/concepts/bodies-and-plans.md"
---

A flow's `body` is a pure function from the decoded payload to a
[`Node`](https://plan.smithers.sh/reference/api/). Calling it builds topology. It runs nothing, reads nothing,
and returns a description that `Graph.build` can walk without dispatching a
single step.

A flow authored with `prompt` has the same body contract: `Flow.make` supplies
a body that records one ordinary action call. Planning never renders the prompt
or calls a model. The host implements the exposed `flow.action` and renders
`flow.prompt` with the decoded payload when that action runs.

Reproducible plans require complete, stable declaration identities as well as
the same payload. Use `Node.capture` to declare semantic captures and imported
implementation versions, and select stable callback validation. The low-level
process-local callback policy permits inspection but does not promise the same
plan across processes. Stable node addresses alone do not prove unchanged
behavior.

## What a body may not do

The body's source digest enters the flow's content identity, so the body must not
depend on anything the digest cannot observe. In practice:

- No mutable module state, clocks, random values, services, or environment
  values captured outside `payload`.
- No conditionals on a step result written as ordinary JavaScript. A decision
  between two continuations is `Node.branch`, which stores both arms.
- No work that genuinely wants opaque code. That work is an action, and its
  implementation attaches as a layer.

`Flow.make` cannot enforce purity or verify capture completeness. An omitted
semantic input can change behavior without changing a key, allowing stale
replay. Do not rely on a key mismatch to detect undeclared behavior changes.

## Planned values

The payload a body receives is real data. Every step result inside it is a value
that does not exist yet, and the body sees it as a `Planned` placeholder.

A planned value obeys one rule: **pass it, never compute on it.** Passing it into
a payload field, into a branch, or into a `map` is fine, and field access is
allowed because it records a reference path rather than reading anything.

```ts
import { Node } from "@smthrs/plan"

// Allowed: the placeholder is passed on, and `report.summary` records a path.
Build.call({ target: "site" }).pipe(
  Node.bindPlanned((report) => Publish.call({ summary: report.summary }))
)
```

Misuse fails twice, and both failures are deliberate. `Planned` is branded, so
arithmetic and template interpolation are compile errors. At run time the
placeholder is a strict proxy whose `Symbol.toPrimitive`, `valueOf`, `toString`,
`toJSON`, and call traps throw a `GraphBuildError` with the code
`planned_value_computed`, rather than let a plan be built around `NaN` or
`"[object Object]"`.

Two operations JavaScript exposes no trap for, `Boolean(value)` and strict
identity, cannot be refused at run time. They reveal only the proxy's truthiness
or identity, never the result. Decide on real values with `Node.branch`.

## The node vocabulary

A body is written in [`@smthrs/plan`](https://plan.smithers.sh/reference/api/)'s `Node` combinators, and each
one has a job:

| Combinator                                | What it is for                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `Node.succeed(value)`                     | A constant, for a body that settles without a step.                                                                        |
| `Node.all({ ... })`                       | Independent children, settled concurrently, keyed by name. Width is fixed here, at plan time.                              |
| `Node.map(node, f)`                       | Computation on a step result. The function is digested, not run; it executes later on the real value.                      |
| `Node.andThen(node, next)`                | A success barrier: no part of the next subtree starts until the first node succeeds. Bound long chains as described below. |
| `Node.bindPlanned(node, build)`           | Builds data dependencies from a placeholder. Independent descendants may run concurrently with the producer.               |
| `Node.branch(node, { if, then, else })`   | A decision. Both arms are built once at plan time and both are stored.                                                     |
| `Node.catch(node, { onFailure, error? })` | Recovery. The failure arm is topology too, and a schema narrows which failures it handles.                                 |
| `Node.priority(node, n)`                  | Scheduling order for ready work. It never enters key material, so raising it cannot invalidate a recorded result.          |

Nested explicit `andThen` subtrees carry only their nearest success barrier.
That prerequisite already depends on the outer barriers, so ordering remains
transitive and a right-nested chain has linear continuation edges and `Pending`
inputs.

Structural node IDs retain the `.andThen` and `.then` path segments because
these addresses participate in durable dispatch identity. Each ID grows with
nesting depth, and total ID bytes in a sequential chain grow quadratically,
including fluent left-nested chains. Plans repeat IDs in inputs and dependency
lists. Split long chains into bounded [trampoline rounds](/concepts/trampoline-rounds/)
or `.child()` flow boundaries; shorter barrier lists do not bound ID bytes.

A `map` that decides what happens next is a `branch` written wrongly. Both a
branch's arms and a catch's failure arm contribute their requirements to the
node, because both are topology the plan carries: a run takes one of them, but
which one is not known until the predicate sees the real value.

## Fixed width, and what to do instead

`Node.all` settles its members concurrently with no bound, and the member set is
fixed when the plan is built. Fanning out over something a step discovered is not
this. End the round and carry the list in the next flow's payload, where it is
real data. See [Trampoline rounds](/concepts/trampoline-rounds/).

For explicit batches, sequence whole `Node.all` subtrees with `Node.andThen`.
Members within an opened batch remain concurrent. A `bindPlanned` reference
orders its consumers, not every independent member of the continuation; it is
not a whole-batch admission barrier. This manual batching is distinct from the
compiled scheduler's admission caps, which the public interpreter does not yet
consume.

## What the build refuses

`Graph.build` reports what it can and throws what it cannot. Recoverable topology
issues land in `Graph.diagnostics(graph)`, and a graph carrying diagnostics is
inspectable but deliberately not compilable, so an incomplete body is reported
rather than half-driven.

Fatal refusals throw a `GraphBuildError` naming the site and the fix. The ones an
author meets are:

| Code                                                   | What happened                                                                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `planned_value_computed`                               | A body computed on a step result.                                                                                      |
| `invalid_all_member`, `invalid_continuation`           | An `all` member or a branch arm was not a node.                                                                        |
| `invalid_join`                                         | A race, any, or quorum had a non-node member, no members, or a quorum count its members cannot reach.                  |
| `recursion_requires_boundary`                          | A flow called itself inline. Use `flow.to` or `flow.child`.                                                            |
| `placement_requires_boundary`                          | An inline callee declares a placement the caller cannot satisfy. Use `flow.child`.                                     |
| `duplicate_node`                                       | Two structural addresses resolved to one durable node id, which would let a later settlement overwrite an earlier one. |
| `graph_too_deep`, `payload_too_deep`, `cyclic_payload` | Topology or payload past the build bound, or a payload that contains itself.                                           |
| `invalid_priority`, `invalid_payload`                  | A priority that is not a safe integer, or a payload member that cannot be captured as inert JSON.                      |

The two depth refusals exist because the build walks with an explicit stack and
refuses at a bound, rather than recursing until the native stack overflows
without a typed error.

## The walk

`Interpreter.interpret` builds the graph in full and then drives it, demand
driven from the root rather than as a sweep over the node list. Dependency order
puts both branch arms before the branch that chooses between them, and executing
an arm to discover it was not taken is exactly what static topology exists to
avoid.

## Related pages

- [Compose a body from branches and fan-out](/guides/build-a-body/): the same
  vocabulary as worked code.
- [Inspect the plan a body builds](/guides/inspect-the-plan/): read nodes,
  edges, and diagnostics before anything runs.
- [Execution identity](/concepts/execution-identity/): how a node address becomes a
  durable step key.
