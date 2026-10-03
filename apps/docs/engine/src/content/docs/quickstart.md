---
title: "Quickstart"
description: "Run one flow on the in-memory engine end to end, then submit the same execution id twice and prove the second submission replays the recorded result instead of re-running the work."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine/docs/quickstart.md"
---

This builds one runnable file. It declares a flow, runs it on
`FlowEngine.layerMemory`, and then submits the same execution id a second time
to show what the engine records. Nothing is written to disk and no store is
configured.

## Before you start

Install the packages and a crypto service. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

`@effect/platform-node` supplies the runtime `Crypto` service used by every
action dispatch, so install it in your application's `dependencies`.

## Declare the action and the flow

An action is the atom that does the work. It declares schemas and a stable
name, and carries no code. A flow is the composite: its `body` names actions
rather than calling them, because a body is planned before it is run.

```ts
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Schema from "effect/Schema"

const Compile = Action.make("build/Compile", {
  payload: { target: Schema.String },
  success: Schema.String
})

const Build = Flow.make("build/Build", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: (payload) => Compile.call(payload)
})
```

`Compile.call(payload)` records one plan node. It executes nothing.

## Compose the engine

The implementation is attached separately, where code can run. Four layers make
a runnable composition, and each answers one of the requirements
[Installation](/installation/) lists:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

let compiles = 0

const BuildLayer = Layer.mergeAll(
  Compile.toLayer(({ target }) =>
    Effect.sync(() => {
      compiles = compiles + 1
      return `${target}.js`
    })
  ),
  Interpreter.layer(Build)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)
```

The counter is the point of the exercise: it is the only way to tell a replay
from a re-run.

## Run it twice under one execution id

`executionId` is caller-supplied identity, not a handle the server mints. The
same id names the same run:

```ts
const program = Effect.gen(function*() {
  const first = yield* Build.execute({ target: "app" }, { executionId: "build-app-1" })
  const second = yield* Build.execute({ target: "app" }, { executionId: "build-app-1" })
  return { first, second, compiles }
}).pipe(Effect.orDie, Effect.provide(BuildLayer))

Effect.runPromise(program).then(console.log)
```

Run the file. It prints:

```text
{ first: 'app.js', second: 'app.js', compiles: 1 }
```

## What just happened

The second submission did not run a second build. It joined the run that
already owned `build-app-1` and answered with that run's recorded result, which
is what makes a retried submission safe: a client that times out and resubmits
gets the first answer rather than a second compile.

Two identities did that work, and they are worth separating:

- The execution id names the run. Reusing it joins; reusing it for a different
  flow or a different payload is refused with `ExecutionIdentityConflict`. See
  [Execution identity](/concepts/execution-identity/).
- A derived step key names the dispatch of `Compile` inside the run, which is
  what the engine looks up before dispatching again. See
  [Step identity](/concepts/step-identity/).

`Effect.orDie` is there because `execute` fails typed when a payload does not
satisfy the flow's schema. This payload is statically valid, so a refusal would
be a defect in the program rather than an error a caller handles.

## Where to go next

- Keep the state after the process exits: swap `FlowEngine.layerMemory` for the
  durable engine in [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/). Nothing above
  that line changes.
- Run the flow from another process:
  [Serve flows over RPC or HTTP](/guides/serve-flows/).
- Understand what the engine is:
  [The port and the seam](/concepts/port-and-seam/).
