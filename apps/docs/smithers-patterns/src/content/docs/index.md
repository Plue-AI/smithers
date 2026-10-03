---
title: "@smthrs/patterns"
description: "Higher-order patterns for agent flows: review loops, escalation ladders, sagas, merge queues, and model-authored delegation, each declared as a graph before any of it runs."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/patterns/docs/README.md"
---

`@smthrs/patterns` is a library of the shapes multi-step agent work keeps
taking. Revise a draft until a reviewer approves it. Try the cheap model, then
escalate to the expensive one. Run twenty checks at a bounded concurrency and
reduce them to one verdict. Unwind a half-finished deploy step by step. Each
shape is one call over flows or Effects you supply.

## The problem it solves

An agent loop is easy to write once and tedious to write well every time. The
bound, the stopping rule, what happens when the bound runs out, which failures
isolate and which ones halt the siblings beside them: each is a decision, and
each one is where a hand-rolled loop goes wrong.

The harder half is that something outside the loop usually has to read the work
before it happens. A budget wants the call count. A reviewer wants to know
whether this run can write to disk. A scheduler wants to start two independent
calls together. None of that can read a loop written as behavior, because a
loop written as behavior does not exist until it has already run.

Every pattern here answers both halves, and exports one function for each:

- `make` returns a flow whose body declares the conservative topology: every
  round the bound allows, every rung of a ladder, every compensation, whether
  or not a given run reaches it. [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) builds that into a
  graph you can count, cost, and review before anything happens.
- `run` returns an Effect that performs the branch a declaration cannot. It
  stops at the round the reviewer approved and skips what the topology
  reserved.

## Install

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

