---
title: "Quickstart"
description: "Declare an action and a flow, compose the layers, run the flow on the in-memory engine, and read a typed result."
sidebar:
  order: 2
---

This quickstart runs one flow end to end on the in-memory engine. Nothing here
touches a database or the network, and the result arrives as a typed value
decoded by the schema you declared.

A runnable copy of this program is published in the Smithers examples,
[`01-define-and-run.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/01-define-and-run.ts).

## Prerequisites

- Node.js 26.4.0 or later.
- A package with the dependencies installed. Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

## Declare the action and the flow

Create `quickstart.ts`. `Action.make` with a string tag is the declared form:
schemas and a stable name, no code.

```ts
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Schema from "effect/Schema"

export const Greet = Action.make("examples/Greet", {
  payload: { name: Schema.String },
  success: Schema.String
})

export const Greeting = Flow.make("examples/Greeting", {
  payload: { name: Schema.String },
  success: Schema.String,
  body: Node.capture(
    { action: Greet.name, implementationVersion: "greeting/v1" },
    (payload) => Greet.call(payload)
  )
})
```

`Greet.call(payload)` records one node and runs nothing. It also puts a
requirement in the node's type, which `Flow.make` reads off the body: the flow
now says in its own type that it names an implementation it does not carry.

## Attach the implementation and compose the layers

`Node.capture` declares every semantic value outside the callback source. Here
it names the action and versions the imported behavior. Change that version when
that behavior changes. JavaScript cannot verify capture completeness.

`toLayer` is where the code lives. `Interpreter.layerWithImplementations`
registers the flow and its implementations with stable callback admission. It
refuses uncaptured callbacks before dispatch. The lower-level `Graph.build` and
`Interpreter.layer` default to `process-local`, which makes no cross-process
callback identity guarantee.

Compose the layers:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const GreetingLayer = Interpreter.layerWithImplementations(
  Greeting,
  Greet.toLayer(({ name }) => Effect.succeed(`Hello, ${name}.`))
).pipe(
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)
```

`layerWithImplementations` supplies the action registry while building the
implementation layers. The remaining providers supply the runtime and digest:

- `FlowEngine.layerMemory` supplies the `FlowRuntime` port. Swap it for the
  durable engine from [`@smthrs/engine-store`](/api/engine-store) and nothing
  above changes.
- `NodeCrypto.layer` supplies `Crypto`. Every dispatch is recorded under a
  derived step identity, so the engine needs a digest even in memory.

## Run it

`execute` takes the payload and an execution id:

```ts
export const main: Effect.Effect<string> = Greeting.execute(
  { name: "Ada" },
  { executionId: "greeting-ada-1" }
).pipe(
  // A payload that misses the flow's schema is a typed failure, not a defect.
  // This payload is statically valid, so a refusal here would be a bug.
  Effect.orDie,
  Effect.provide(GreetingLayer)
)

console.log(await Effect.runPromise(main))
```

Run the file with your TypeScript runner. The output is the decoded success
value:

```text
Hello, Ada.
```

## Run it twice

Execute the same flow again under the same execution id. The action does not run
a second time:

```ts
export const twice: Effect.Effect<string> = Effect.gen(function*() {
  const run = Effect.orDie(
    Greeting.execute({ name: "Ada" }, { executionId: "greeting-ada-1" })
  )
  yield* run
  return yield* run
}).pipe(Effect.provide(GreetingLayer))
```

An execution id names one run. The second call finds the run that already
settled and answers with its result instead of starting another, and a durable
engine behaves the same way across a restart: it rebuilds the plan, derives the
same key for the same node, reads the recorded result, and reaches only the
steps that never settled. That is what separating the plan from the code buys.
Identity is a function of the declaration, so a repeat is a read.

An execution id is also a claim about what the run is. Reusing one for a
different flow, or for a different payload, is refused rather than silently
joined.

## What just happened

`Greeting.execute` asked the runtime for an execution under
`greeting-ada-1`. The interpreter built the graph of the body, walked it, and
dispatched `examples/Greet` through the engine, which recorded the attempt and
its result. With a pure body, complete captures, and stable callback admission,
unchanged source, captures, declarations, and payload reproduce the same plan
keys across processes. Changed source, captures, or implementation versions
require a newly planned run.

## Next steps

- [Flows and actions](./concepts/flows-and-actions.md): why the implementation
  attaches separately, and what the requirement channel buys you.
- [Build a body](./guides/build-a-body.md): sequencing, fan-out, branches, and
  recovering from a typed failure.
- [Testing](./testing.md): the same in-memory composition as a test habit.
