---
title: "Watch a run's events"
description: "Read a finite snapshot or follow a live stream of control events, resume at a cursor without seeing an entry twice, and read the lineage and steer-delivery deltas the plane derives."
sidebar:
  order: 3
---

`watch` streams `ControlEvent` values projected from committed journal entries.
It is a read: nothing you do with the stream changes a run.

## Take a finite snapshot

`follow: false` asks for what is durable when the request is handled. The
stream ends, which is what makes it assertable in a test or usable in a
one-shot report:

```ts
import { Control } from "@smthrs/control/Control"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

const kinds = Effect.gen(function*() {
  const control = yield* Control
  return yield* control.watch({ runId: "run-17", follow: false }).pipe(
    Stream.map((event) => event.kind),
    Stream.runCollect
  )
})
// [ "control.run.accepted", "control.run.running", "flows.engine.attempt-started", ... ]
```

## Follow a live stream

Omit `follow` and the stream stays open. This is what a UI subscribes to:

```ts
const tail = control.watch({ runId: "run-17" }).pipe(
  Stream.runForEach((event) => Effect.log(`${event.sequence} ${event.kind}`))
)
```

A subscriber that arrives late still receives the entries it missed. The
projection pins a high-water sequence per partition, reads everything at or
below it from a finite snapshot, and takes everything above it from the
buffered tail. It is a handoff rather than a deduplicated overlap, so an
arbitrarily long history cannot make an old entry reappear.

## Resume at a cursor

Store `event.cursor` after processing each event, then pass it back unchanged
as `afterCursor` with the same `runId`:

```ts
const resumed = control.watch({ runId: "run-17", afterCursor: lastSeen })
```

A cursor is `{ sequence: number; offset?: number }`. `sequence` identifies the
source journal entry. A present `offset` is the zero-based index of the last
consumed member of that entry's expansion. An absent offset means the entire
entry was consumed. The last member always carries this completed-entry cursor,
so the next watch starts after the source row without rereading it.

For a promotion at sequence 12 that delivers two messages, the emitted cursors
are `{ sequence: 12, offset: 0 }` for the source,
`{ sequence: 12, offset: 1 }` for the first delivery, and `{ sequence: 12 }`
for the second. Reconnecting after the source still yields both deliveries.
This works for finite snapshots and live streams while the source row remains
in the journal. Commit the checkpoint with your event processing to avoid
reprocessing an event after a consumer crash.

`afterSequence` remains available to skip a fully processed source entry and
all its derived events. It cannot checkpoint progress inside an expansion.
Do not combine it with `afterCursor`.

Both cursor forms require `runId`. Sequences are partition-local:

```text
InvalidInput: afterCursor: a watch cursor resumes one run, so it requires runId
```

Raw `Lineage` and `Steering` projections and older providers can omit `cursor`.
`ControlLive.watch` assigns a cursor to every emitted event.

## Watch everything

Omit `runId` and the stream merges every partition the plane knows: each run,
and each plan under `plan:<planId>`. Eight partition snapshots are read at a
time, with one slot reserved so the live tail is never starved behind snapshot
work.

An unscoped watch is the right shape for a dashboard. For a run you can name,
scope it: the scoped watch is one partition read and it is the only form that
can resume.

## Read the derived deltas

Two kinds are computed rather than recorded, and arrive beside the entry they
were derived from:

| Kind                      | Payload                                                     | Means                                        |
| ------------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| `control.run.lineage`     | `{ runId, parentRunId, lineageId?, roundOrdinal?, origin }` | A run was spawned, forked, or handed off to. |
| `control.steer.delivered` | `{ runId, messageId, boundary }`                            | A turn boundary took your steer.             |

Both projections are exported, so a client reading the journal directly reaches
the same conclusions the server does:

```ts
import * as Lineage from "@smthrs/control/Lineage"
import * as Steering from "@smthrs/control/Steering"

const expanded = [...Lineage.expand(event), ...Steering.derive(event)]
```

`expand` returns the entry plus any delta it discloses; `derive` returns the
delta alone. See [Journal projections](../concepts/projections.md) for why
delivery is derived rather than written.

## Failures

Every member of `ControlError` can reach a watch stream. In practice you will
meet three:

- `InvalidInput` for an unscoped or malformed cursor, or both cursor forms together.
- `PersistenceError` with operation `watch` when a journal read fails. Its
  `cause` is the journal's own error.
- `Unavailable` with feature `watch` when the composition has no open journal.

A watch of a run that does not exist is not an error. The partition is empty.

## Where to go next

- [Journal projections](../concepts/projections.md): partitions, the handoff,
  and the full list of kinds the plane writes.
- [Find runs and page through them](./list-runs.md): the point-in-time view.
- [`smthrs runs logs`](/cli/runs): the operator surface over this verb.
