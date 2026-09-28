---
title: "Steer a run"
description: "Turn an operator instruction into a durable human-steer notification: pick a steering item, encode it into the payload, and admit it with a stable id."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/notifications/docs/guides/steer-a-run.md"
---

A steer is an instruction for a run that is already running. Admit it as a
`human-steer` notification and the run reads it when its next turn closes.

## Choose a steering item

`SteerPayload.SteerPayload` is the vocabulary a control plane writes and a
harness reads. Four items, and each one says a different thing to the run:

| Item       | Fields                             | Effect at the boundary                           |
| ---------- | ---------------------------------- | ------------------------------------------------ |
| `Message`  | `body: string`                     | Inserted into the transcript.                    |
| `Seat`     | `seat: string`                     | Changes the model seat from the next turn.       |
| `Thinking` | `thinking: SteerPayload.Thinking`  | Changes the reasoning effort from the next turn. |
| `Tools`    | `toolNames: ReadonlyArray<string>` | Widens the active tool set. Additive only.       |

`SteerPayload.Thinking` is `none`, `minimal`, `low`, `medium`, `high`, or
`xhigh`. An empty `Message` body is allowed on purpose: an operator who steers
an empty message has still told the run that a human is watching and the turn
should continue.

## Encode it and admit it

`SteerPayload.encode` writes the item as the record the journal stores. The
result is typed as the item, so it fills the JSON `payload` field without an
assertion, and it shares no mutable structure with the item you gave it:

```ts
import { NotificationQueue } from "@smthrs/notifications"
import type { Notification } from "@smthrs/notifications/Notification"
import * as SteerPayload from "@smthrs/notifications/SteerPayload"
import * as Effect from "effect/Effect"

const steerNotification = (
  runId: string,
  messageId: string,
  operator: string,
  item: SteerPayload.SteerPayload
): Notification => ({
  _tag: "human-steer",
  id: messageId,
  delivery: "steer",
  targetLineageId: runId,
  provenance: {
    sourceRunId: runId,
    sourceLineageId: runId,
    sourceTurn: 0,
    sourceActor: `human:${operator}`
  },
  payload: SteerPayload.encode(item)
})

export const steer = (runId: string, messageId: string, body: string) =>
  Effect.gen(function*() {
    const queue = yield* NotificationQueue.NotificationQueue
    return yield* queue.admit(runId, steerNotification(runId, messageId, "will", { kind: "Message", body }))
  })
```

Three things carry weight here:

- **`id` is the operator's message id, not a fresh one.** A retried request with
  the same id and the same content is one steer. A retried request with the same
  id and different content is refused as `notification_id_reused`, which is the
  correct answer: two different instructions must not share one identity.
- **`targetLineageId` names the lineage that will read it.** A child lineage
  drains its own boundary, so steering the root and steering a child are
  different notifications.
- **`provenance.sourceActor` is who said it.** The run that receives a steer is
  not the run that wrote it, and provenance is the only thing that says which of
  an operator, a parent run, and a webhook this was.

## Send a follow-up instead

Change `_tag` to `"human-followup"` and `delivery` to `"queue"` and the same
message waits until the run would otherwise have nothing to do. Use it for
anything that is worth saying and not worth interrupting a turn for. See
[Admission and promotion](/concepts/admission-and-promotion/).

## Read a steer back

`SteerPayload.decode` reads an admitted notification as an item, or answers
`undefined` when it carries none:

```ts
import type * as Notification from "@smthrs/notifications/Notification"
import * as SteerPayload from "@smthrs/notifications/SteerPayload"

declare const notification: Notification.Notification

const item = SteerPayload.decode(notification)
// { kind: "Message", body: "keep going" } for a human steer whose payload is { body: "keep going" }
```

A `system-event` always decodes as `undefined`, whatever its payload says.
System events carry webhook bodies and machine reports, and reading one as a
steer would let its producer message the model as an operator or change the
run's seat, thinking level, or tools. Inside a `human-steer` or
`human-followup`, a record with a `body` string and no `kind` decodes as a
message, because that is what a minimal caller means by it. Anything the
vocabulary cannot classify decodes as `undefined` rather than a guess.

## What the run does with each item

[`@smthrs/harness`](https://harness.smithers.sh/reference/api/) drains the queue at each turn boundary and
sorts the items. A `Message` becomes a transcript insert. `Seat` and `Thinking`
become changes that apply from the next turn, and are deliberately not announced
to the model: telling it "your seat changed" would spend a turn on bookkeeping
when changing the seat is what the operator asked for.

A `Tools` steer is answered out loud rather than dropped. That harness gives the
model no provider tools at all, so there is nothing to activate; the run is told,
in the transcript, that an operator asked for those tools and that its authority
is the flows it can already call. A host that does hand the model provider tools
decides for itself what the item activates.

## Next

- [Drain at a turn boundary](/guides/drain-at-a-turn-boundary/): the reading half.
- [Handle a full queue](/guides/handle-a-full-queue/): what to do when the receipt
  says `rejected-full`.
