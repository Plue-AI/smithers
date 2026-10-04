---
title: "Admission and promotion"
description: "The two moments a notification passes through: admission by whoever wrote it, and promotion at a boundary the run chose. Delivery classes, coalescing, the capacity bound, the turn cutoff, and the drain identity."
sidebar:
  order: 1
---

A notification passes through two moments, and nothing happens in between.

**Admission** is the writer's moment. Any process may admit at any time: an
operator steering from a CLI, a parent run signalling a child, a supervisor
raising an alert. Admission records the notification durably and returns.

**Promotion** is the reader's moment. The run picks it, at a point in its own
turn where reading a new instruction is safe, and asks the queue what it may
deliver.

Keeping the two apart is the point of the package. A notification that arrived
mid-turn and reached the model immediately would change what the model is
looking at while it is looking at it.

## What a notification is addressed to

Every notification carries `targetLineageId`, and it is the address of the
reading half: the run itself, or one branch of the run that opens and closes
turns of its own. The queue treats the value as an opaque string and only ever
compares it for equality, so its shape is the host's choice. A host with no
branches passes the run id and is done. A host with branches passes the id of the
branch the running code belongs to, so a message meant for one branch is not
consumed by another that never asked for it. The samples on these pages use
`"run-1/root"`, which keeps the run and the branch visible in one string.
[`@smthrs/harness`](/api/harness) takes the value as
`Notifications.layer({ runId, lineageId })` and passes its own.

`provenance` is the other half of the addressing: `targetLineageId` says who
reads it, and `provenance.sourceActor` says who wrote it.

## Two delivery classes

Every notification declares how it may reach the model, and `Notification.admissionClass`
reads that declaration back:

| Tag              | Delivery class | When it reaches the model                                       |
| ---------------- | -------------- | --------------------------------------------------------------- |
| `human-steer`    | `steer`        | In a batch, at the next turn close.                             |
| `human-followup` | `queue`        | One at a time, when the run would otherwise have nothing to do. |
| `system-event`   | `queue`        | The same, and it may coalesce with other events under one key.  |

The class is the whole difference between the first two. A follow-up is not
urgent enough to interrupt the turn in flight, so it waits for a boundary where
the run is idle. `DrainInput.wouldIdle` is how the run says it has reached one,
and a drain promotes a queued notification only when `wouldIdle` is true and no
steer was promoted at that boundary.

## Admitting is idempotent on the id

`Notification.id` is the caller's idempotency key. Admitting it twice with the
same content is one notification: the second call reads the committed decision
back and answers `duplicate: true` with the same `seq`. The comparison is on a
canonical rendering of the content, with keys sorted and absent values dropped,
so two encodings that differ only in field order compare equal.

Admitting the same id with different content is a producer bug, and the queue
refuses it with `notification_id_reused` rather than overwriting either version.
That refusal is why an alert's fields are all derived from the journal: an alert
stamped with the wall clock of whichever tick read it would change content
between retries and become permanently undeliverable.

## Coalescing collapses a chatty producer

Only a `system-event` coalesces, and only when it declares a `coalescingKey`.
A key is scoped to one `targetLineageId`. While an event with that key is
pending for that lineage, admitting another one under the same key replaces it
and answers `coalesced`. Ten updates about one condition are one pending
notification carrying the latest of them, and two branches reporting the same
condition under the same ordinary key are two pending notifications, because a
key names a condition and only the address names a reader.

The replacement substitutes the whole notification, id and provenance included,
so what a boundary delivers is the latest report rather than the first report's
envelope around a newer payload. It keeps the first admission's sequence, so
replay order stays stable: the notification holds the place in the queue that
the first report earned it. `Notification.coalesceKey` returns `null` for
everything else, which is what stops two separate human follow-ups from silently
becoming one.

## The queue is bounded

`NotificationState.defaultCapacity` is 128 pending notifications per run. The
bound is what makes an undrained run a known quantity rather than a function of
how long it was ignored.

Admitting past the bound decides `rejected-full`. That decision retains nothing
and writes no journal entry, so the id stays admissible: once a boundary drains,
the same call succeeds. `admit` does not fail on a full queue, which is exactly
why the receipt has to be read. See
[Handle a full queue](../guides/handle-a-full-queue.md).

`NotificationQueue.layerWith({ capacity })` sets the bound for one composition.
A capacity that is not a finite number becomes zero, so a misconfigured bound
refuses everything loudly instead of retaining an unbounded backlog.

## The cutoff holds a mid-turn steer

`DrainInput.cutoffSeq` is the journal sequence that opened the turn now closing.
`promoteSteers` delivers every steer admitted at or before it and holds the
rest. A steer that arrived while the turn was running is therefore delivered at
the next boundary, not the one that is closing around it.

Omitting `cutoffSeq` delivers everything pending for the lineage. That is the
right default for a caller that has no turn to compare against, and the wrong
one for a harness closing a turn, which knows the sequence and should pass it.

## The unit of drain is a triple

A drain is identified by `(runId, targetLineageId, boundary)`. Two lineages
closing a turn under the same boundary name are two drains, recorded separately,
so neither suppresses the other. Each component is percent-encoded before the
identity is assembled, so a lineage id containing a slash cannot forge another
pair's identity and steal its delivery.

The identity is also the deduplication key. The first record committed for a
triple is the delivery: a second process draining the same boundary reads that
record back and reports the same notifications with `duplicate: true`, rather
than deciding a second time and disagreeing. A parked run that walks its
boundaries looking for one it has not consulted uses exactly that flag.

## The pure state machine underneath

`NotificationState` is the same rules with no I/O and no journal: `empty`,
`admit`, `promoteSteers`, `promoteQueued`, and `pending` are ordinary functions
over an immutable `State`. `NotificationQueue` is those functions plus
durability, and `applyAdmission` and `applyPromoted` are the replay half, which
applies a committed decision rather than recomputing it.

That split is why the promotion rules can be tested directly, and why the
capacity bound belongs to `admit` alone. `applyAdmission` retains what a record
admitted without consulting it, so a deployment that raised the capacity replays
in full through `Projection.derive`. See
[the journal records](./journal-records.md).

Reserved `outside_change` payloads fail admission with the typed
`NotificationError` code `notification_refused` before any journal write.
They consume no pending capacity and cannot poison another notification’s drain.
