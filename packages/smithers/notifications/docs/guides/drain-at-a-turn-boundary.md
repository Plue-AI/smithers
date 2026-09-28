---
title: "Drain at a turn boundary"
description: "Ask the queue what one boundary may deliver: naming the boundary, setting the turn cutoff, reporting idleness, and reading a duplicate receipt."
sidebar:
  order: 2
---

A run drains when it reaches a point where reading a new instruction is safe.
The queue decides what that boundary may deliver, records the decision, and
answers with it.

## Call drain at the safe point

```ts
import { NotificationQueue } from "@smthrs/notifications"
import * as Effect from "effect/Effect"

export const atTurnClose = (runId: string, lineageId: string, turn: number, turnOpenedAt: number) =>
  Effect.gen(function*() {
    const queue = yield* NotificationQueue.NotificationQueue
    const receipt = yield* queue.drain({
      runId,
      targetLineageId: lineageId,
      boundary: `turn-${turn}`,
      wouldIdle: false,
      cutoffSeq: turnOpenedAt
    })
    return receipt.notifications
  })
```

Each field decides something:

- **`boundary`** names this safe point. With `runId` and `targetLineageId` it
  forms the drain identity, so the name must be stable for one boundary and
  distinct between boundaries. A turn number is the usual choice.
- **`cutoffSeq`** is the journal sequence that opened the turn now closing. A
  steer admitted after it is held for the next boundary, which keeps a message
  that arrived mid-turn out of the turn already in flight. Omit it only when you
  have no turn to compare against; omitting it delivers everything pending for
  the lineage.
- **`wouldIdle`** says whether the run would have nothing to do if this boundary
  delivered nothing. When it is `true` and no steer was promoted, the drain also
  promotes exactly one queued notification.

## Read the receipt

`DrainReceipt.notifications` are the notifications the committed promotion
record names, in admission order. Render them, and act on the steering items
they carry with `SteerPayload.decode`:

```ts
import type * as NotificationQueue from "@smthrs/notifications/NotificationQueue"
import * as SteerPayload from "@smthrs/notifications/SteerPayload"

const messages = (receipt: NotificationQueue.DrainReceipt) =>
  receipt.notifications.flatMap((notification) => {
    const item = SteerPayload.decode(notification)
    return item?.kind === "Message" ? [item.body] : []
  })
```

`DrainReceipt.duplicate` is `true` when this boundary had already drained. The
notifications are still the right ones: they are read back from the committed
record rather than decided again, so two processes draining one boundary report
the same delivery instead of two divergent guesses. A resumed run that walks its
boundaries looking for the first one it has not consulted branches on exactly
this flag.

## Drain the lineage you are

`targetLineageId` is not decoration. Two lineages closing a turn under the same
boundary name are two separate drains, so a child lineage that passes its
parent's id drains the parent's notifications and leaves its own pending. Pass
the lineage the running code belongs to.

## The harness does this for you

[`@smthrs/harness`](/api/harness) already implements this loop. Its
`Notifications.layer({ runId, lineageId })` captures the queue as the harness
steering source, calls `drain` at each boundary, and folds the result into the
inserts, seat changes, and thinking changes the turn controller acts on. Write
your own drain only when you are building a host that is not that harness.

## Next

- [Handle a full queue](./handle-a-full-queue.md): the writer-side contract that
  keeps the boundary from having nothing to read.
- [Report what a run is waiting on](./report-pending-notifications.md): the same
  fold, without promoting anything.
