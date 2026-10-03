---
title: "Declare a flow"
description: "Declare a tagged flow with the canonical @smthrs/flow constructor and an explicit action implementation."
sidebar:
  order: 1
---

New declarations use `Flow.make(tag, options)` from `@smthrs/flow`. The first
argument is the required tag. The payload is a struct schema, and the body
returns nodes in the one shared plan model. A call records a node; it does not
execute the body.

```ts
import { Node } from "@smthrs/core"
import { Flow } from "@smthrs/flow"
import * as Schema from "effect/Schema"

const Review = Flow.make("review", {
  description: "Reviews one file and reports whether it passes.",
  payload: Schema.Struct({ path: Schema.String }),
  success: Schema.Struct({ approved: Schema.Boolean, notes: Schema.String }),
  body: Node.capture(
    {},
    ({ path }: { readonly path: string }) => Node.succeed({ approved: true, notes: `reviewed ${path}` })
  )
})

const call = Review.call({ path: "src/api.ts" })
```

## Declaration options

| Option         | Purpose                                                      |
| -------------- | ------------------------------------------------------------ |
| `payload`      | Struct schema for every call's input.                        |
| `success`      | Schema for a successful result.                              |
| `error`        | Schema for typed failure; defaults to `Schema.Never`.        |
| `description`  | Catalog description.                                         |
| `capabilities` | Declared capability ceiling; omission inherits, `[]` denies. |
| `effects`      | Reads, writes, mode, conflict policy, and tier.              |
| `body`         | Function returning the declaration's node.                   |
| `annotations`  | Typed metadata shared by the flow and planner.               |

See the [canonical reference](/api/flow) for execution, retry, and deadline
options. `Node.capture` records inert captures for callback identity that can
survive a restart; an uncaptured callback has process-local identity.

## Work a host implements

An `Action.make` declaration names an implementation a host supplies through
`toLayer`. A flow can compose that action's call:

```ts
import { Action } from "@smthrs/flow"
import * as Effect from "effect/Effect"

const Summarize = Action.make("summarize", {
  payload: Schema.Struct({ text: Schema.String }),
  success: Schema.String,
  tier: "irreversible"
})

const layer = Summarize.toLayer(({ text }) => Effect.succeed(text.slice(0, 80)))
const summaryCall = Summarize.call({ text: "One explicit declaration." })
```

A tier alone does not grant cacheability. Content sharing requires the action's
explicit idempotency key and implementation-version contract.

## Primitive values belong in a payload field

```ts
const Length = Flow.make("length", {
  payload: Schema.Struct({ input: Schema.String }),
  success: Schema.Number,
  body: Node.capture({}, ({ input }: { readonly input: string }) => Node.succeed(input.length))
})

Length.call({ input: "four" })
```

A struct schema, including `Schema.Class`, can be the payload directly. Calls
accept its constructor input.

## Metadata and compatibility

Set `capabilities` and `effects` in the canonical declaration. Use its
`annotate` and `annotateMerge` methods for typed metadata:

```ts
import { Placement } from "@smthrs/core"

const Placed = Review.annotate(Flow.Placement, Placement.sandbox({ image: "node:26" }))
```

Placement metadata does not sandbox planning code. See
[Plan time](../concepts/plan-time.md) for the trust boundary.

## Where to go next

- [Declare what a step reads and writes](./declare-reads-and-writes.md).
- [Load an Agent Skill](./load-an-agent-skill.md).
