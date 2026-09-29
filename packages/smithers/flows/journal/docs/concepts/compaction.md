---
title: "Checkpoints and compaction"
description: "How a checkpoint pins replay state to a sequence, what the compaction floor guarantees, and why a reader below the floor gets a typed compacted failure instead of a shortened history."
sidebar:
  order: 5
---

A run that never stops growing eventually costs more to replay than it is worth.
Compaction is how the journal drops old entries without ever handing a reader a
history that is quietly missing its beginning.

Compaction is off by default. Without a `compaction` policy on the layer, the
journal never deletes an entry, and checkpointing stays a call you make.

## A checkpoint is replay state pinned to a sequence

`checkpoint({ runId, seq, state }, owner)` durably records the caller's own
replay state at a committed sequence. The journal never interprets `state`; it
round-trips verbatim, and redaction deliberately does not apply to it for the
same reason it does not apply to any other executable state.

The contract on `seq` is what makes replay work: a checkpoint at `seq` must
subsume every entry at or below `seq`, so replay is `state` plus
`stream({ runId, afterSequence: seq })`.

`seq` must also name a committed entry of the run, and it must lie above the
run's compaction floor. Otherwise the write fails `checkpoint_invalid`.
Re-checkpointing an uncompacted `seq` replaces its state: last writer wins.

The committed entry at `seq` is what survives compaction, and it survives for a
mechanical reason. It holds the run's durable `MAX(seq)` allocation floor at or
above the compaction boundary, so a process restarted after a compaction can
never re-allocate a truncated sequence.

## The floor is what a reader sees

`compact({ runId, upTo }, owner)` deletes the run's entries strictly below a
checkpoint and advances the run's compaction floor, atomically. Omit `upTo` to
use the run's latest checkpoint.

`compacted_at_ms` on a checkpoint row is null until a compaction has truncated
below it. The largest compacted `seq` for a run is that run's compaction floor.

Every read whose cursor starts below the floor fails with `compacted`, carrying
the floor in `checkpointSeq`. `entries` and `stream` behave identically here, so
a poller and a follower cannot disagree about what history exists. A reader
never receives a silently shortened history.

The read order is part of the guarantee. `entries` reads the page first and the
floor second, because truncation and the floor advance commit together: any
deletion that could have shortened the page is visible in the later floor read.
Reading the floor first would let a compaction commit between the two reads and
hand back a gapped history.

## Two kinds of reader, two kinds of protection

- **Readers this process can see.** A live in-process `stream` registers its
  durable cursor, and `compact` refuses to truncate a sequence one of them
  still needs, failing `reader_behind` with the checkpoint it declined to
  truncate below.
- **Readers this process cannot see.** A poller of `entries`, or a follower in
  another process, is covered by the read-side `compacted` guard instead. There
  is no way to register their cursors, so the answer is a typed failure and a
  resync point rather than a refusal to compact.

## Resyncing

A reader that fails with `compacted` recovers in two calls: read
`latestCheckpoint(runId)`, apply `checkpoint.state`, then continue from
`stream({ runId, afterSequence: checkpoint.seq })`.

`latestCheckpoint` returns the run's most recent checkpoint whether or not it
has been compacted, so it is the resync point in both cases.

## The automatic policy

`SqlJournalOptions.compaction` turns the manual calls into a policy:

```ts
import { SqlJournal } from "@smthrs/journal"

const layer = SqlJournal.layer({
  capacity: 1024,
  overflow: "reject",
  compaction: {
    entryThreshold: 5_000,
    capture: (runId, upTo) => captureReplayState(runId, upTo)
  }
})
```

Once a run's committed entry count reaches `entryThreshold`, the journal asks
`capture` for the caller's replay state at the run's durable tail, writes it as
a checkpoint at that sequence, and compacts below it.

The policy is the journal's own post-commit maintenance rather than a caller's
entrypoint, so it holds no fence and needs no lease. It only ever
truncates below a tail the run's own commits produced, and a retry after a
reclaim compacts the same committed prefix the live owner sees.

Three properties of the hook matter when you write `capture`:

- It runs after the triggering commit's allocation permit is free. Lossy
  commits schedule one scoped maintenance fiber per compacting run, so capture
  and compaction never occupy the queue-draining fiber. Capture may read or
  emit through the journal while other runs continue committing.
- It is interrupted after 30 seconds, so caller code cannot wedge journal
  admission indefinitely.
- A failed or refused attempt, whether a live stream behind the boundary or a
  `capture` failure, is logged at warning, damped for `entryThreshold` further
  committed entries while the run's policy counter is retained, and never
  surfaced to the emit that triggered it.

`flush` waits for queued writes and registered automatic maintenance attempts.
The attempt is registered before its triggering batch settles, so flush cannot
miss it. Scope closure flushes before interrupting the maintenance scope.
Durable emits still await their own policy attempt after commit.

Flush also retires per-run barriers and policy counters when there are no
admissions, writes, queued entries, barrier waiters, live readers, or maintenance
using the run. A later commit seeds its policy counter from durable history
again, including after a previously damped failure. Sequence allocation floors
remain in memory: dropped entries and rolled-back transactions can consume
sequences that cannot be recovered from durable rows. Retirement does not
permit those sequences to be reused.

## Retries are idempotent

A `compact` whose checkpoint is already the floor returns `deleted: 0` rather
than failing. The rows below it are already gone.

## Producer identities survive compaction

Compaction retains each deleted event's producer identity, event ID, original
canonical sequence, and SHA-256 fingerprint of its encoded type, payload, and
metadata in `flows_journal_dedup`. These records commit in the same transaction
as event deletion and the floor advance. They contain no replay payload.

An exact producer retry returns `Duplicate` with the original sequence, even
after reopening the database. Changed content fails `idempotency_conflict`;
`dedupe: "identity"` keeps its identity-only behavior. Queued retries cannot
append another row or enter the checkpoint suffix. Owner fencing still applies.
The retained identities also preserve each producer's automatic `sourceSeq`
allocation floor when all its event rows have been compacted.

Identity records have no expiry and survive later compactions. Storage therefore
remains proportional to the number of compacted identities, while event payloads
can be reclaimed. Migration `0004_dedup` adds this retention for subsequent
compactions; identities deleted before the upgrade cannot be reconstructed.

## Related reading

- [Compact a long-running run](../guides/compact-a-run.md) is the task-shaped
  version of this page.
- [Run a read-only follower](/docs/guides/sync-followers/) covers a follower
  that meets the floor.
- [Retention](/docs/guides/retention/) covers what a deployment keeps overall.
