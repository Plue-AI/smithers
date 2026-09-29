---
title: "Add a model-backed step to a flow"
description: "Declare an AgentAction with a typed output, compose the host and the policies, and watch the step's events as it runs."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/docs/guides/model-backed-steps.md"
---

A model call is an ordinary action. `AgentAction.make` declares one with the
same tag, payload schema, `.call()`, plan node, and durable replay as any other
action, and ships the implementation with it: you never write `toLayer` for a
model call, because there is exactly one implementation, the agent loop.

This guide is the composition reference for that step. For a runnable first
success, start with the [Quickstart](/quickstart/).

## Declare the step

```ts
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Schema from "effect/Schema"

const Research = AgentAction.make("docs/Research", {
  payload: { topic: Schema.String },
  output: Schema.Struct({ summary: Schema.String }),
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You are a research assistant."],
  prompt: ({ topic }) => `Research ${topic}.`
})
```

The four decisions every declaration makes:

- `output` is the schema the answer must satisfy. It is rendered into the run's
  system teaching and enforced against the run's final answer.
- `seat` is an opaque string the host's `SeatResolver` resolves. The resolver
  owns the vocabulary, so `anthropic:claude-sonnet-4-5`, a bare model id, and a
  logical name like `reviewer` are all legal declarations. `seat: "auto"`, or a
  seat function that returns it, routes once per execution: Jev classifies the
  task's phase, size, clarity, and binary success, and the routing graph picks
  the seat and its backups from the host's `SeatRouter.Catalog`. `phase` pins
  the phase so Jev is not asked it. An important plan or review routes to a
  panel: the step runs on Opus, Fable, and Astra in parallel, each with its own
  backups, then Fable merges their answers. A member that fails is named to
  the merger and left out; the step fails only when no member answers.
  Corrections and the repair reuse the routed seat unless `repair.seat` names
  one.
- `prompt` builds the task from the decoded payload.
- `system` is stable teaching for this step, placed after the host's and before
  the schema's.

Optional bounds are `corrections`, `repair`, `modelParams`, and `maxFrames`.
For the correction ladder and the repair slot, see
[Shape a model's answer into typed output](/guides/structured-output/).

## Call it from a flow

The declaration is an ordinary action in the graph:

```ts
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"

export const SimpleWorkflow = Flow.make("docs/SimpleWorkflow", {
  payload: { topic: Schema.String },
  success: Schema.Struct({ article: Schema.String }),
  error: AgentAction.AgentFailure,
  body: ({ topic }) =>
    Research.call({ topic }).pipe(
      Node.bindPlanned((research) => Write.call({ summary: research.summary }))
    )
})
```

`research.summary` is a `string` here, not text somebody has to parse, because
the step owes its caller one decoded value.

## Compose the host and the policies

`AgentAction.layerHost` provides the composition every model-backed action in a
run shares. Only `registry` and `limits` are required; the rest are
composition-wide defaults:

```ts
const host = AgentAction.layerHost({
  registry,
  limits: { calls: 8 },
  capabilityEnvelope: [],
  maxFrames: 4,
  defaultCorrections: 2
})
```

The composition stacks, from the inside out:

1. The action's own `.layer` and the flow's `Interpreter.layer`.
2. `AgentAction.layerHost(...)`, a `SeatResolver`, and `Agent.layer`.
3. The two policies, which are required: `QuotaPolicy.layerDefault()` and a
   `Budget` layer. A composition that means to enforce nothing says so with
   `QuotaPolicy.layerUnclassified()` and `Budget.layerUnbounded()`; omitting
   either is a type error.
4. `Agent.layerDefaults`, the QuickJS sandbox and an empty steering source.
5. An `Evaluator` chosen by the host. The offline quickstart uses
   `ScriptedJudge.layer` to judge completion.
6. Ordinary flow composition: `Action.layerImplementations`, a durable engine
   such as `FlowEngine.layerMemory`, and a crypto service.

The complete listing is in the [Quickstart](/quickstart/#compose-the-layers),
and the field-by-field tables are in the
[API reference](/reference/api/#agentactionhost).

## Watch the step run

A step answers with one decoded value, which it only knows at the end. Provide
`EventSink` to receive the emitted agent events: token deltas, the produced
cell, and its calls. With `FlowEngineLike`, model deltas arrive at the sealed
model-call boundary, after the provider stream settles. The adapter records
the complete provider stream before emitting those events; they do not report
live provider progress. A replay emits the recorded events again without
calling the provider:

```ts
import { EventSink } from "@smthrs/agent"
import * as Effect from "effect/Effect"

const watched = Layer.merge(
  layer,
  EventSink.layer({ emit: (event) => Effect.sync(() => render(event)) })
)
```

The step still buffers every event for the decode, so the answer, the
correction budget, and the failures are the same with a sink as without one.
One rule governs a sink: `emit` runs inside the frame that produced the event,
and that frame holds the engine's write transaction. Push onto a queue, write
to a socket, or resolve a deferred. A sink that waits on a durable write
stalls the run.

## Handle the failures

A step fails with a member of `AgentAction.AgentFailure`:

- `StructuredOutputFailure`: the model answered and the answer did not fit the
  schema after its correction budget. This is the one an author handles.
- `SeatUnresolved`: the host has no model for the declared seat.
- `SeatUnrouted`: Jev could not answer for `auto`, the host binds no catalog
  (`unconfigured`), or no seat the graph picked is available (`no_candidates`).
- `BudgetExceeded` and `Budget.Skipped`: the run has spent what it was approved
  for. See [Park on quota refusals and limit model admission](/guides/quota-and-budgets/).
- `HarnessError` and `PluginError`: the composition failed underneath the step.

Provider refusals do not reach the caller as-is. The model boundary runs a
bounded transport retry ladder (five jittered retries inside a 45-second
window by default), a quota-shaped refusal parks the step instead of failing
it, and a terminal model error arrives inside the `HarnessError` cause with its
code and reset fields intact.
