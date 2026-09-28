---
title: "Troubleshooting"
description: "Every failure @smthrs/core raises or records: the symptom, what causes it, and what to change."
---

Failures split two ways on purpose. A malformed declaration throws, because
there is nothing to inspect. An invalid declaration is recorded, because a
reviewer should see the whole plan and its objections at once.

## Failures that throw

### Flow.make requires a name

```text
TypeError: Flow.make requires a name
```

A signature needs a non-empty `name`, which becomes its native flow and action
tag. A signature without a `body` remains callable: it plans the declared action
whose implementation a host supplies through `signature.action.toLayer`.

### Node.all expected a Node at member "x"

```text
@smthrs/plan/GraphBuildError: Node.all expected a Node at member "x"
```

A member of the record you passed to `Node.all` is not a node. Usually the
member is the result of a flow's `body` rather than a call to the flow, or a
plain value that needs `Node.succeed`.

### Node.priority expects a safe integer

```text
@smthrs/plan/GraphBuildError: Node.priority expects a safe integer, received 1.5
```

Priority is a signed integer ordering ready work. Fractions and values past
`Number.MAX_SAFE_INTEGER` are refused at declaration time rather than silently
truncated.

### Node.andThen at "x" must return a Node

`GraphBuildError` with code `invalid_continuation` is raised during
`Graph.build`, when a `bindPlanned` continuation or a `catch` recovery arm returns something
other than a node. The message names the node id, so the structural position
tells you which builder in your source is wrong.

An arm that has nothing to do still has to return a node. `Node.succeed` for
the value you want, or `Node.fail` to re-raise, is the shape.

### Node.capture: capture at $.x ...

```text
TypeError: Node.capture: capture at $.bad has unsupported type function; captures must be finite, inert data
TypeError: Node.capture: capture at $.cyc.self is cyclic; captures must be finite, inert data
TypeError: Node.capture: capture at $.n is not finite; captures must be finite, inert data
TypeError: Node.capture: capture at $.p cannot be structured-cloned (for example, a Proxy); captures must be finite, inert data
```

Capture canonicalizes declared own data into a digest. A refusal names the
path inside the capture record and the admission operation that
failed.

