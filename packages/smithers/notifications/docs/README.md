---
title: "@smthrs/notifications"
description: "A durable queue for telling a running agent something: admit a message from any process, and deliver it only at a point in the run where reading it is safe."
---

`@smthrs/notifications` is a durable queue for telling a running agent
something. Any process admits a message at any time, and the run collects what
it may deliver at a boundary of its own choosing, so an instruction never lands
in the middle of a turn.

## The problem it solves

An agent that has been working for twenty minutes is not something you can call
a function on. An operator wants to redirect it, a supervisor wants to raise an
alarm, a parent run wants to pass down a result. Writing any of those straight
into the model's context changes what the model is reading while it is reading
it, and holding them in memory loses them when the process restarts.

This package pulls the two halves apart and puts a journal between them:

- **Admission** is the writer's moment. Any process admits a notification at any
  time. The queue records it durably and answers with a receipt.
- **Promotion** is the reader's moment. The run asks, at a point where reading a
  new instruction is safe, what this boundary may deliver.

Nothing happens in between, and both halves survive a restart. The queue keeps
no state of its own: it folds each run's state back out of the two journal
records it writes, so a second process over the same database answers for a run
the first one admitted to.

Reach for it when you need durable, attributed delivery into a long-running
process, and when losing a message or delivering it twice would both be wrong:
operator steering, an idle-time follow-up queue, coalesced system events, or
alerts about a run that has been stuck too long.

## Install

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/apps/site/docs/installation.mdx).

Node.js 26.4.0 or later. `@smthrs/journal` is where the durable records go, and
the example below imports it directly. See [Installation](./installation.md) for
the SQLite composition a deployment uses.

## Admit a message, deliver it at a turn boundary

The journal here is the production SQLite one over an in-memory database, so
nothing is stubbed and nothing needs configuring:

```ts
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { NotificationQueue } from "@smthrs/notifications"
import type { Notification } from "@smthrs/notifications/Notification"
import * as Effect from "effect/Effect"

const steer: Notification = {
  _tag: "human-steer",
  id: "message-1",
  delivery: "steer",
  targetLineageId: "run-1/root",
  provenance: {
    sourceRunId: "operator",
    sourceLineageId: "operator",
    sourceTurn: 0,
    sourceActor: "human:will"
  },
  payload: { kind: "Message", body: "look at the failing test first" }
}

const program = Effect.gen(function*() {
  const queue = yield* NotificationQueue.NotificationQueue

  // Whoever is steering, whenever they say it.
  yield* queue.admit("run-1", steer)

  // The run, at a point where reading a new instruction is safe.
  const receipt = yield* queue.drain({
    runId: "run-1",
    targetLineageId: "run-1/root",
    boundary: "turn-1",
    wouldIdle: true
  })
  return receipt.notifications.map((notification) => notification.id)
})

console.log(
  await Effect.runPromise(
    program.pipe(
      Effect.provide(NotificationQueue.layer),
      Effect.provide(TestJournal.layer()),
      Effect.scoped,
      Effect.orDie
    )
  )
)
```

```text
[ 'message-1' ]
```

`id` is your idempotency key: admitting it twice with the same content is one
notification. `boundary` is the delivery's identity: draining `turn-1` again
reads the committed record back and reports the same notifications with
`duplicate: true`, rather than deciding a second time and disagreeing.
`targetLineageId` is the address of the reader, which the queue only compares for
equality: pass the run id when a run has one reader, and the branch's id when it
has several. See
[Admission and promotion](./concepts/admission-and-promotion.md).

## How it relates to the smithers CLI

This package is one of the pieces behind [`@smthrs/cli`](/api/cli), the `smthrs`
command line that plans, runs, and inspects durable flows. Running
`smthrs runs steer <run-id> --message "..."` admits a `human-steer` notification to
this queue under a stable message id, and the run reads it when its next turn
closes. `smthrs runs list` fills in each run's pending steer count from the same fold
`drain` uses, which is why a listing never reports a delivered message as still
waiting.

Neither package needs the other. Install `@smthrs/cli` for the operator-facing
command line and everything under it. Install this package when you are building
the host on the other side: the code that decides where a turn boundary is and
asks the queue what it may deliver there. [`@smthrs/harness`](/api/harness)
is the one Smithers ships, and it drains this queue at every boundary.

## Where to go next

- [Installation](./installation.md): the journal, the HTTP client the webhook
  sink needs, and the import forms.
- [Quickstart](./quickstart.md): admit a steer and a follow-up, drain both, and
  read what each step decided.
- [Admission and promotion](./concepts/admission-and-promotion.md): delivery
  classes, coalescing, the capacity bound, the turn cutoff, and the drain
  identity.
- [The journal records](./concepts/journal-records.md): the two durable events,
  why replay never re-decides, and what a projection may assume.
- [How alerting decides](./concepts/alerting.md): why an alert is a function of
  journal time, and why delivery is at-least-once.
- [Steer a run](./guides/steer-a-run.md) and
  [Drain at a turn boundary](./guides/drain-at-a-turn-boundary.md): the writing
  half and the reading half.
- [API reference](./api.md): every export, with its signature.
- [Troubleshooting](./troubleshooting.md): what each symptom means and what to
  change.
