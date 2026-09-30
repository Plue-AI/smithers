---
title: "Compact a long-running run"
description: "Checkpoint a run's replay state, truncate the entries below it, resync a reader that fails with compacted, and hand the work to the automatic policy."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/journal/docs/guides/compact-a-run.md"
---

Compaction drops the entries a run no longer needs to replay. It is off by
default, so nothing here happens unless you ask for it.

Every step is fenced: `checkpoint` and `compact` both take an `OwnerId` and
both need the run claimed and activated through the journal's `Consensus`
strategy, which [`@smthrs/run-store`](https://run-store.smithers.sh/reference/api/) drives. See
[Installation](/installation/#what-a-fenced-write-needs).

## Checkpoint the replay state

Capture whatever your reader needs to resume, and pin it to a committed
sequence:

```ts
import { Journal } from "@smthrs/journal"
import * as Effect from "effect/Effect"

const checkpointTail = Effect.gen(function*() {
  const journal = yield* Journal.Journal

  const page = yield* journal.entries({ runId, limit: 1000 })
  const tip = page.entries.at(-1)
  if (tip === undefined) return

  yield* journal.checkpoint({ runId, seq: tip.seq, state: { started: 3, finished: 2 } }, owner)
})
```

`state` round-trips verbatim; the journal never interprets it and never redacts
it. A value that must not persist belongs in a `Redacted` field of your own
state schema.

The sequence must name a committed entry and must lie above the run's current
floor, or the write fails `checkpoint_invalid`. Re-checkpointing an uncompacted
sequence replaces its state.

## Truncate below it

```ts
const truncate = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const compacted = yield* journal.compact({ runId }, owner)
  console.log(compacted.deleted, "entries removed below", compacted.checkpointSeq)
})
```

Omit `upTo` to compact to the run's latest checkpoint, or pass a specific
sequence. The deletion and the floor advance commit atomically. The checkpointed
entry itself survives: it holds the run's allocation floor, so a restarted
process can never re-allocate a truncated sequence.

A retried compaction returns `deleted: 0` rather than failing.

## Handle a refusal

`compact` refuses in three typed ways, and each asks for something different:

- `checkpoint_invalid`: the run has no checkpoint to truncate below, or none at
  the sequence you named. Write one first.
- `reader_behind`: a live in-process `stream` still needs a sequence the
  truncation would delete. `checkpointSeq` carries the checkpoint it declined
  to truncate below. Wait for the reader, or drop it.
- `fence_lost`: another process owns the run. Stop; a zombie owner must not
  truncate history behind a live successor.

## Resync a reader

A reader whose cursor is below the floor fails with `compacted`, carrying the
floor in `checkpointSeq`. Recovery is the checkpoint plus the tail after it:

```ts
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"

const resync = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  return yield* journal.stream({ runId }).pipe(
    Stream.catchTag("@smthrs/journal/JournalError", (failure) =>
      failure.code === "compacted"
        ? Stream.unwrap(Effect.gen(function*() {
          const checkpoint = yield* journal.latestCheckpoint(runId)
          if (Option.isNone(checkpoint)) return Stream.fail(failure)
          return journal.stream({ runId, afterSequence: checkpoint.value.seq })
        }))
        : Stream.fail(failure)),
    Stream.take(100),
    Stream.runCollect
  )
})
```

`latestCheckpoint` returns the run's most recent checkpoint whether or not it
has been compacted, so the same call serves both cases.

## Hand it to the policy

Set `compaction` on the layer to make this automatic:

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

Once a run's committed entry count reaches `entryThreshold`, the journal
captures your replay state at the run's durable tail, checkpoints it, and
compacts below it. The policy holds no fence, so it needs no owner and no
lease.

Write `capture` to finish quickly and to tolerate being abandoned: it is
interrupted after 30 seconds, and a failed or refused attempt is logged at
warning, damped for `entryThreshold` further entries, and never surfaced to the
emit that triggered it.

## Next steps

- [Checkpoints and compaction](/concepts/compaction/) for the model behind
  these calls.
- [Run a read-only follower](https://smithers.sh/docs/guides/sync-followers/) for a follower that
  meets the floor.
