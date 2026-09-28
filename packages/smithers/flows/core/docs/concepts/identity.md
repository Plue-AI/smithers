---
title: "Identity and key material"
description: "What makes two declarations the same step: the key material a planned node carries, why an unannotated function gets process-local identity, and what Node.capture fixes."
sidebar:
  order: 2
---

A built graph's key material is the projection [`@smthrs/plan`](/api/plan) compiles into
step keys. Two declarations that produce equal key material are the same step,
so a resumed run replays one instead of repeating it, and two runs share the
cached result. What enters that projection is this package's most consequential
contract.

## What a node keys on

Every planned node carries one `KeyMaterial` record:

| Field          | What it holds                                                         |
| -------------- | --------------------------------------------------------------------- |
| `version`      | `"flows/key-material/v2"`. The shape's own version.                   |
| `kind`         | The effect declaration's `tier`, or `"sealed"` when none is declared. |
| `body`         | The node's own declaration, projected into inert data.                |
| `inputs`       | Literal values, references to other nodes, and pending markers.       |
| `layers`       | Whatever the build's `resolveLayers` option returned for this node.   |
| `capabilities` | The sorted capability names in force at this node.                    |
| `effects`      | The effective effect declaration, if any.                             |
| `placement`    | The resolved placement directive, if any.                             |

Two absences are as deliberate as the fields. The graph-local node id is not in
the material: it appears only inside dependency references, and the key
compiler replaces those with the dependency's digest before hashing, so a
node's position in the tree never reaches a key. And a flow's name is not in
the material either. A `FlowCall` body records the flow's input and output
schema identity, its capabilities, its effects, and its implementation
identity. Renaming a flow does not invalidate its cached results; changing what
it does will.

Priority is absent for a third reason: it orders ready work without changing
what the work produces, so raising it never invalidates a cached step.

## Function identity has two algorithms

The subtle part is functions. A mapper, a continuation, and a flow body are
JavaScript closures, and JavaScript cannot inspect closure state. Two processes
running the same program hand the same body two different closures, and nothing
in the language distinguishes a closure that captured `3` from one that
captured `4`.

The package answers honestly rather than guessing:

- **`sha256-source-ephemeral/v4`** is what an unannotated function gets. The
  digest folds the function's source text with a per-process nonce, so it is
  stable inside one process and different in the next one. A step keyed on it
  is a cache miss after a restart, which is correct: nothing proved the
  function would behave the same way.
- **`sha256-source-captures/v5`** is what `Node.capture` produces. The digest
  folds the function's source text with the canonicalized capture data, and no
  nonce, so it is the same in every process that runs the same code with the
  same captures, including their shared-reference topology.

A step whose result must survive a restart therefore has to declare what it
closes over:

```ts
import { Node } from "@smthrs/core"

const factor = 3
const scale = Node.capture({ factor }, function(value: number) {
  return value * this.factor
})
```

Core preserves an authored captured body's identity when lowering it, including
the adapter for a scalar input. Uncaptured author bodies and generated
action-only wrappers remain process-local. The latter need the low-level
`Interpreter.layer` policy or an explicit `callbackIdentity: "process-local"`;
the canonical stable policy does not infer their implementation semantics.

Read this as a promise: "this function's behavior is determined by its source
and by these values". Nothing checks that the promise is true, so a captured
function that also reads a mutable module variable will collide with itself
across two different states. Declare everything the function depends on, or
leave it unannotated.

For the procedure and its failure cases, see
[Declare a flow](../guides/declare-a-flow.md).

## Capture data must be inert

Capture identity covers declared own data. Unsupported shapes are rejected
with a `TypeError` naming the offending path:

- `undefined`, `bigint`, `symbol`, and function values.
- Non-finite numbers: `NaN`, `Infinity`, `-Infinity`.
- Cyclic structures.
- Objects with a non-plain prototype, symbol keys, or accessor properties.
- Arrays with holes or with non-index own keys.
- Nesting deeper than 256 levels.
- Objects that structuredClone rejects, including every Proxy.

Accepted ordinary data is copied and deeply frozen. The callback receives
that copy as its `this` receiver; use a function expression to read it. Caller
objects remain unchanged, including sealed, non-extensible, frozen and
null-prototype records. Frozen and mutable twins have the same identity.
Built-in brand checks reject prototype-swapped Map, Set, Date, buffers and
other internal-slot objects before structuredClone can traverse them. Proxies
are refused; hosts without structuredClone refuse object capture. Lexical
aliases still name original objects and must not supply mutable semantic
state. See the [capture boundary](../api.md#nodecapture).

Comparison is structural: two references to one shared object digest
identically to two structurally equal copies, so aliasing is not identity.

## Plan values are read at build time

`Node.succeed`, `Node.fail`, and a flow call retain the value you pass by
reference and read it when `Graph.build` runs. Mutating a value between
constructing the node and building the graph changes the recorded identity.
This is the same rule from the other direction: what the plan holds is what the
plan is identified by, and the plan is read once, at build.

Reflection reads own property descriptors, including non-enumerable data and
array extras, without invoking accessors. It traverses Map keys and values, Set
values, and Chunk elements. Planned values in these members produce dependency
references, so substituting a producer's digest changes the consumer's identity.
The same member contract and cycle, depth, and member limits apply to reference
discovery and reflection.

Errors include their name, message, own fields, and nested causes. Tagged errors
retain their `_tag` and payload, including Effect's stored constructor arguments.
The `stack` property is excluded. Accessors are recorded by function identity;
unsupported field values are refused instead of omitted.

## Composition identity is the host's answer

The `layers` field is the one place identity comes from outside the
declaration. `Graph.build` accepts a `resolveLayers` option, calls it once per
node with the node's kind, model, capabilities, effects, and placement, and
records whatever it returns:

```ts
const graph = Graph.build(flow, input, {
  resolveLayers: (request) => [`placement:${request.placement?._tag ?? "local"}`]
})
```

The function must be pure, and it returns resolved implementation identities as
strings, not Effect layers or runtime handles. It exists so a host can say
"this step ran against that implementation" and have the answer folded into the
step key: two hosts with different filesystem implementations should not share
each other's cached results.

## Where to go next

- [Declare a flow](../guides/declare-a-flow.md):
  the procedure, with the failures spelled out.
- [Plan time](./plan-time.md): what `Graph.build` evaluates to produce all of
  this.
- [Effect envelopes](./effects.md): how a declaration's reads and writes enter
  identity and ordering.
