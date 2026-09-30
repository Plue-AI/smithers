---
title: "@smthrs/core"
description: "Metadata and compatibility adapters over canonical @smthrs/flow declarations."
---

`@smthrs/core` provides metadata and compatibility adapters over
[`@smthrs/flow`](/api/flow). New declarations use that package's tagged
`Flow.make(tag, { payload, success, body })`; the Core options-object constructor
is deprecated. A call constructs a node, and `Graph.build` describes its steps,
dependencies, effect claims, and placement without executing those steps.

JavaScript and TypeScript declarations and all planning callbacks must be
trusted. `Graph.build` executes flow bodies, continuation builders, recovery
callbacks, and an optional `resolveLayers` callback in the caller process with
its ambient authority. Purity is a caller obligation. Placement, capability,
and effect metadata does not sandbox planning, even with sandbox placement,
no capabilities, and sealed effects.

Accept agent-generated declarations through a constrained data-only format
that trusted code validates and translates into nodes. If untrusted code must
be planned, load and plan it in an externally isolated environment with
restricted permissions and resources. See [Plan time](./concepts/plan-time.md#planning-requires-trusted-declarations)
for the trust boundary.

## The problem it solves

Multi-step agent work is usually written as behavior: a function calls a model,
writes a file, then decides what to call next. Nothing outside the process knows
the shape of that work until it has already happened, and several useful things
become impossible at once.

- A cache cannot recognize a step it has already run.
- A resumed run cannot tell which steps finished before the crash.
- A scheduler cannot start two independent steps together.
- A reviewer cannot see what a generated plan will touch before it touches it.
- A sandbox cannot be provisioned for a step nobody has described yet.

Each of those needs the same thing: the work described in advance, in a form
that is inspectable and comparable. Building that description is this package's
whole job. Reach for it when something has to read a plan before the plan runs,
whether that something is a durable engine, a policy check, a cost estimate, a
diagram, or a test.

## Install

Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

The package needs Node.js 26.4.0 or later. It has no platform bindings, so the
same build runs in Node, in Bun, in a browser, and in a Cloudflare Worker.

## Declare a step before it runs

An action has a required tag and a struct payload:

```ts
import { Effects, Graph } from "@smthrs/core"
import { Action } from "@smthrs/flow"
import { Effect, Schema } from "effect"

const review = Action.make("review/file", {
  payload: Schema.Struct({ path: Schema.String }),
  success: Schema.String,
  capabilities: ["fs"],
  effects: Effects.make({
    reads: ["src/**"],
    writes: ["out/report.md"],
    mode: "hermetic",
    onConflict: "serialize"
  })
})

// What a host attaches the implementation to.
const layer = review.toLayer(({ path }) => Effect.succeed(`reviewed ${path}`))

// What a caller records, and what a planner reads.
const graph = Graph.build(review.call({ path: "src/api.ts" }))
```

The graph holds the explicit action call the author wrote. The capability ceiling, the effect envelope, and the placement
travel as annotations on both, which is how a planner orders two writers of one
path and how a reviewer sees what a step will touch before a model is called.
`@smthrs/flow` owns that analysis and documents its refusals.

## How this fits with @smthrs/flows

`@smthrs/flow` is the canonical authoring surface. [`@smthrs/flow`](/api/flow) owns the
flow, the action, the node calls, and the graph builder a signature lowers to,
and [`@smthrs/flows`](/api/flows) is the barrel over the durable engine that
runs them: the journal, the run store, the step cache, the plan store, and
sandboxing. `@smthrs/plan` compiles a graph's key material into step keys,
substituting each dependency's digest for the graph-local reference. That key is
how a resumed run recognizes a step it already finished.

The split is a dependency direction rather than a diagram. This package retains a deprecated options-object adapter, the metadata
projections above, and Markdown lowering; it holds
no second node model, no second graph builder, and no evaluator of its own.
Unlike the engine packages, `@smthrs/core` is not re-exported by
`@smthrs/flows`: install it directly, even when you already depend on the
barrel.

Both sit under the `smithers` command line tool, [`@smthrs/cli`](/api/cli),
which runs, resumes, and inspects flows from a terminal. If you arrived at this
package from a stack trace or a dependency list and want the product rather than
its data model, start there.

## Where to go next

- [Installation](./installation.md): runtime requirements, the two import forms,
  what the export map keeps private, and the packages that sit above this one.
- [Quickstart](./quickstart.md): declare two signatures, plan them, and read
  back the topology and the dependency references.
- [Plan time](./concepts/plan-time.md): which declarations must be trusted,
  what `Graph.build` evaluates, and the placeholder rules that come with it.
- [Identity and key material](./concepts/identity.md): what makes two
  declarations the same step, and what `Node.capture` fixes.
- [Effect envelopes](./concepts/effects.md): how a step declares its reads and
  writes, and what the planner does with two writers of one path.
- [Declare a flow](./guides/declare-a-flow.md): the constructor and its
  combinators, option by option.
- [Declare reads and writes](./guides/declare-reads-and-writes.md): the envelope
  a step runs under, and what two writers of one path cost.
- [API reference](./api.md): every export of all nine modules.
- [Troubleshooting](./troubleshooting.md): every failure this package throws or
  records, with its cause and its fix.
