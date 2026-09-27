# @smthrs/journal

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://journal.smithers.sh

An append-only event history for [Effect](https://effect.website) applications.
`@smthrs/journal` records what a long-running piece of work did, in order, in
SQLite. Rows are appended and never updated, so the history reads the same on
the tenth pass as on the first, and a process that dies halfway through leaves
behind everything it had already committed.

It is a set of Effect services: every write returns a typed receipt or a typed
failure, and the database arrives as a layer you compose. It belongs to the
Smithers durable flow engine, but it runs on its own, and no other Smithers
package is required.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

`effect` is a peer dependency at exactly `4.0.0-rc.115`. Two copies of `effect`
in one program are two sets of service tags, so a journal layer built against
one copy cannot be provided to a program holding the other.

Node.js 26.4.0 or later is required for the Node SQLite driver. The package
ships as both ESM and CommonJS with TypeScript declarations.

## Write one run and read it back

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
encoded, so the credential is not in `history.db` and never was. `SqlJournal.layer`
needs both database services: `SqlClient` to read through and `DurableWriter`
to write through.

## What the journal guarantees

- **Two channels, one order.** `emitDurable` and `emitDurableUnfenced` are on
  disk before the call returns. `emitLossy` goes through a bounded queue that
  drops under pressure rather than stalling the writer. Both land in one
  per-run `seq`, so the cheap channel cannot reorder the expensive one.
- **Every write gets an answer.** An emission returns `Accepted`, `Duplicate`,
  or `Dropped`, and every failure is a `JournalError` carrying one of fourteen
  stable codes, from `invalid_event` and `fence_lost` through `queue_overflow`
  and `sink_failed`.
- **A retry is not a second event.** Producer identity is
  `(runId, sourceId, sourceSeq)`, unique in the database, so a producer that
  replays after a crash gets `Duplicate` back rather than doubling its history.
- **Credentials never reach the file.** Payloads are scrubbed on the write
  path, before encoding, because a row is permanent and gets replayed verbatim
  to every later reader.
- **A stale process cannot append.** `emitDurable` takes an `OwnerId` and
  commits only while the database still records that owner as the run's owner.
  A process that was replaced fails `fence_lost` instead of writing into a
  history it no longer owns.
- **State and its entry commit together.** `transact` runs your own writes and
  the entries describing them in one transaction and defers publication until
  it commits, so the two can never disagree. Committing locally is not remote
  atomicity: external effects still need idempotency keys, fencing tokens, or
  compensation.
- **A long run stops growing.** A checkpoint pins replay state to a sequence,
  and `compact` deletes the entries below it.

`Seq` is canonical per-run replay order; `SourceSeq` identifies producer
retries. Rejected and dropped admissions may consume either sequence, so gaps
are valid.

Post-commit compaction preserves the durable writer caller's Effect
interruption policy. Ordinary callers can interrupt a slow capture; a write
inside an uninterruptible cancellation finalizer keeps that policy, so
journaling cannot abandon the cleanup that follows the commit.

## Public API

The root exports each module as a namespace, and each is also importable from
the matching `@smthrs/journal/*` subpath. The
[API reference](https://journal.smithers.sh/reference/api/) lists every export
with its one-line summary.

| Namespace        | What it holds                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Journal`        | The service and its operations, the `Checkpoint` and `Compacted` models, typed errors, receipts, read options, constructors, and the no-op layer. |
| `JournalEvent`   | Branded `RunId`, `Seq`, `SourceId`, and `SourceSeq`; the `Input` and committed `Entry` schemas; deterministic `makeEventId`.                      |
| `SqlJournal`     | `SqlJournalOptions`, `CompactionPolicy`, and the database-backed `layer(options)`.                                                                |
| `OwnerId`        | The fencing token `emitDurable` accepts, carrying `hostId`, `pid`, and `nonce`.                                                                   |
| `Redaction`      | The payload redaction applied to entries before they are written, its rule set, and `makeNoop`.                                                   |
| `Projection`     | The reproducible `Projection` model and its identity constructor.                                                                                 |
| `JournalMetrics` | The `flows_journal_writes` counter and the per-channel views `SqlJournal` updates on every emission receipt.                                      |
| `Migrations`     | `set`, `run`, and `layer` for this package's two tables: `flows_journal_events` with its event-type index, and `flows_journal_checkpoints`.       |

Two test entry points sit outside the root:
`@smthrs/journal/test/TestJournal` provides the production journal over an
in-memory database (Node only), and `@smthrs/journal/test/Notifying` wraps a
service so a hook fires around every operation, which is how you inject a crash
at an exact transition.

## What a fenced write needs

`emitDurable`, `checkpoint`, and `compact` gate their write on a `flows_runs`
row that still names the supplied owner. That table belongs to
[`@smthrs/run-store`](https://run-store.smithers.sh), so a composition that
installs only this package's migrations fails all three with `sink_failed`
carrying `no such table: flows_runs`. Install run-store's migration set
alongside this one, or take the whole durable schema from
[`@smthrs/engine-store`](https://engine-store.smithers.sh).

`emitDurableUnfenced` is the sanctioned path for a genuinely ownerless
admission, such as an import or a repair tool. Reaching for it to dodge
`fence_lost` writes exactly the zombie entry the fence exists to reject.

## Where the journal sits

The journal holds the history and nothing else. Run and attempt state live in
[`@smthrs/run-store`](https://run-store.smithers.sh), sealed step results in
[`@smthrs/step-cache`](https://step-cache.smithers.sh), and the durable
deferred and clock tables in
[`@smthrs/engine-store`](https://engine-store.smithers.sh). Those stores hold
the executable state, which is not derived from journal entries; `transact` is
what keeps the two halves consistent, because every one of them writes through
the same `DurableWriter`.

SQLite and PostgreSQL share this journal and migration ladder; see
[database configuration](../database/docs/concepts/sqlite-only.md).

Rewinding SQL histories expose `Journal.Service.generation(runId)`, which reads
`{ generation, afterSeq }` from `flows_journal_generations` (initially zero and
`-1`). The SQL layer installs this table idempotently on existing databases.
Time travel increments the generation in the archive transaction. Append-only
adapters may omit the operation; truncating adapters must implement it. The
`JournalGeneration.initialize` subpath shares the table installation with time
travel without adding a migration below an already applied migration block.

## Documentation

- [State and event authority](./docs/concepts/state-event-authority.md)
- [Installation](https://journal.smithers.sh/installation/)
- [Quickstart](https://journal.smithers.sh/quickstart/)
- [The two channels](https://journal.smithers.sh/concepts/two-channels/)
- [The owner fence](https://journal.smithers.sh/concepts/owner-fence/)
- [Checkpoints and compaction](https://journal.smithers.sh/concepts/compaction/)
- [API reference](https://journal.smithers.sh/reference/api/)
- [Troubleshooting](https://journal.smithers.sh/troubleshooting/)

## License

MIT