Pass plain, finite, inert data: no `undefined`, `bigint`, `symbol`, or function
values, no `NaN` or infinities, no cycles, no non-plain prototypes, no symbol
keys, no accessors, no array holes, and no nesting past 256 levels. Caller-frozen
ordinary data, including Immer-style trees and null-prototype records, is
supported, as are sealed and non-extensible plain records. Admission rejects
built-in brands before the structuredClone probe, including prototype-swapped
Map, Set, Date and buffers. Proxies are refused. Hosts without structuredClone
refuse object capture. The callback reads the frozen copy through its `this`
receiver; caller objects remain unchanged. See the [capture boundary](api.md#nodecapture).
For a function that depends on unsupported state, leave it unannotated so it
keeps process-local identity.

`TypeError: Node.capture requires a function operation` means the second
argument was not a function.

### graph_too_deep, plan_too_large, payload_too_deep, payload_too_large

`Graph.build` throws a `GraphBuildError` with one of these codes, naming the
node or the value path that crossed a limit. These are not recorded
diagnostics: a plan that crosses a limit is not something to inspect, it is
something the package declined to materialize.

`Graph.maximumGraphDepth` is exported, so a test can assert on the boundary and
a generator can stay inside it. [`@smthrs/flow`](/api/flow) documents every
bound it enforces.

The usual cause is a generated declaration, or a loop that composes nodes
without a bound. `graph_too_deep` after a recursive builder means the recursion
has no base case that stops at 512.

## Failures that are recorded

Read them with `Graph.diagnostics`. Every code except
`capability_outside_grant` is fatal, which means `Graph.drafts` refuses the
graph rather than compiling a plan the builder called invalid.

### effect_outside_envelope

```text
{
  _tag: '@smthrs/plan/GraphBuildError',
  code: 'effect_outside_envelope',
  node: 'root',
  path: [ 'secret.txt' ]
}
```

A step declared a read or write path the envelope it inherited does not cover.
`path` names the uncovered paths and `node` names the step.

Either narrow the step to stay inside the envelope, or widen the enclosing
flow's declaration to grant what the step needs. A path containing a whole `.`
or `..` segment is never covered by any pattern, so an escaping path reports
here rather than resolving: normalize the path before you declare it.

### effect_mode_widening

The enclosing envelope is `hermetic`, meaning its declaration is complete, and
a step inside it declared `expected`, meaning its declaration is partial. A
step cannot claim less certainty than its envelope promised.

Make the step `hermetic`, or make the enclosing flow `expected`.

### effect_tier_widening

A step declared a tier less reversible than its envelope's. The order narrows
from `irreversible` to `compensable` to `sealed`, and an omitted tier reads as
`sealed`.

Raise the enclosing flow's tier to cover the step, or lower the step's.

### write_conflict

```text
{
  _tag: '@smthrs/plan/GraphBuildError',
  code: 'write_conflict',
  node: 'root.all.a',
  path: [ 'out/report.json' ]
}
```

Two work nodes declared overlapping writes and at least one of them declared
`onConflict: "fail"`. This is fatal by design: it is what `fail` is for. `node`
names the first of the pair and the message names both.

Fix the declarations so only one node writes the path, or change the strategy.
`serialize` orders the two writers with a `conflict` edge; `lane` gives each a
lane and synthesizes a merge node. Both keep the graph keyable.

### capability_outside_grant

```text
{
  _tag: '@smthrs/plan/GraphBuildError',
  code: 'capability_outside_grant',
  node: 'root',
  path: [ 'net:fetch' ]
}
```

A called flow declares a capability the calling flow's grant does not include.
`path` names the dropped capabilities. This one is advisory: the graph still
keys, and the inner flow's effective grant is the intersection, so the
capability is dropped rather than smuggled through.

Add the capability to the outer flow with `Flow.withCapabilities`, or remove it
from the inner one.

### duplicate_node

Two nodes claim the same structural id. Ordinary `Node.all` member names can
collide with structural separators:

```ts
import { Graph, Node } from "@smthrs/core"

const graph = Graph.build(Node.all({
  a: Node.all({ b: Node.succeed(1) }),
  "a.all.b": Node.succeed(2)
}))
```

Both leaves have id `root.all.a.all.b`. `Graph.diagnostics(graph)` records
`duplicate_node`, and `Graph.drafts(graph)` refuses the graph.
Rename the colliding member, for example from `"a.all.b"` to `"other"`.
Dotted member names are allowed when their structural ids are unambiguous.

### missing_key_material

A node reached draft compilation without key material. This does not arise from
ordinary declarations. If you see it from a graph `Graph.build` produced, report
a package defect.

## Behavior that is not an error

### A step reruns after a restart

The step's mapper, continuation, or flow body has process-local identity, which
is what an unannotated function gets. Declare what the function closes over
with `Node.capture` and the algorithm becomes `sha256-source-captures/v5`. See
[Identity and key material](./concepts/identity.md).

### planned_value_computed

An operation computed on a symbolic result while planning. Arithmetic, string
interpolation, JSON conversion, calls, property enumeration, and the `in`
operator raise `GraphBuildError` with this code. Read members to name a dependency,
use `Node.map` to compute on the eventual value, and use `Node.branch` to decide.

### Only one branch of a conditional was planned

A conditional on the placeholder always takes the truthy branch, because the
placeholder is an object. Only that branch is planned, with no diagnostic.

Move the decision inside the step that has the real value.

### A `then` field reads as `undefined`

The placeholder reserves the member name `then`, so nothing above the plan
mistakes it for a promise. Rename the field, or read it inside the step that
produces it.

### No conflicts, despite overlapping writes

A container node is not a second writer for the children it encloses, and a
plan built from `Node.succeed` alone contains no work to conflict.
[`@smthrs/flow`](/api/flow) states which node kinds count as writers.

### A graph will not accept a mutation

`Graph.build` deep-freezes everything it constructs, and the getters hand back
the graph's own values rather than copies. Copy what you need before you edit
it.

### A declaration that crossed a process boundary will not plan

Node ASTs and their side tables are process-local. Deferred callbacks and call
declarations live in weak maps beside the AST, and `Graph.build` needs live
Effect `Context` annotations and in-memory continuation associations. A JSON
round trip loses the `Context` identity, so even a constant declaration fails
planning with `invalid_node`.

There is no Node AST serialization contract. Plan the declaration in the process
that built it, or rebuild it in the receiving process first. For later
inspection, persist the built graph or the projections you need from its
getters.

## Where to go next

- [Plan time](./concepts/plan-time.md): why the failures split the way they do.
- [Declare a flow](./guides/declare-a-flow.md): the constructor and the
  combinators these failures come from.
