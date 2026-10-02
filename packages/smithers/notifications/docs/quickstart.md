---
title: "Quickstart"
description: "Admit a steer and a follow-up to a run, drain them at a turn boundary, and read the receipt, over an in-memory journal that needs no configuration."
sidebar:
  order: 2
---

This quickstart runs the durable queue end to end. The journal is the
production SQLite one over an in-memory database, so nothing is stubbed and
nothing needs configuring. By the end you will have admitted two notifications
from one process, drained them from the code that stands in for a run, and read
back what each step decided.

## Prerequisites

- Node.js 26.4.0 or later.
- A package with the dependencies installed. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/apps/site/docs/installation.mdx).

## Write the notifications

A notification names what will read it, carries the provenance of whoever wrote
it, and declares how it may be delivered. `targetLineageId` is that first part:
an opaque address for the run, or for one branch of the run that closes turns of
its own. The queue only compares it for equality, so `"run-1/root"` below is a
readable choice rather than a required format. Create `quickstart.ts`:

```ts
import type { Notification } from "@smthrs/notifications/Notification"

const from = {
  sourceRunId: "operator",
  sourceLineageId: "operator",
  sourceTurn: 0,
  sourceActor: "human:will"
}

/** Urgent: this one is delivered in a batch when the current turn closes. */
const steer: Notification = {
  _tag: "human-steer",
  id: "message-1",
  delivery: "steer",
  targetLineageId: "run-1/root",
  provenance: from,
  payload: { kind: "Message", body: "look at the failing test first" }
}

/** Not urgent: this one waits until the run would otherwise have nothing to do. */
const followup: Notification = {
  _tag: "human-followup",
  id: "message-2",
  delivery: "queue",
  targetLineageId: "run-1/root",
  provenance: from,
  payload: { kind: "Message", body: "and update the changelog when you get a moment" }
}
```

`id` is your idempotency key. Admitting it twice with the same content is one
notification; admitting it with different content is a producer bug the queue
refuses.

## Admit, then drain

`admit` and `drain` are separate calls because in production they happen in
different processes at different times. Here they run in one file, which changes
nothing about what the journal records:

```ts
import { NotificationQueue } from "@smthrs/notifications"
import * as Effect from "effect/Effect"

const ids = (receipt: NotificationQueue.DrainReceipt) => receipt.notifications.map((item) => item.id)

const program = Effect.gen(function*() {
  const queue = yield* NotificationQueue.NotificationQueue

  const first = yield* queue.admit("run-1", steer)
  const second = yield* queue.admit("run-1", followup)

  // The run closes a turn. Steers are delivered at turn close, in a batch.
  const turn1 = yield* queue.drain({
    runId: "run-1",
    targetLineageId: "run-1/root",
    boundary: "turn-1",
    wouldIdle: true
  })

  // The run closes the next turn with nothing left to do, so it accepts one
  // queued follow-up.
  const turn2 = yield* queue.drain({
    runId: "run-1",
    targetLineageId: "run-1/root",
    boundary: "turn-2",
    wouldIdle: true
  })

  return {
    admitted: [first.decision, second.decision],
    turn1: ids(turn1),
    turn2: ids(turn2),
    stillPending: (yield* queue.pending("run-1")).map((item) => item.id)
  }
})
```

## Provide the journal and run it

`TestJournal.layer()` is the production SQLite journal over an in-memory
database, with migrations already run:

```ts
import * as TestJournal from "@smthrs/journal/test/TestJournal"

export const main = program.pipe(
  Effect.provide(NotificationQueue.layer),
  Effect.provide(TestJournal.layer()),
  Effect.scoped,
  Effect.orDie
)

console.log(await Effect.runPromise(main))
```

Run the file with your TypeScript runner:

```text
{
  admitted: [ 'admitted', 'admitted' ],
  turn1: [ 'message-1' ],
  turn2: [ 'message-2' ],
  stillPending: []
}
```

## What just happened

The first boundary delivered the steer and nothing else. A queued notification
is promoted one at a time, and only when the boundary has no steer to deliver
and the run would otherwise stall, so the follow-up waited for the second
boundary. Set `wouldIdle` to `false` on both drains and `message-2` stays
pending indefinitely, which is the correct answer: a run that always has work
never needs it.

Both operations are journaled, so a second process over the same database sees
the same answers. Drain `turn-1` again and the receipt comes back with
`duplicate: true` and the same notifications, read from the committed promotion
record rather than decided a second time.

## Next steps

- [Admission and promotion](./concepts/admission-and-promotion.md): what
  delivery classes, coalescing, the capacity bound, and the drain identity
  actually mean.
- [Handle a full queue](./guides/handle-a-full-queue.md): the one receipt field
  a caller must never ignore.
- [Steer a run](./guides/steer-a-run.md): the payload vocabulary that turns a
  notification into a seat change or a thinking-level change.
- [Test against the queue](./guides/testing.md): the same in-memory stack as a
  test habit, plus the pure state machine underneath it.
