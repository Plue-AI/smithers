---
title: "Test against a real journal"
description: "Use TestJournal for the production journal over in-memory SQLite, Notifying to inject a crash at an exact transition, and the noop layer for a composition that must not write."
sidebar:
  order: 7
---

The journal is deterministic to test because its only nondeterministic input is
the database, and the database is a layer. This package ships two doubles and
one stub, and none of them reimplements the journal.

Neither double is exported from the root entry point, so import both by
subpath. `TestJournal` binds a Node SQLite database and runs on Node only;
`Notifying` wraps a service and is platform independent.

## Run the real journal in memory

`TestJournal.layer` provides the production `SqlJournal` over a fresh in-memory
database, with migrations already run:

```ts
import * as TestJournal from "@smthrs/journal/test/TestJournal"

const layer = TestJournal.layer()
```

`TestJournalOptions` is `SqlJournalOptions` with `capacity` and `overflow` made
optional, so every option forwards to `SqlJournal.layer` unchanged and a suite
can exercise index-bound eviction, the `maxEntryBytes` entry bound, a custom or
noop redactor, and the compaction policy through the bundle instead of
hand-assembling the layer stack the bundle exists to hide:

```ts
const strict = TestJournal.layer({
  capacity: 8,
  overflow: "drop-oldest",
  sourceEventCache: 2,
  redact: Redaction.makeNoop()
})
```

The defaults are `capacity: 1024` and `overflow: "reject"`.

Fenced writes need the run claimed and activated through the journal's
`Consensus` strategy. This bundle fences through `SqlConsensus`, so a suite
that exercises `emitDurable`, `checkpoint`, or `compact` takes the run through
`Consensus.claim` and `activate` first, or takes the whole engine bundle
instead.

## Get every store over one database

`@smthrs/journal/test/TestJournal` provides the journal and nothing else. For
the journal, run, attempt, and cache services over one database, take
`@smthrs/engine-store/test/TestStores` from
[`@smthrs/engine-store`](/api/engine-store). That bundle includes the run-store
migrations, so the fence has a table to read.

## Inject a crash at an exact transition

`Notifying` wraps a record-of-Effect-methods service so a hook fires around
every operation. The hook runs in the calling fiber, so a hook that dies,
interrupts, or awaits a `Latch` injects crashes, fence loss, and exact
sequencing at any durable transition point:

```ts
import { Journal } from "@smthrs/journal"
import * as Notifying from "@smthrs/journal/test/Notifying"
import * as Effect from "effect/Effect"

const crashAfterCommit = Notifying.layer(
  Journal.Journal,
  (op, order) => op === "emitDurable" && order === "after" ? Effect.die("crash") : Effect.void
)
```

Three details shape how you write a hook:

- `op` is the service method name and `args` are the call arguments, so one
  hook can select the exact call it cares about.
- The `after` firing only happens when the operation succeeds. A failed
  operation is already the interesting event.
- Effect-returning methods and plain `Effect` properties are hooked;
  non-Effect members, such as the `Stream`-returning `stream` and `project`,
  delegate untouched.

`Notifying.layer` reads the real service from the environment and re-provides
the wrapper under the same key, so an existing stack gains a listener without
touching its construction. `Notifying.wrap` is the direct form, and it is
generic over any such service, not just the journal.

## Assert that nothing wrote

`Journal.layerNoop()` provides a closed journal whose every operation fails
`journal_closed`. Use it for a composition that must not write, or to prove a
code path never reaches the journal. Override individual methods to record
calls:

```ts
import { Journal } from "@smthrs/journal"
import * as Effect from "effect/Effect"

const recorded: Array<string> = []

const layer = Journal.layerNoop({
  emitLossy: (input) => {
    recorded.push(input.eventType)
    return Effect.succeed({ _tag: "Accepted", seq: 0, sourceSeq: 0 } as Journal.EmitReceipt)
  }
})
```

The closed stub's `transact` runs its effect directly, because a stub with no
sink has no transaction to open and no crash window to close. A double that
models rollback overrides it.

## Remember the flush barrier

A test that writes on the lossy channel and then reads must `flush` in between.
A durable write needs no flush; it was committed when its receipt arrived.

## Next steps

- [The two channels](../concepts/two-channels.md) for what each receipt proves.
- [Testing flows](/docs/guides/testing-flows/) for the layer above this one.
