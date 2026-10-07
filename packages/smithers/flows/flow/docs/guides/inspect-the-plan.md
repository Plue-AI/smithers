---
title: "Inspect the plan a body builds"
description: "Build a flow's graph without running it, read its nodes, edges, and diagnostics, and drive one interpretation to see what settled, failed, or was skipped."
sidebar:
  order: 11
---

Building a plan is a pure function of the declarations and the payload, so you
can look at the whole shape of a round before its first step runs. That is the
tool to reach for when a step key changed unexpectedly, when a branch took the
arm you did not expect, or when you want to show an operator what a run is about
to do.

## Build the graph

```ts
import { Graph } from "@smthrs/flow"

const graph = Graph.build(Release, { target: "web" })

for (const node of Graph.nodes(graph)) {
  console.log(node.id, node.kind, node.dependencies)
}

for (const edge of Graph.edges(graph)) {
  console.log(`${edge.from} -> ${edge.to} (${edge.reason})`)
}
```

`Graph.build` takes a flow declaration or a bare node, the payload, and options.
Nothing runs. It refuses a nesting depth past its bound and a duplicate node id,
because a node id is durable dispatch identity and two nodes answering to one
address would let a later settlement overwrite an earlier one.

## What a node carries

| Field                       | What it holds                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | The structural address, which is what the durable step key is derived from.                                                   |
| `kind`                      | The authoring variant it came from, not the plan's node kind. Every draft a graph produces is a plan `step`.                  |
| `dependencies`              | The ids this node consumes.                                                                                                   |
| `capabilities`, `placement` | The declarations lowered onto it.                                                                                             |
| `draft`                     | The `Plan.NodeDraft` the plan is compiled from.                                                                               |
| `ast`                       | The authoring node it was observed at, so a driver can reach the real mapper, predicate, and member names.                    |
| `payload`                   | What the node passes on, hydrated: real data where the author wrote data, and a planned placeholder where a step result goes. |

Nodes come back with children before the parents that consume them. An `Edge`
points from the node that produces to the node that consumes, and its `reason` is
`value` for a consumed result, `continuation` for the sequencing edge a builder
or branch arm records, or `failure` for a recovery arm.

## Read the diagnostics

`Graph.inspect(flow)` exports JSON-safe nodes, edges, steps, diagnostics and,
for prompt declarations, the renderer's source. It supplies an unresolved
`Planned` input and uses the same graph builder. It never runs an action or
renders a prompt. Repository declarations must still be inspected in their
guest, because building a graph calls their plan-time bodies.

Inspect `diagnostics` before interpreting the steps. A body that computes on its
input can require a real payload; inspection reports `declaration_requires_input`
and shows the declaration as one opaque flow boundary, without declaring it
unloadable or borrowing another version’s steps. Use `Graph.build(flow, payload)` to plan
that invocation. Symbolic inputs have the same restrictions as planned step
results: use node combinators for branching, not JavaScript truthiness or
reference comparisons. Prompt source is code for inspection, not a rendered
prompt or an executable browser artifact.

`Graph.diagnostics(graph)` holds the recoverable topology issues, such as a
missing continuation builder or a continuation that produced no node. Fatal
refusals, including computing on a planned value and a recursive inline `call`,
throw from `Graph.build` and never appear here.

A graph carrying diagnostics is inspectable but deliberately not compilable, so
`Graph.drafts(graph)` throws the first typed build refusal rather than returning
partial drafts. Check diagnostics before asking for drafts:

```ts
const issues = Graph.diagnostics(graph)
if (issues.length === 0) {
  const drafts = Graph.drafts(graph) // ready for Plan.compile or Plan.append
}
```

## Resolve layers while building

`BuildOptions.resolveLayers` is invoked once per node and is told a
`LayerRequest`: the node id, its authoring kind, its capabilities, its declared
effects, and its placement. It answers the identity of the implementation the
node would run against, never a layer value or a runtime handle:

```ts
const planned = Graph.build(Release, { target: "web" }, {
  resolveLayers: (request) => request.capabilities.map((name) => `layer:${name}`),
  root: "root"
})
```

The resolver must be pure. Planning performs no input or output, and a resolver
that read the world would make a plan a function of more than its declarations.
`root` defaults to `"root"` and names the address the walk starts from.

## Drive one interpretation

`Interpreter.interpret` builds the graph and walks it against real values,
without registering the flow. It answers an `Interpretation`:

```ts
import { Interpreter } from "@smthrs/flow"

const interpretation = yield* Interpreter.interpret(Release, { target: "web" })

interpretation.value // the root's value
interpretation.settled // ReadonlyMap<string, unknown>: every node that settled
interpretation.failed // the typed failures observed before a catch recovered them
interpretation.skipped // the nodes a branch went the other way on
```

`skipped` is the field that answers "why did nothing happen here". The walk is
demand driven from the root rather than a sweep over the node list, because
dependency order puts both branch arms before the branch that chooses between
them, and executing an arm to discover it was not taken is exactly what static
topology exists to avoid.

## The refusals the interpreter reports

`Interpreter.InterpreterError` carries a stable `code`, the flow, and the node:

| Code                              | What it means                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| `incomplete_graph`                | The build reported topology it could not complete.                                   |
| `duplicate_node_id`               | Two nodes answer to one dispatch address.                                            |
| `unresolved_action`               | An action the body names has no implementation wired up.                             |
| `implementation_version_mismatch` | A declaration and its registered implementation disagree on `implementationVersion`. |
| `missing_implementation_version`  | A content-reusable sealed action declares no `implementationVersion`.                |
| `unresolved_reference`            | A payload reads a node this graph does not hold.                                     |
| `unsupported_call`                | A call whose declaration did not survive serialization.                              |
| `missing_operation`               | A deferred function that did not survive serialization.                              |

Missing mappers, branch predicates, and catch schema filters are refused before
any action dispatch, including operations in untaken arms. `Node.catch` cannot
recover an `InterpreterError`, even without an error schema.

`unresolved_action` is the one an author meets most: it means a layer is missing
from the composition, or `Action.layerImplementations` was merged beside the
implementation layers instead of provided under them.

## Related pages

- [Bodies are plans](../concepts/bodies-and-plans.md): why the build is pure and
  what it refuses.
- [Execution identity](../concepts/execution-identity.md): how a node id becomes
  a durable step key.
- [Troubleshooting](../troubleshooting.md): the same refusals, sorted by symptom.