The package
needs Node.js 26.4.0 or later. It shares its `effect` peer with the host,
depends on [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) and [`@smthrs/plan`](https://plan.smithers.sh/reference/api/), and
imports no Node built-ins.

## Revise a draft until a reviewer approves it

`ReviewLoop` produces something, reviews it, revises it, and stops at the first
round the review approves:

```ts
import { ReviewLoop } from "@smthrs/patterns"
import * as Effect from "effect/Effect"

interface Review {
  readonly approved: boolean
  readonly note: string
}

// Your own two model calls. Each returns an Effect.
declare const draft: (goal: string) => Effect.Effect<string>
declare const critique: (notes: string) => Effect.Effect<Review>

const result = await Effect.runPromise(
  ReviewLoop.run("Write the release notes for 1.0.", {
    maxRounds: 3,
    produce: draft,
    review: critique,
    revise: ({ output, review }) => draft(`${output}\n\nThe reviewer asked for: ${review.note}`)
  })
)

if (result._tag === "Approved") {
  console.log(result.output)
} else {
  console.log(`Three rounds and still not approved: ${result.review.note}`)
}
```

The bound is the point. A review loop that never gives up is a run that never
ends, so `run` returns an explicit `{ _tag: "Approved", output }` or
`{ _tag: "Exhausted", output, review }`, and the caller decides what an
unapproved draft is worth. The draft is nested under `output` on both arms, so
a produced value can never be mistaken for the outcome that carries it. `ReviewLoop.accepted` reads the same four
acceptance shapes every pattern in the package accepts: `true`, `"approved"`,
`{ approved: true }`, and `{ accepted: true }`.

## Read the plan before it runs

The same loop, declared instead of executed, is a graph:

```ts
import { Flow, Graph } from "@smthrs/flow"
import { ReviewLoop } from "@smthrs/patterns"

declare const draftFlow: Flow.Any
declare const reviewFlow: Flow.Any
declare const reviseFlow: Flow.Any

const loop = ReviewLoop.make({
  produce: draftFlow,
  review: reviewFlow,
  revise: reviseFlow,
  maxRounds: 3
})

const graph = Graph.build(loop, { input: "Write the release notes for 1.0." })
console.log(Graph.nodes(graph).filter((node) => node.kind === "FlowCall").length)
```

```text
6
```

Six calls: one draft, three reviews, and the two revisions between them. That
is the worst case rather than the likely one, which is the honest answer to
"how much could this cost". Nothing has run. The same graph carries what each
call reads and writes, where it should run, and the key material that gives
each step a stable identity.

## Choose a pattern

| Shape                                                                   | Patterns                                                                   | Reference                     |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------- |
| Repeat until something is true, or until a score is high enough         | `Loop`, `Optimizer`, `ScanFixVerify`, `DriftDetector`, `Sidecar`           | [Loops](/loops/)           |
| Get a second opinion, then settle what it says                          | `Debate`, `Panel`, `ReviewLoop`                                            | [API reference](/reference/api/)     |
| Try one strategy, then a stronger one, then ask a person                | `Escalation`                                                               | [API reference](/reference/api/)     |
| Fan out, bound the concurrency, and decide what a failure interrupts    | `Bounded`, `Quarantine`, `MapReduce`, `Recursion`                          | [API reference](/reference/api/)     |
| Recover, clean up, and undo                                             | `TryCatchFinally`, `Saga`                                                  | [API reference](/reference/api/)     |
| Coordinate several agents as a team, with approvals and a landing order | `Supervisor`, `Intervene`, `CheckSuite`, `Kanban`, `Runbook`, `MergeQueue` | [Teams](/teams/)           |
| Claim and work every backlog item that is ours, round after round       | `Burndown`                                                                 | [Burndown](/burndown/)     |
| Run a plan a model wrote, inside bounds it cannot widen                 | `Trellis`, `DelegationChain`                                               | [Delegation](/delegation/) |
| Wrap one flow with retries, a cache policy, or an approval              | `WithRetry`, `WithCache`, `WithApproval`, `Pattern`                        | [API reference](/reference/api/)     |

The [module index](/modules/) lists all 29 modules with their import
specifiers.

## How this fits with @smthrs/flows

What `make` returns is an [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) flow: inert data that
describes work. [`@smthrs/flows`](https://flows.smithers.sh/reference/api/) is the package that runs work for
real, one barrel over the durable flow engine, its journal, its run store, its
step cache, and its sandboxing. Reach for this package to say what the shape of
the work is, and for that one to execute the work and survive a crash while it
happens.

The two meet at execution. A `run` half is an ordinary Effect, so it runs
inside a durable step like any other Effect. When each round has to survive a
crash on its own, hand the round to the trampoline `@smthrs/flows` re-exports
from [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) instead of unrolling the loop inside one
execution: [the durable round recipe](/loops/#the-durable-round-recipe)
shows both forms side by side.

`@smthrs/patterns` is not re-exported by `@smthrs/flows`. Install it directly,
even when you already depend on the barrel. The patterns compose the plan-time data model alone, which is what lets
a linter, a catalog server, a browser tab, or a unit test declare one and read
it back with no engine anywhere in the tree.

Both sit under the `smithers` command line tool, [`@smthrs/cli`](https://cli.smithers.sh/reference/api/),
which runs, resumes, and inspects flows from a terminal. If you arrived here
from a dependency list and want the product rather than one of its libraries,
start there.

## Where to go next

- [API reference](/reference/api/): the two halves of a pattern, string identity and
  ownership, the three error types, and every module the pages below do not
  cover.
- [Module index](/modules/): all 29 modules, their import specifiers, and
  where each one is documented.
- [Loops](/loops/): `Loop`, `Optimizer`, `ScanFixVerify`, `DriftDetector`,
  and `Sidecar`, plus why a declaration cannot branch on a value.
- [Teams](/teams/): the six patterns that coordinate several agents, their
  approval gates, and their landing order.
- [Burn down a backlog](/burndown/): `Burndown` applied to GitHub issues,
  with claims, a capacity gate, and durable children.
- [Delegation](/delegation/): `Trellis` and `DelegationChain`, the two
  patterns that admit and execute a plan a model wrote.
