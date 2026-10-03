---
title: "Quickstart"
description: "Run your first model-backed step: declare a typed research step, script the model, compose the layers, and read a typed result with no API key."
sidebar:
  order: 2
---

This quickstart runs one model-backed step end to end. The agent loop is the
production one; only the model is scripted, so the run is deterministic and
needs no API key. By the end you will have a step whose answer arrives as a
typed value, decoded by the schema you declared.

A runnable version of this walkthrough lives in the Smithers repository, as
[`examples/src/11-agent-step.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/11-agent-step.ts).

## Prerequisites

- Node.js 26.4.0 or later.
- A package with the dependencies installed. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

## Declare the step and the flow

Create `quickstart.ts`. The step is an ordinary action with a declared output
schema; the implementation ships with the declaration as `.layer`:

```ts
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import * as Schema from "effect/Schema"

const ResearchResult = Schema.Struct({
  summary: Schema.String,
  keyPoints: Schema.Array(Schema.String)
})

/** The step: a model call whose answer must be a ResearchResult. */
export const Research = AgentAction.make("quickstart/Research", {
  payload: { topic: Schema.String },
  output: ResearchResult,
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You are a research assistant. Provide concise, accurate summaries."],
  prompt: ({ topic }) => `Research the topic "${topic}" and report what matters about it.`
})

/** The flow: one step, so the result is ResearchResult-typed all the way out. */
export const ResearchFlow = Flow.make("quickstart/ResearchFlow", {
  payload: { topic: Schema.String },
  success: ResearchResult,
  error: AgentAction.AgentFailure,
  body: ({ topic }) => Research.call({ topic })
})
```

The `seat` string is a declaration, not a credential. Nothing here names an API
key; resolving the string into a live model is the host's job, which is the
next piece.

## Script the model and the seat

A test seat answers with a scripted model that emits one fenced `cell` block.
A cell states its intent by calling `ctx.done(output)`; the host renders the
structured output as canonical JSON, which is the text the declared schema
decodes:

````ts
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

const prepared: Route.PreparedRequest = {
  routeId: "quickstart",
  protocolId: "quickstart",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const scripted: Model.Model = Model.make({
  stream: () => {
    const answer = {
      summary: "Durable workflows record every step so a restart resumes instead of repeating.",
      keyPoints: ["steps are journaled", "replay is deterministic"]
    }
    const cell = `ctx.done(${JSON.stringify(answer)})`
    return Stream.fromIterable([
      ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
      ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
      ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
      ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
    ])
  }
})

/** Every declared seat resolves to the scripted model. */
const seats = SeatResolver.layer({
  resolve: (id) =>
    Effect.succeed(
      Seat.make({
        id,
        modelId: "test-model",
        model: scripted,
        route: { prepare: () => Effect.succeed(prepared) },
        contextWindowTokens: 200_000
      })
    )
})
````

This resolver is the only seam between the deterministic run and a live one. A
production resolver answers with a provider route and a real context window;
nothing above it changes. For that, see
[Resolve seats into live models](./guides/seat-resolvers.md).

## Compose the layers

The host carries the registry a cell may call into and the sandbox budget every
model-backed action in the composition shares. The composition names the action
once, because `AgentAction.make` returns the declaration and its `.layer`
together:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Agent from "@smthrs/agent/Agent"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import * as Registry from "@smthrs/registry/Registry"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"

const host = AgentAction.layerHost({
  registry: Registry.makeNoop({
    list: () => Effect.succeed([]),
    visible: () => Effect.succeed([]),
    getOption: () => Effect.succeed(Option.none())
  }),
  limits: { calls: 8 },
  capabilityEnvelope: [],
  maxFrames: 4
})

const layer = Layer.mergeAll(
  Research.layer,
  Interpreter.layer(ResearchFlow)
).pipe(
  // The agent itself is the production loop; only the host services around it
  // are scripted.
  Layer.provideMerge(Layer.mergeAll(host, seats, Agent.layer)),
  // This standalone composition has no approved envelope from which to derive
  // a spend ceiling, so it says so explicitly.
  Layer.provideMerge(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded())),
  // The QuickJS sandbox a cell runs in and the steering source it drains.
  Layer.provideMerge(Agent.layerDefaults),
  // This offline run judges completion with the scripted fixture.
  Layer.provideMerge(ScriptedJudge.layer),
  // Ordinary flow composition: action implementations, a durable engine, crypto.
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)
```

Both policies are required by the type of `Agent.layer`. A composition that
means to enforce nothing says so in writing, here with
`Budget.layerUnbounded()`. For what the two policies do when armed, see
[Park on quota refusals and limit model admission](./guides/quota-and-budgets.md).

## Run it

Execute the flow and print the typed result:

```ts
export const main: Effect.Effect<typeof ResearchResult.Type> = ResearchFlow.execute(
  { topic: "durable workflows" },
  { executionId: "quickstart-1" }
).pipe(
  Effect.provide(layer),
  Effect.orDie
)

console.log(await Effect.runPromise(main))
```

Run the file with your TypeScript runner. The output is the decoded
`ResearchResult`:

```text
{
  summary: 'Durable workflows record every step so a restart resumes instead of repeating.',
  keyPoints: [ 'steps are journaled', 'replay is deterministic' ]
}
```

## What just happened

One `Research.call` ran a whole cell loop: the model produced a cell, the cell
ran in the QuickJS sandbox, and its `ctx.done` answer was decoded by
`ResearchResult`. Had the answer missed the schema, the step would have spent
its correction budget on a re-prompt before failing with a typed
`StructuredOutputFailure`. The model call itself is a sealed durable step, so a
replay of this execution re-emits the recorded events instead of asking the
provider again.

## Next steps

- [Shape a model's answer into typed output](./guides/structured-output.md):
  corrections, repair, and the rejection record.
- [Test a model-backed step](./guides/testing.md): the same scripted pattern as
  a test habit.
- [Run the agent as a control-plane run](./guides/control-plane-runs.md): the
  same loop with an operator steering and approving it.
