---
title: "Troubleshooting"
description: "Every JournalError code, the three failures that are not errors at all, what causes each, and what to change."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/journal/docs/troubleshooting.md"
---

Every journal operation fails with a `JournalError` carrying a stable `code`.
Find your code below. Three common problems produce no error at all, and they
are at the end.

The full error schema is in the [API reference](/reference/api/). Every Smithers error
code across every package, this one's included, is listed under
[`@smthrs/journal` error codes](https://smithers.sh/docs/reference/errors/#smthrsjournal).

## sink_failed with "consensus guard failed"

**What happened.** A fenced write, meaning `emitDurable`, `checkpoint`, or
`compact`, asked the consensus strategy whether the owner still holds the run
and the strategy could not answer: with `SqlConsensus`, its
`flows_consensus_leases` table is missing or the database refused the read.

**What to change.** Run the journal's migration set before building the
journal, or take `@smthrs/engine-store/Migrations`'s `sets`, which is the
whole durable schema in dependency order. A strategy failure is never
reported as `fence_lost`. See
[Installation](/installation/#what-a-fenced-write-needs).

This is a composition problem, not a race. It is `sink_failed` rather than
`fence_lost` precisely so the two cannot be confused.

## fence_lost

**What happened.** The run no longer records the owner you supplied. Either
another process reclaimed it, or its status is no longer `running`.

**What to change.** Stop writing. `fence_lost` is ownership news, not a
transient failure: retrying with the same token cannot succeed, and reaching for
`emitDurableUnfenced` to get past it writes exactly the zombie entry the fence
exists to reject. See [The owner fence](/concepts/owner-fence/).

## invalid_event

**What happened.** The input violates the journal's contract before anything
was allocated. The common causes are:

- An identifier that is empty, longer than 1,024 UTF-16 code units, carrying an
  unpaired surrogate, or carrying a NUL.
- An owner that is missing, null, or not an `OwnerId`, most often a fractional
  or negative `pid`.
- A payload nested past `Redaction.maxDepth` (256 container edges).
- An encoded `payload` plus `meta` larger than the layer's `maxEntryBytes`, when
  that option is set.

**What to change.** Fix the argument. A refused event costs no sequence and
leaves no gap, so nothing needs cleaning up. On a fenced call, note that
`invalid_event` rather than `fence_lost` means the problem is the token you
passed, not who owns the run.

## idempotency_conflict

**What happened.** A producer identity `(runId, sourceId, sourceSeq)` was
re-emitted with different content, under the default `dedupe: "content"`.

**What to change.** Either stop reusing the sequence for a different event, or
declare `dedupe: "identity"` if the sequence is derived from the event's own
content and a collision genuinely is the same event observed twice.

If the failure surfaced from `flush` rather than from the emit, the original
entry had been evicted from the in-process index, so admission had no resident
entry to compare against. That changes where you see the failure, not whether
it happens. See
[Producer identity and idempotency](/concepts/idempotency/).

## Sequence exhaustion

**What happened.** `invalid_event` reports an exhausted canonical sequence
range. A queued admission can encounter this at `flush` if another writer
reaches the limit before the batch commits.

**What to change.** Start a new run. Ordinary overlapping writers do not cause
sequence conflicts: the queued writer advances an overtaken reservation above
the committed tail. See [Commit ordering](/concepts/two-channels/#commit-ordering).

## queue_overflow

**What happened.** The lossy admission queue is full and the layer's `overflow`
is `reject`.

**What to change.** Raise `capacity`, or choose a dropping policy if losing
telemetry is acceptable: `drop-newest` returns a `Dropped` receipt, and
`drop-oldest` returns `Accepted` with an `evicted` count. If the queue is full
because the writer is not draining, look for a `flush` or a long transaction
holding the write lock.

## journal_closed

**What happened.** The operation ran against a closed journal. Either the
layer's scope was released and the admission queue is gone, or the composition
provided `Journal.layerNoop()`.

**What to change.** Keep the journal's scope open for as long as callers hold
the service, or provide a real layer where one is required.

## sink_failed

**What happened.** The database failed on a write path. The cause carries the
underlying `DatabaseError`.

**What to change.** Read the cause first: a missing table is a composition
problem, and a locked or unreadable file is an operational one. A transient
outage is not permanent for the journal. The writer fiber survives a failed
batch, and `emitDurable` opens its own transaction inline, so the durable
channel works again as soon as the database is healthy.

## read_failed

**What happened.** The database failed on a read path: `entries`, `stream`, or
the floor read behind them.

**What to change.** Treat it as a retryable storage condition rather than a
journal defect. It is a separate code from `unknown` for exactly that reason.

## decode_failed

**What happened.** A persisted row no longer matches the schema that reads it.

**What to change.** This is schema drift, not a caller mistake. Check that the
migration set the database was built with matches the package version reading
it.

## projection_failed

**What happened.** A projection's `reduce` failed, which ends the projection
stream.

**What to change.** Fix the reducer. The journal is unaffected: later emissions
still succeed, and a fresh `project` call folds the same history again from the
start. Make a reducer that meets an entry it does not recognize return the state
unchanged.

## checkpoint_invalid

**What happened.** One of two things:

- `checkpoint` was given a `seq` that names no committed entry of the run, or
  one at or below the run's compaction floor. In the second case the failure
  carries the floor in `checkpointSeq`.
- `compact` found no checkpoint to truncate below, either at all or at the
  `upTo` you named.

**What to change.** Checkpoint a committed sequence above the floor before
compacting to it. See [Compact a long-running run](/guides/compact-a-run/).

## reader_behind

**What happened.** `compact` refused because a live in-process `stream` still
needs a sequence the truncation would delete. `checkpointSeq` is the checkpoint
it declined to truncate below.

**What to change.** Let the reader catch up, or drop it, then compact again.
Readers in other processes cannot be seen from here, so they are protected by
the read-side `compacted` guard rather than by this refusal.

## compacted

**What happened.** A read started below the run's compaction floor.
`checkpointSeq` carries the floor.

**What to change.** Resync from the checkpoint: read `latestCheckpoint(runId)`,
apply its `state`, and continue from
`stream({ runId, afterSequence: checkpoint.seq })`. The worked version is in
[Compact a long-running run](/guides/compact-a-run/#resync-a-reader).

## unknown

**What happened.** A journal defect that no other code classifies.

**What to change.** This code is reserved for genuinely unclassified failures.
Report it with the message and cause.

## A stream or a projection never finishes

**What happened.** `stream` and `project` replay a run's history and then follow
its tail. Following is the point, so neither completes on its own, and a
`Stream.runCollect`, `Stream.runDrain`, or `Stream.runLast` with no bound hangs
forever.

**What to change.** Bound the stream: `Stream.take(n)` for a snapshot,
`Stream.takeUntil` for a condition, or a forked fiber you interrupt when the
view is torn down. See [Fold a run into a projection](/guides/fold-a-projection/#bound-the-stream).

## A write hangs inside transact

**What happened.** The body of a `transact` called `flush`, or did work that
waits on something outside the transaction.

**What to change.** Keep a `transact` body to storage work only: no flow
bodies, no host calls, no waits. `flush` in particular waits on the queued
lossy writer, which is waiting on the transaction you are holding. See
[Commit state and its entry together](/guides/commit-state-and-entry/).

## Entries are missing from a live tail

**What happened.** `changes` is a bounded sliding buffer sized by the layer's
`capacity`. A slow subscriber loses entries with no error and no gap signal.
`changes` also carries only the entries this process commits; another writer on
the same database publishes into its own buffer.

**What to change.** Use `stream` wherever a missing entry would be a
correctness bug. It is the lossless follower, it reports sink losses, and it
rechecks the durable tail rather than trusting one process's buffer. See
[Read and follow a run](/guides/read-a-run/).

If a lossy entry is missing from a read rather than from a tail, `flush` first:
`emitLossy` returns before its entry is committed.
