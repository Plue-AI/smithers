---
title: "The journal records"
description: "The two durable events this package owns, why their spelling is frozen, how a queue folds a run's history back into state, and what a projection over a shared journal may assume."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/notifications/docs/concepts/journal-records.md"
---

The queue keeps no state of its own. Everything it knows comes from two journal
records, and rebuilding from them is what lets a second process answer for a run
the first one admitted to.

## Two event types

| Constant                              | Event type                     | What it records                                               |
| ------------------------------------- | ------------------------------ | ------------------------------------------------------------- |
| `NotificationEvent.AdmittedEventType` | `flows/notifications/Admitted` | One notification and the decision the queue made about it.    |
| `NotificationEvent.PromotedEventType` | `flows/notifications/Promoted` | Which notification ids one boundary of one lineage delivered. |

Both spellings are frozen wire format. The values are already durable in every
database that has run this package, and renaming them would silently stop
matching the projections that consumers key on. Treat both strings, and the JSON
stored under them, as fixed.

An `Admitted` payload is `{ notification, decision }`. A `Promoted` payload is
`{ boundary, targetLineageId, ids }`.

## Replay never re-decides

The decision is recorded because it is a fact, not a derivation. When a queue
folds history, `NotificationState.applyAdmission` applies the committed decision
whatever this process's state would have chosen. A run that filled up under a
capacity of 128 and is now folded by a layer built at 512 replays as what
happened, not as what would happen today.

`rejected-full` is the decision that is never written. The queue refuses a full
queue in the receipt alone, because a rejection recorded as an admission would
match on every later attempt and burn the id forever. The literal stays in
`NotificationEvent.AdmissionDecision` so that a reader is total over a record any
writer could have produced.

## Folding is incremental

A layer folds each run once and then pages only the entries committed since its
last read. It keeps at most 64 folds at a time, and a run evicted from that set
is folded again from the beginning on its next call. Reading a run's history
therefore costs what has been journaled since the previous call, not the run's
whole journal.

Eviction sacrifices the newest fold no later read has come back for, never the
fold an ordered sweep is about to want. Dropping the least recently folded run
instead drops the run the next read wants, so a supervisor polling 65 or more
runs in order would replay every journal from sequence zero on every pass. A
sweep of any width instead refolds a fixed handful of runs and pages the tail
of the rest. When every retained fold has been read a second time the oldest is
evicted and the reuse marks are cleared, so no fold holds a slot on one ancient
read forever.

A fold retains the run's pending state, the sequence it stopped at, and the
identities it has seen: a notification id with the fingerprint and sequence of
its admission, and a drain identity with the sequence of its record. It retains
no admitted payload and no drain record, so a run's memory does not grow with
the notifications it has already drained, and a queue of any capacity costs the
same per event however long the run has been running. The two paths that must
report an already committed notification, a replayed drain and the content
comparison for a legacy admission with no fingerprint, read the record back at
its sequence.

Eviction is always safe, and so is an interleaved fold: a fold reads the cached
value, pages what has been committed since, and writes a fresh, self-consistent
pair back, so the worst case is one extra page on the next call. No fold can
report a state the journal does not hold: a fold taken inside a transaction is
published through `Journal.whenCommitted`, so a rollback leaves behind neither
the condition it observed nor the cursor it stopped at.

## Foreign entries are not errors

Journals are shared. `NotificationEvent.fromEntry` answers `Option.none()` for
an entry this package does not own, and for an owned entry whose payload does
not decode, so a projection over a busy journal stays total instead of failing
on somebody else's record.

An event type alone does not make an entry owned, because any writer to a shared
journal can choose one. An `Admitted` entry counts only under
`NotificationEvent.admissionSourceId` of the notification it carries, and a
`Promoted` entry only under a `/notifications/drain/` source. Another writer
therefore cannot forge a steer the model would read as an operator's, or mark
pending steers delivered. The drain check is a prefix because drain records
written before the lineage joined the identity carry the boundary alone.

`NotificationEvent.isAdmitted` and `NotificationEvent.isPromoted` tell the two
owned events apart. They are refinements over the decoded shape rather than a
stored discriminant, because a discriminant would be a durable field this
vocabulary does not have.

## Projections

`Projection.derive` is a `Journal.Projection` that replays the same fold and
emits the state after every entry:

```ts
import { Journal, JournalEvent } from "@smthrs/journal"
import { Projection } from "@smthrs/notifications"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

const watchPending = (runId: string) =>
  Effect.flatMap(
    Journal.Journal,
    (journal) =>
      journal.project(Projection.derive, { runId: JournalEvent.RunId.make(runId) }).pipe(
        Stream.runForEach((state) => Effect.log(`${state.items.length} pending`))
      )
  )
```

`journal.project` replays the run's history and then follows its committed
tail, so the stream does not end on its own. That is what a projection is for:
a live view that stays correct as entries arrive. Bound it with `Stream.take`
when you want a snapshot, or fork it into a scope when you want a follower.

`Projection.derive` starts at `NotificationState.empty(NotificationState.defaultCapacity)`.
That bound is the initial state's, not the run's: replay applies committed
decisions rather than re-deciding, so a deployment that raised the bound with
`NotificationQueue.layerWith` sees every admission it wrote replayed, past 128.
No journal record carries the layer's bound, so the projected `capacity` stays
at the default and `items` is the field to read.

For the live answer rather than a replay, use `NotificationQueue.pending`; see
[Report what a run is waiting on](/guides/report-pending-notifications/).
