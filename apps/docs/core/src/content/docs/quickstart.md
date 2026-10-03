---
title: "Quickstart"
description: "Declare two signatures, compose them, plan them into a graph, and read the topology and the dependency references back. No host, no engine, no model."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/core/docs/quickstart.md"
---

This quickstart builds one plan end to end. Nothing executes: you declare two
signatures, compose them, and read back the topology and the dependency
references a durable engine keys its steps on. Everything runs in one process
with no engine, no model, and no file system.

## Prerequisites

- Node.js 26.4.0 or later.
- A package with the dependency installed. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

## Declare two signatures

Create `quickstart.ts`. A signature is a declaration: a name, an input schema,
an output schema, and a body that returns a node. The body is a plain function,
and this package never calls it for its value.

```ts
import { Graph, Node } from "@smthrs/core"
import { Flow } from "@smthrs/flow"
import * as Schema from "effect/Schema"

const Review = Flow.make("review", {
  payload: Schema.Struct({ path: Schema.String }),
  success: Schema.Struct({ approved: Schema.Boolean, notes: Schema.String }),
  body: ({ path }) => Node.succeed({ approved: true, notes: `reviewed ${path}` })
})

const Report = Flow.make("report", {
  payload: Schema.Struct({ notes: Schema.String }),
  success: Schema.Struct({ published: Schema.Boolean, notes: Schema.String }),
  body: ({ notes }) => Node.succeed({ published: true, notes })
})
```

The first argument is the required tag: it is the tag the flow, the action, and every plan that
records a call carry. `Review.call({ path: "src/api.ts" })` does not run the
body. It returns a node that records the call.

## Compose them into a plan

`Node.all` runs two independent calls as one join. `Node.bindPlanned` sequences
a builder after it, and the builder receives a symbolic placeholder standing for
the join's eventual value:

```ts
const plan = Node.all({
  api: Review.call({ path: "src/api.ts" }),
  cli: Review.call({ path: "src/cli.ts" })
}).pipe(
  Node.bindPlanned((reviews) => Report.call({ notes: reviews.api.notes }))
)
```

`reviews` is not the reviews. It is a placeholder whose member reads are
recorded, so `reviews.api.notes` says "this step reads the `notes` field of the
`api` member". Read members from it; never compute on it. `Node.andThen` takes a
node rather than a builder, and a continuation that has to DECIDE on a real
value is `Node.branch`. See [Plan time](/concepts/plan-time/) for why.

## Plan the graph

`Graph.build` walks the declaration once, evaluating each flow body and each
builder exactly once against those placeholders:

```ts
const graph = Graph.build(plan)

for (const node of Graph.nodes(graph)) {
  console.log(`${node.id} (${node.kind})`)
}
```

```text
root.andThen.all.api.flow (Succeed)
root.andThen.all.api (FlowCall)
root.andThen.all.cli.flow (Succeed)
root.andThen.all.cli (FlowCall)
root.andThen (All)
root.then.flow (Succeed)
root.then (FlowCall)
root (AndThen)
```

Node ids are structural: a node's id is its position in the declaration, so the
same declaration always produces the same ids. A `FlowCall` node and the
`.flow` node under it are the call and the body it entered. The nodes arrive in
dependency order, so a step appears after everything it depends on.

## Read the edges

```ts
for (const edge of Graph.edges(graph)) {
  console.log(`${edge.from} -> ${edge.to} [${edge.reason}]`)
}
```

```text
root.andThen.all.api.flow -> root.andThen.all.api [value]
root.andThen.all.api -> root.andThen [value]
root.andThen.all.cli.flow -> root.andThen.all.cli [value]
root.andThen.all.cli -> root.andThen [value]
root.andThen -> root [value]
root.andThen -> root.then [continuation]
root.then.flow -> root.then [value]
root.then -> root [value]
```

The two reviews depend on nothing and on each other in no way, so a scheduler
may run them at the same time. The `continuation` edge is the bind: the report
cannot start until the join settles.

## Check for problems

`Graph.build` records declaration problems rather than throwing them, so an
invalid plan stays inspectable. Check `diagnostics` before you trust a graph:

```ts
console.log(Graph.diagnostics(graph).length) // 0
```

`@smthrs/flow` documents every code a build records and which of them are fatal,
and `Graph.drafts` refuses a graph carrying a fatal one rather than compiling a
plan the builder called invalid.

## Declare work this package does not implement

An action declares work a host implements. Its call returns the same node model
a flow body composes:

```ts
import { Action } from "@smthrs/flow"
import { Effect } from "effect"

const Fetch = Action.make("fetch", {
  payload: Schema.Struct({ url: Schema.String }),
  success: Schema.String,
  capabilities: ["net"],
  tier: "irreversible"
})

const layer = Fetch.toLayer(({ url }) => Effect.succeed(`body of ${url}`))
```

`Fetch.call({ url })` plans the same way `Review.call` does. What changes is
where the work comes from: a flow body composes nodes, and an action is code a
host supplies through a layer.

## What just happened

You wrote a declaration and got back a complete plan: eight nodes, eight edges,
and one dependency reference, without executing a single step. That is the
contract this package exists to provide, and it is what lets the layers above
it cache, resume, schedule, and place work.

## Next steps

- [Plan time](/concepts/plan-time/): what `Graph.build` does, and the
  placeholder rules that come with it.
- [Identity and key material](/concepts/identity/): what makes two
  declarations the same step.
- [Declare what a step reads and writes](/guides/declare-reads-and-writes/):
  effect envelopes, narrowing, and write conflicts.
