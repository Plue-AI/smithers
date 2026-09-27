---
title: "@smthrs/journal"
description: "An append-only event history for Effect applications: a lossless lifecycle channel beside a lossy telemetry channel, credentials scrubbed before anything is persisted, and an owner fence that refuses a write from a process that lost the run."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/journal/docs/README.md"
---

`@smthrs/journal` records what a long-running piece of work did, in order, in
SQLite. Rows are appended and never updated, so the history reads the same on
the tenth pass as on the first, and a process that dies halfway through leaves
behind everything it had already committed.

It is a set of [Effect](https://effect.website) services: every write returns a
typed receipt or a typed failure, and the database arrives as a layer you
compose. It belongs to the Smithers durable flow engine, but it runs on its
own: no other Smithers package is required.

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

`effect` is a peer dependency at exactly `4.0.0-rc.115`. Two copies of `effect`
in one program are two sets of service tags, so a journal layer built against
one copy cannot be provided to a program holding the other.

## What it solves

Application logs are the usual answer to "what happened here", and they stop
being an answer the moment another program has to read them. A journal entry is
a typed record with a sequence number, so a supervisor, a resumed run, or a UI
can replay the history instead of parsing it.

- **Two channels, one order.** A lifecycle event ("the run finished") is on
  disk before its call returns. A telemetry event ("40 percent compiled") goes
  through a bounded queue that drops under pressure rather than stalling the
  writer. Both land in one per-run sequence, so the cheap channel cannot
  reorder the expensive one.
- **Every write gets an answer.** An emission returns `Accepted`, `Duplicate`,
  or `Dropped`, and every failure carries one of fourteen stable codes. A
  caller never has to guess whether an entry survived.
- **A retry is not a second event.** Producer identity is
  `(runId, sourceId, sourceSeq)`, unique in the database, so a producer that
  replays after a crash gets `Duplicate` back rather than doubling its history.
- **Credentials never reach the file.** Payloads are scrubbed on the write
  path, before encoding, because a row is permanent and gets replayed verbatim
  to every later reader.
- **A stale process cannot append.** The durable channel takes an owner token
  and commits only while the database still records that owner as the run's
  owner. A process that was replaced fails with `fence_lost` instead of writing
  into a history it no longer owns.
- **State and its entry commit together.** `transact` puts your own writes and
  the entry that describes them in one transaction, so the two can never
  disagree about what happened.
- **A long run stops growing.** A checkpoint pins replay state to a sequence,
  and compaction deletes the entries below it.

## One run, both channels

This program writes a lifecycle event and a telemetry event to the same run,
then reads the run back. It needs Node.js 26.4.0 or later, where the built-in
SQLite module lives, and it writes a real `history.db` in the working
directory:

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal, JournalEvent, Migrations, SqlJournal } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: "history.db" })
)

const journalLayer = SqlJournal.layer({ capacity: 1024, overflow: "reject" }).pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, database))
)

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
})

await Effect.runPromise(program.pipe(Effect.provide(journalLayer), Effect.orDie))
```

```text
durable: Accepted seq 0
0 run.created {"flow":"build","token":"[REDACTED]"}
1 step.progress {"percent":40,"step":"compile"}
```

The token came back as `[REDACTED]` because it was scrubbed before the row was
encoded, so the credential is not in `history.db` and never was. The two
entries share one `seq` line because both channels write one history. The
`flush` is the barrier for the lossy channel only: the durable entry was
already committed when its receipt arrived.

## Where this sits

The journal owns exactly the history and nothing else.
[`@smthrs/flows`](https://flows.smithers.sh/reference/api/) is the engine's barrel: it re-exports this
package as a namespace next to the flow language, the stores, and the runtime
that wires them over one SQLite file, so
`import { Journal } from "@smthrs/flows"` reaches the same code as
`import * as Journal from "@smthrs/journal"`. Depend on the barrel when you
want a working engine, and on this package when the event history is the part
you need: an audit trail, a live feed for a UI, or the replay log of a system
you are building yourself.

The neighboring stores hold what the journal deliberately does not.
Run and attempt state live in [`@smthrs/run-store`](https://run-store.smithers.sh/reference/api/), sealed
step results in [`@smthrs/step-cache`](https://step-cache.smithers.sh/reference/api/), and the durable
deferred and clock tables in [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/), which
composes all of them. Underneath every one of them,
[`@smthrs/database`](https://database.smithers.sh/reference/api/) is the single write boundary they share,
which is what makes `transact` possible.

Above the whole engine sits the
[`smithers` command-line interface](https://cli.smithers.sh/reference/api/), which runs flows out of a
project directory without your composing any of this by hand.

One name collides. [`@smthrs/chain`](https://chain.smithers.sh/reference/api/) also has a journal: an
in-process event array that is a single chain's only state. It is a different
object with a different contract, described in
[the chain journal](https://chain.smithers.sh/concepts/journal/).

## Next steps

- [Installation](/installation/): the database layer, the migration sets a
  journal needs, and which extra table the fenced write path reads.
- [Quickstart](/quickstart/): the program above built one step at a time,
  with what each line of output proves.
- [The two channels](/concepts/two-channels/): which write to reach for,
  what each receipt means, and why sequence gaps are valid.
- [The owner fence](/concepts/owner-fence/): why the durable channel takes
  an owner, and when the unfenced one is correct.
- [Read and follow a run](/guides/read-a-run/): paging, the lossless
  follower, and the buffer that drops for a slow subscriber.
- [Test against a real journal](/guides/testing/): the production layer over
  an in-memory database, and injecting a crash at an exact transition.
- [API reference](/reference/api/): every public export, grouped by namespace.
- [Troubleshooting](/troubleshooting/): every error code, what causes it,
  and what to change.
