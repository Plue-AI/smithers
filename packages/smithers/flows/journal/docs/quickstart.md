---
title: "Quickstart"
description: "Compose a SQLite journal, write on both channels, flush the lossy one, and read the run back: one file, no other Smithers package."
sidebar:
  order: 2
---

This quickstart writes one run's history and reads it back. It uses the
production `SqlJournal` layer over a real SQLite file, so nothing here is a
test double, and it needs no other Smithers package.

By the end you will have seen a durable receipt, a lossy receipt, the flush
barrier that makes the lossy entry readable, and a payload that arrives back
redacted.

## Prerequisites

- Node.js 26.4.0 or later, where the built-in SQLite module lives.
- An ESM package (`"type": "module"`, because the program ends in a top-level
  `await`) with the journal, the database it writes through, and `effect`
  installed. See [Installation](./installation.md) for why `effect` is pinned.

Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

## Compose the layer

Create `quickstart.ts`. `SqlJournal.layer` needs a SQL client and a durable
writer, and `Migrations.layer` creates the journal's tables before the journal
is exposed:

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal, JournalEvent, Migrations, SqlJournal } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: "quickstart.db" })
)

const journalLayer = SqlJournal.layer({ capacity: 1024, overflow: "reject" }).pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, database))
)
```

`capacity` bounds two things at once: how many entries the lossy admission
queue holds, and how many the `changes` buffer keeps for a slow subscriber.
`overflow: "reject"` makes a full queue a typed `queue_overflow` failure rather
than a silent drop.

## Write on both channels

Identifiers are branded, so cast the strings once at the edge:

```ts
const runId = "run-1" as JournalEvent.RunId
const sourceId = "engine" as JournalEvent.SourceId

const program = Effect.gen(function*() {
  const journal = yield* Journal.Journal

  const created = yield* journal.emitDurableUnfenced({
    runId,
    sourceId,
    eventType: "run.created",
    payload: { flow: "build", token: "ghp_0123456789abcdefghijklmnopqrstuvwxyz" }
  })
  console.log("durable:", created._tag, "seq", created.seq)

  yield* journal.emitLossy({
    runId,
    sourceId,
    eventType: "step.progress",
    payload: { step: "compile", percent: 40 }
  })
  yield* journal.flush

  const page = yield* journal.entries({ runId, limit: 100 })
  for (const entry of page.entries) {
    console.log(entry.seq, entry.eventType, JSON.stringify(entry.payload))
  }
  console.log("hasMore:", page.hasMore)
})
```

Two choices in that block are worth naming:

- `emitDurableUnfenced` is the durable write with no ownership fence. It is
  correct here because this program owns no run. The fenced `emitDurable` is
  what an engine calls, and it needs a `flows_runs` row from
  [`@smthrs/run-store`](/api/run-store); see
  [Write a fenced lifecycle event](./guides/write-lifecycle-events.md).
- `flush` is the barrier for the lossy channel only. The durable write was
  already on disk when its receipt arrived; the lossy one is still in the queue
  until `flush` returns.

## Run it

```ts
await Effect.runPromise(program.pipe(Effect.provide(journalLayer), Effect.orDie))
```

Run it with Node, which strips the types itself on 26.4.0 and later:

```bash
node quickstart.ts
```

The output is:

```text
durable: Accepted seq 0
0 run.created {"flow":"build","token":"[REDACTED]"}
1 step.progress {"percent":40,"step":"compile"}
hasMore: false
```

## Read the output

Three things in those four lines are the journal's contract, not incidental:

- **`token` came back as `[REDACTED]`.** The value was scrubbed before the row
  was encoded, so the credential is not in the file and never was. See
  [Redaction](./concepts/redaction.md).
- **The `step.progress` keys came back sorted.** The journal persists canonical
  JSON with object keys sorted, because those bytes are what an idempotency
  check compares. See
  [Producer identity and idempotency](./concepts/idempotency.md).
- **Both entries share one `seq` line.** `seq` is the run's canonical replay
  order across both channels, so the durable and lossy entries interleave in
  one history rather than in two.

## Next steps

- [The two channels](./concepts/two-channels.md): which write to reach for, and
  what each receipt means.
- [Read and follow a run](./guides/read-a-run.md): paging, the lossless
  follower, and the local tail.
- [Test against a real journal](./guides/testing.md): the same layer over an
  in-memory database, in one call.
