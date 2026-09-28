---
title: "Ask a person for a decision"
description: "Park a run on a typed question, record an answer against the attempt's token, re-ask a refused answer, and give the question a deadline."
sidebar:
  order: 6
---

`HumanTask.action` is a question as a plan node. The run parks under the
`approval` waiting reason, someone records an answer against the token it parked
with, and the node settles with that answer. Validation, re-asking, and a
deadline are part of the declaration rather than something the caller builds.

## Ask the question

```ts
import { Action, Flow, HumanTask, Interpreter } from "@smthrs/flow"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

export const Release = Flow.make("release/Release", {
  payload: { build: Schema.String },
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: ({ build }) =>
    HumanTask.action.call({
      name: "release",
      kind: "confirm",
      prompt: `Ship ${build}?`,
      maxAttempts: 3
    })
})

export const layer = Layer.mergeAll(
  HumanTask.layer,
  Interpreter.layer(Release)
).pipe(Layer.provideMerge(Action.layerImplementations))
```

`name` addresses the question. Two calls naming one question in one execution
await one answer.

## Choose the shape of the answer

| `kind`    | What the person supplies                | Other fields |
| --------- | --------------------------------------- | ------------ |
| `ask`     | Prose.                                  | none         |
| `confirm` | A boolean.                              | none         |
| `select`  | One of the strings in `options`.        | `options`    |
| `json`    | A value the task's JSON Schema accepts. | `schema`     |

A `schema` supplied with any kind other than `json` is refused, because nothing
would check it. The bounded schema subset is `type` (`object`, `array`, `string`,
`number`, `integer`, `boolean`, `null`), `enum`, `properties`, `required`,
`items`, `nullable`, `description`, and `title`. `enum` members may be any JSON
value, including objects and arrays, and membership is compared structurally
rather than by reference.

## Give the answer a type

`HumanTask.action` succeeds with `Schema.Json`. `HumanTask.decode` gives that
answer your own type:

```ts
const Decision = Schema.Struct({ decision: Schema.Literals(["ship", "hold"]) })

const asked = HumanTask.action.call({
  name: "release",
  kind: "json",
  prompt: "Ship the release?",
  schema: {
    type: "object",
    required: ["decision"],
    properties: { decision: { enum: ["ship", "hold"] } }
  },
  maxAttempts: 3,
  timeoutMs: 6 * 60 * 60 * 1000
}).pipe(HumanTask.decode(Decision))
```

The schema you pass to `decode` and the question's own schema description must
agree. A disagreement surfaces as a defect rather than as a failure a body could
catch, because the two descriptions are the same claim written twice.

## Record an answer

The run parks carrying the current attempt's token. Whoever collects the answer
records it against that token:

```ts
import { DurableDeferred } from "@smthrs/flow"

const tokenFor = (executionId: string, attempt: number): DurableDeferred.Token =>
  DurableDeferred.tokenFromExecutionId(HumanTask.deferred("release", attempt), {
    flow: Release,
    executionId
  })

export const answer = (executionId: string, attempt: number) =>
  HumanTask.answer({ token: tokenFor(executionId, attempt), value: true })
```

Each attempt is its own durable wait point, named `WaitFor/<name>#<attempt>`,
because a durable deferred records the first completion and replays it forever.
The runtime admits an answer only while the run is parked on that exact approval
wait, and records the completion as one mutation, so a guessed, unopened, or
stale token cannot pre-answer a run. A token whose deferred name
`HumanTask.deferred` could not have written fails with
`DurableDeferred.TokenInvalid` carrying `deferred_mismatch`.

These checks bound when an answer lands, not who sends it. A token is an
unsigned address the execution id and attempt rebuild, so the endpoint that
calls `HumanTask.answer` must authorize the person first.

Do not track the attempt number in your own process. Read it back from the
engine's waiting row, which carries the `approval` reason and the token of the
one attempt that is open.

## Refuse an answer before it is sent

`HumanTask.validate(value, request)` returns the reason an answer would be
refused, or `undefined`. Run it in the interface, so a typo is refused while the
person is still looking at it:

```ts
const problem = HumanTask.validate(candidate, { kind: "select", options: ["ship", "hold"] })
```

`HumanTask.validateSchema(schema)` checks that a JSON Schema stays inside the
bounded subset at every depth, and returns the first reason it does not.

## When the question ends without an answer

A refused answer is recorded under the attempt that refused it, as a sealed step
named `HumanTask/<name>#<attempt>/rejected` carrying the task, the attempt, and
the reason. The run then parks on the next attempt's token. A re-driven round
replays every answer it already has and parks on the first attempt that has none,
so a restart between the park and the answer resumes on the same token.

`HumanTask.HumanTaskFailed` carries `code`, `task`, `attempts`, the `rejections`
it collected, and a message:

| Code              | Meaning                                                                                                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request_invalid` | The question was unanswerable before anyone was asked: a `select` with no options, an attempt budget below one or above `HumanTask.maxAttemptBudget`, a `timeoutMs` that is not a length of time, or a schema outside the subset or past its depth or node bound. |
| `rejected`        | The attempt budget was spent on answers the task refused.                                                                                                                                                                                                         |
| `timeout`         | The deadline passed with the question still open.                                                                                                                                                                                                                 |

`HumanTask.HumanAnswerInvalid` is the separate refusal an answer earns before it
can consume durable storage, with `answer_invalid` for an answer outside the
durable JSON boundary and `answer_not_open` for an attempt that is not waiting.

`maxAttempts` defaults to `HumanTask.defaultMaxAttempts`, which is `10`.

## Put a deadline on it

`timeoutMs` is how long the question stays open across every attempt. It races
the answer against one `DurableClock` per task through
`DurableDeferred.raceAll`, and the race parks and settles on whichever arrives
first. Both shipped engines re-enter a parked race on the next drive,
re-registering the raced deferreds against their persisted completions, so a
deadline settles under the in-process engine and the SQLite engine store alike.

A parked dispatch keeps its attempt row and its attempt number, so a question
that waits out a person costs nothing against the action's retry budget.

## Bounded by construction

One question cannot grow a durable record without limit. The module exports every
bound as a constant, including `maxAttemptBudget` (1000), `maxSchemaDepth` (32),
`maxSchemaNodes` (512), `maxAnswerNodes` (10,000), `maxAnswerBytes` (256 KiB),
`maxPromptBytes` (64 KiB), `maxOptions` (256), `maxDiagnosticChars` (512), and
`maxRetainedRejectionChars` (8192).

A value echoed into a rejection message is truncated with an explicit marker, and
the retained `rejections` array records how many further rejections it omitted.
Only the accumulated array is capped: each per-attempt journal step still records
its own full reason, so the record shows what was actually said.

## Related pages

- [Wait for an external signal](./wait-for-an-external-signal.md): the wait point
  and token machinery this is built on.
- [Suspension and replay](../concepts/suspension-and-replay.md): what the
  `approval` park does to the run.
