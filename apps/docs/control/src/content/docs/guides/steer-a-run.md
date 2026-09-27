---
title: "Steer a running agent"
description: "Send a message, a seat change, a thinking level, or a tool set to a run's next turn boundary: the four variants, which parks a steer wakes, and the two durable moments a steer has."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/guides/steer-a-run.md"
---

`steer` writes one durable item into the notification queue and journals the
enqueue beside it. The run picks it up at its next turn boundary.

```ts
import { Control } from "@smthrs/control/Control"
import * as Effect from "effect/Effect"

const steer = Effect.gen(function*() {
  const control = yield* Control
  return yield* control.steer({
    runId: "run-17",
    message: {
      messageId: "steer-1",
      runId: "run-17",
      principal: { id: "ada", kind: "user", stampedAt: Date.now() },
      createdAt: Date.now(),
      body: "prefer the smaller diff"
    },
    idempotencyKey: "steer:run-17:1"
  })
})
```

## The four variants

An operator steers a run for four different reasons, and only one of them is
something to tell the model. Saying "your seat changed" would spend a turn on
bookkeeping; changing the seat is what was asked for.

| Variant                                                     | Field       | What the next turn does               |
| ----------------------------------------------------------- | ----------- | ------------------------------------- |
| `Message` (the default, and what a `body` alone decodes as) | `body`      | Inserts the body into the transcript. |
| `Seat`                                                      | `seat`      | Runs the turn on that model seat.     |
| `Thinking`                                                  | `thinking`  | Runs the turn at that thinking level. |
| `Tools`                                                     | `toolNames` | Adds those tools to the active set.   |

`kind` is optional on `Message` and required on the other three, which is what
keeps a steer written before the vocabulary widened readable: a body and no
kind is a message, and always was.

```ts
import { steerItem } from "@smthrs/control/ControlSchema"

steerItem({ ...envelope, body: "prefer the smaller diff" })
// { kind: "Message", body: "prefer the smaller diff" }
steerItem({ ...envelope, kind: "Seat", seat: "anthropic:claude-sonnet-4-5" })
// { kind: "Seat", seat: "anthropic:claude-sonnet-4-5" }
```

`ControlSchema.steerItem` strips the control envelope, which is who asked,
when, and for which run, and returns the
[`@smthrs/notifications`](https://notifications.smithers.sh/reference/api/) payload the harness reads back.
The harness maps each payload onto its matching steering item, so a seat steer
changes the seat instead of spending a turn announcing it.

## The two durable moments

| Event                     | Writer                                                                             | Payload                                 |
| ------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------- |
| `control.steer.enqueued`  | `Control.steer`                                                                    | `{ runId, messageId, kind, createdAt }` |
| `control.steer.delivered` | derived by `Steering.derive` from the queue's `flows/notifications/Promoted` entry | `{ runId, messageId, boundary }`        |

Delivery is derived rather than recorded, because the boundary that delivered
the steer runs in the agent process and not in the control plane. A control
plane that wrote its own delivery record would be asserting a fact it did not
observe.

One promotion entry names a batch, so it derives one delta per message id, each
carrying the sequence of the entry it came from. Checkpoint `event.cursor`
and resume with `afterCursor` to continue even between deliveries in a batch.

`RunSummary.steering.pending` counts what has been admitted and not yet
promoted. It comes from the queue rather than a column, because the queue owns
both halves.

## Waking a parked run

A steer resumes a parked run when the park is one a message can end:

| `waitingReason`              | Steered                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `event`                      | Resumed. The run is waiting for something to arrive, and a steer is something arriving.                                         |
| `released`                   | Resumed. A sweep took the run away from a dead owner, and nothing is coming to claim it.                                        |
| `approval`, `timer`, `quota` | Left parked. The run is waiting for a decision, a clock, or a budget that a message does not supply.                            |
| absent                       | Left parked. A park with no reason is an operator's own park, and a message queued behind it is queued for when they resume it. |

A reason this table does not name is left parked too: a control plane that
cannot explain a park should not end it. The wake claims with
`scope: "launched"`, so a run another driver created keeps its park and that
driver delivers the steer at the run's next boundary. The steer is already
durable either way.

A successful wake journals `control.steer.woke` with the run's new status.

## Refusals

A steer whose `message.runId` names a different run than the call does is
refused before anything is admitted:

```text
InvalidInput: message.runId: must be "run-17", received "run-18"
```

The notification would be admitted to the call's run while the stored message
claimed another, so an operator reading it later would be told it belongs
somewhere it was never delivered.

A steer to a run that already reached `cancelled`, `completed`, or `failed`
answers `Terminal` and stores nothing. Storing it anyway would leave an
operator watching a message with no boundary left to deliver it.

## Attribution over a wire

`SteerMessage` carries a `principal` even though `cancel` refuses one on the
wire, and the difference is who the callers are. A cancel is only ever an
operator command, so the server can be its sole source of identity. A steer is
not: `agent/send` steers a child run and attributes the message to the parent
flow, which is an identity no authenticator knows and no operator issued.

So the field stays, and `ControlServer` overwrites it with the authenticated
principal on every steer that arrives over RPC. An in-process caller keeps
naming its own. The value reaches the notification's `sourceActor` and the run
transcript, which is exactly where a spoofed name would be read as truth.

## Where to go next

- [Watch a run's events](/guides/watch-a-run/): where both moments show up.
- [Deliver a signal to a waiting run](/guides/signal-a-run/): the other way to
  reach a parked run, and why it is not the same thing.
- [`smthrs runs steer`](https://smithers.sh/docs/reference/cli/runs/) and
  [steering on smithers.sh](https://smithers.sh/docs/guides/steering/): the operator surface.
