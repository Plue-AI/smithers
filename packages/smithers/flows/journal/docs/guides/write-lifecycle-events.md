---
title: "Write a fenced lifecycle event"
description: "Emit a durable lifecycle entry with an OwnerId, handle fence_lost as ownership news rather than an error, and know when the unfenced channel is correct."
sidebar:
  order: 1
---

A lifecycle event is the evidence that a run moved: created, started,
finished, failed. It belongs on the durable channel, and the durable channel is
fenced, so the write also proves the process still owns the run.

## Before you start

The fence is the journal's `Consensus` strategy: a fenced write commits only
while the strategy records the owner as holding the run, so the run must have
been claimed and activated first. [`@smthrs/run-store`](/api/run-store) drives
that for a durable run. See
[Installation](../installation.md#what-a-fenced-write-needs).

## Emit the entry

Pass the owner your process holds for the run:

```ts
import { Journal, JournalEvent } from "@smthrs/journal"
import type * as OwnerId from "@smthrs/journal/OwnerId"
import * as Effect from "effect/Effect"

const runId = "run-1" as JournalEvent.RunId
const sourceId = "engine" as JournalEvent.SourceId

const owner: OwnerId.OwnerId = {
  hostId: "host-1",
  pid: process.pid,
  nonce: "run-1-claim"
}

const started = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  return yield* journal.emitDurable({
    runId,
    sourceId,
    eventType: "run.started",
    payload: { attempt: 1 }
  }, owner)
})
```

The receipt arrives after the transaction commits, so the `seq` it carries is
already on disk. Do not advance the run or expose its result before this
returns: that ordering is the whole reason the channel exists.

## Handle a lost fence

`fence_lost` is not an error to retry. It is news: another process owns this
run now, and this one must stop writing.

```ts
const guarded = started.pipe(
  Effect.catchTag("@smthrs/journal/JournalError", (failure) =>
    failure.code === "fence_lost"
      ? Effect.logWarning("run reclaimed by another owner; standing down").pipe(Effect.as(undefined))
      : Effect.fail(failure))
)
```

Retrying with the same token cannot succeed, and reaching for
`emitDurableUnfenced` to get past it writes exactly the zombie entry the fence
exists to reject.

A neighbouring code needs a different response. `invalid_event` on a fenced
call means the owner you passed is not an `OwnerId`, most often a fractional or
negative `pid`. Fix the argument.

## Give the producer a stable identity

Supply `sourceSeq` when the caller can derive a stable number for the event.
The journal then dedupes a retry against the committed row instead of writing a
second entry:

```ts
const finished = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  return yield* journal.emitDurable({
    runId,
    sourceId,
    sourceSeq: 7 as JournalEvent.SourceSeq,
    eventType: "run.finished",
    payload: { outcome: "succeeded" }
  }, owner)
})
```

An exact retry returns `Duplicate` with the original `seq`. A reused sequence
carrying different content fails `idempotency_conflict`, unless the input
declares `dedupe: "identity"`. See
[Producer identity and idempotency](../concepts/idempotency.md).

## When to use the unfenced channel

`emitDurableUnfenced` is correct for an admission that owns no run and is
first-writer-wins by design: an external trigger delivered by a sweeper, an
import, a repair tool. It is the wrong answer to a `fence_lost`.

## Next steps

- [Commit state and its entry together](./commit-state-and-entry.md) when the
  entry describes a state transition that must not disagree with it.
- [The owner fence](../concepts/owner-fence.md) for what the fence checks and
  why the token lives in this package.
