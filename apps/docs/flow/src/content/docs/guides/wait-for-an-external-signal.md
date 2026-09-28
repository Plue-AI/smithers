---
title: "Wait for an external signal"
description: "Park a round on a named wait point, resolve it from another process with a completion token, and use durable deferreds directly."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/flow/docs/guides/wait-for-an-external-signal.md"
---

A run often has to wait for something that is not time and not a step: an
approval, a webhook, a human closing a ticket. `WaitFor.action` is that wait as an
ordinary plan node, and a `DurableDeferred` token is how the outside world
resolves it.

## Park the body on a named wait point

```ts
import { Action, Flow, Interpreter, WaitFor } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const Deploy = Action.make("release/Deploy", {
  payload: { build: Schema.String },
  success: Schema.String
})

export const Ship = Flow.make("release/Ship", {
  payload: { build: Schema.String },
  success: Schema.String,
  error: WaitFor.WaitForRequestInvalid,
  body: ({ build }) =>
    WaitFor.action.call({ name: "ship" }).pipe(
      Node.andThen(Deploy.call({ build }))
    )
})

export const layer = Layer.mergeAll(
  WaitFor.layer,
  Deploy.toLayer(({ build }) => deployBuild(build)),
  Interpreter.layer(Ship)
).pipe(Layer.provideMerge(Action.layerImplementations))
```

The implementation parks the execution under the `event` waiting reason, carrying
the wake token a completion is matched against, and settles with whatever value
resolved the wait. `WaitFor.action` succeeds with `Schema.Json`, so decode the
answer with a schema when you need a typed value.

`WaitFor.layer` is required in the composition for the same reason `Sleep.layer`
is: the node is a system declaration, so the compiler does not ask for it, but
the run does.

## Resolve it from outside

`WaitFor.deferred(name)` is the resolver's half of the same wait point. Derive
the token from the flow and the execution id, then complete it:

```ts
import { DurableDeferred } from "@smthrs/flow"
import * as Effect from "effect/Effect"

const gate = WaitFor.deferred("ship")

export const approve = (executionId: string) =>
  Effect.gen(function*() {
    const token = DurableDeferred.tokenFromExecutionId(gate, { flow: Ship, executionId })
    yield* DurableDeferred.succeed(gate, { token, value: { approved: true } })
  })
```

The resolver needs the `FlowRuntime` the run was started on, because a completion
is recorded against the flow and execution that own the wait point. In practice
that means the resolver and the engine share a store.

`DurableDeferred.tokenFromPayload(gate, { flow, payload })` derives the same token
from a payload, for a resolver that knows what was asked for but not which id it
was admitted under. This requires the flow to declare `idempotencyKey`; use
`tokenFromExecutionId` when the caller supplied an execution id explicitly.

A token is an address, not a credential. Anyone who knows the flow and the
execution id, or the payload, can rebuild it, so a resolver that accepts
completions from other parties must authorize the caller before it calls
`DurableDeferred.succeed`.

## Name exactly one target

A `WaitFor` payload names the wait point by `name`, relative to the running
execution, or by an absolute `token`. `WaitFor.WaitForRequestInvalid` is the
typed refusal:

| Code                | What was wrong                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `missing_target`    | The payload named neither `name` nor `token`.                                                     |
| `ambiguous_target`  | It named both.                                                                                    |
| `malformed_token`   | The token does not parse.                                                                         |
| `foreign_execution` | The token is addressed to another flow or another execution, which this execution cannot observe. |

`foreign_execution` is a refusal rather than a silent park because a foreign
token would park forever while the value it names was recorded somewhere else.

## Durable deferreds on their own

`WaitFor` is a thin declaration over `DurableDeferred`, and you can use the
primitive directly inside an implementation:

```ts
const Approval = DurableDeferred.make("Approval", {
  success: Schema.Boolean,
  error: Schema.String
})

// Inside a flow: park until it is completed.
const awaited = DurableDeferred.await(Approval)

// Or run an effect and record its exit into the deferred.
const computed = DurableDeferred.into(Effect.succeed(true), Approval)

// Race several, persisting the first exit under `raceAll/first-answer`.
const winner = DurableDeferred.raceAll({
  name: "first-answer",
  success: Schema.Boolean,
  error: Schema.String,
  effects: [awaited, computed]
})
```

Four surfaces complete a deferred from outside, and all four take a token:
`DurableDeferred.succeed`, `fail`, `failCause`, and `done` with a full `Exit`.
Inside a running flow, `DurableDeferred.token(self)` mints the token for the
current execution.

Two rules govern every completion:

- **First writer wins.** The first recorded exit is the one every later read
  replays. A second completion does not overwrite it.
- **A token names one deferred.** A token whose `deferredName` is not this
  deferred's fails with `DurableDeferred.TokenInvalid` carrying
  `deferred_mismatch`, and a token that does not parse fails with
  `malformed_token`.

A token encodes the flow name, the execution id, and the deferred name, which is
exactly what another process needs to write to the right durable address.
`DurableDeferred.TokenParsed` is the decoded form.

## Related pages

- [Ask a person for a decision](/guides/ask-a-person/): the same wait point machinery
  with validation, re-asking, and a deadline on top.
- [Wait for a deadline](/guides/wait-for-a-deadline/): the timer half of the same
  vocabulary.
- [Hand work to a durable worker](/guides/queue-work-to-a-worker/): a deferred used
  as a request and response channel.
