/** Killable durable consumer: real SQLite journal, public snapshot RPC and a separate application database. */
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import * as RunCatalog from "../../src/RunCatalog.ts"
import { SyncError } from "../../src/SyncError.ts"
import * as SyncProtocol from "../../src/SyncProtocol.ts"
import * as SyncServer from "../../src/SyncServer.ts"
import * as TestSocket from "../../src/test/TestSocket.ts"
import * as TestSync from "../../src/test/TestSync.ts"

const mode = process.argv[2]
const directory = process.argv[3]
if (
  directory === undefined || ![
    "snapshot-state",
    "snapshot-cursor",
    "snapshot-committed",
    "suffix-committed",
    "finish"
  ].includes(mode ?? "")
) throw new Error("Expected a crash phase or finish, and a temporary directory")

const runId = "durable-snapshot-consumer" as JournalEvent.RunId
const increments = [2, 3, 5, 7, 11, 13]
const Counter = Schema.Struct({ count: Schema.Int })
const cursor = (afterSeq: number): SyncProtocol.RunCursor => ({
  generation: 0,
  runId,
  afterSeq: afterSeq as JournalEvent.Seq
})
const identity = {
  protocolVersion: 1,
  runId,
  lineageId: "counter-lineage",
  projection: "counter",
  projectionVersion: 1
} as const
const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: join(directory, "journal.sqlite") })
)
const storage = SqlJournal.layer({ capacity: 64, overflow: "reject" }).pipe(
  Layer.provideMerge(Layer.provideMerge(JournalMigrations.layer, database))
)
const source = Layer.effect(
  SyncServer.SnapshotSource,
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    return {
      read: (request: SyncProtocol.SnapshotRequest) =>
        Effect.gen(function*() {
          if (
            request.runId !== runId || request.lineageId !== identity.lineageId ||
            request.projection !== identity.projection || request.projectionVersion !== 1
          ) {
            return yield* Effect.fail(new SyncError({ code: "not_found", message: "Unknown projection" }))
          }
          const saved = yield* journal.latestCheckpoint(runId).pipe(Effect.orDie)
          if (Option.isNone(saved)) {
            return yield* Effect.fail(new SyncError({ code: "not_found", message: "No checkpoint" }))
          }
          const state = yield* Schema.decodeUnknownEffect(Counter)(saved.value.state).pipe(Effect.orDie)
          return { ...identity, seq: saved.value.seq, state: { count: state.count } }
        })
    }
  })
).pipe(Layer.provide(storage))
const services = SyncServer.layer.pipe(Layer.provideMerge(Layer.mergeAll(
  storage,
  source,
  RunCatalog.layerStatic([runId]),
  TestSync.layerTrustAllAsOwner
)))
const emit = (value: unknown) =>
  Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(value)}\n`)
  })

const program = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const sql = yield* SqlClient.SqlClient
  if (mode !== "finish") {
    const owner = { hostId: "snapshot-test", pid: process.pid, nonce: "snapshot-owner" }
    // Only the ownership fence is fixture data. Checkpoint creation and deletion
    // of the history prefix go through the real fenced journal APIs.
    yield* sql`CREATE TABLE flows_runs (run_id TEXT PRIMARY KEY, status TEXT,
      owner_host_id TEXT, owner_pid INTEGER, owner_nonce TEXT)`
    yield* sql`INSERT INTO flows_runs VALUES (${runId}, 'running', ${owner.hostId}, ${owner.pid}, ${owner.nonce})`
    for (const increment of increments) {
      yield* journal.emitDurableUnfenced({
        runId,
        sourceId: "writer" as JournalEvent.SourceId,
        eventType: "increment",
        payload: increment
      })
    }
    yield* journal.flush
    yield* journal.checkpoint({
      runId,
      seq: cursor(3).afterSeq,
      state: { count: increments.slice(0, 4).reduce((a, b) => a + b, 0), secret: "private-crash-checkpoint" }
    }, owner)
    yield* journal.compact({ runId, upTo: cursor(3).afterSeq }, owner)
  }
  const consumer = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(join(directory, "consumer.sqlite"))),
    (db) => Effect.sync(() => db.close())
  )
  consumer.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS projection (id INTEGER PRIMARY KEY CHECK(id = 1), count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK(id = 1), seq INTEGER NOT NULL);
    INSERT OR IGNORE INTO projection VALUES (1, 0);
    INSERT OR IGNORE INTO cursor VALUES (1, -1);`)
  const state = () => ({
    count: Number(consumer.prepare("SELECT count FROM projection WHERE id=1").get()!.count),
    seq: Number(consumer.prepare("SELECT seq FROM cursor WHERE id=1").get()!.seq)
  })
  const initial = state()
  const pair = yield* TestSocket.makePair()
  const wire: Array<string> = []
  pair.faults.installFilter((bytes) => {
    wire.push(new TextDecoder().decode(bytes))
    return true
  })
  const client = yield* TestSync.connect(pair)
  const pause = (phase: string) =>
    mode === phase ?
      Effect.gen(function*() {
        yield* emit({ phase, state: state(), cursors: (yield* client.progress).delivered })
        yield* Effect.never
      }) :
      Effect.void
  let snapshots = 0
  const applied: Array<number> = []
  const entries = yield* client.subscribe({
    scope: { _tag: "Run", runId },
    cursors: initial.seq < 0 ? [] : [cursor(initial.seq)],
    onResync: (resync) =>
      Effect.gen(function*() {
        const snapshot = yield* client.snapshot({ ...identity, atLeastSeq: resync.checkpointSeq })
        const decoded = yield* Schema.decodeUnknownEffect(Counter)(snapshot.state).pipe(Effect.orDie)
        snapshots++
        consumer.exec("BEGIN IMMEDIATE")
        consumer.prepare("UPDATE projection SET count=? WHERE id=1").run(decoded.count)
        yield* pause("snapshot-state")
        consumer.prepare("UPDATE cursor SET seq=? WHERE id=1").run(snapshot.seq)
        yield* pause("snapshot-cursor")
        consumer.exec("COMMIT")
        yield* pause("snapshot-committed")
        return cursor(snapshot.seq)
      }),
    apply: (entry) =>
      Effect.gen(function*() {
        const before = state()
        if (entry.seq !== before.seq + 1) return yield* Effect.die(new Error("Non-contiguous durable application"))
        consumer.exec("BEGIN IMMEDIATE")
        consumer.prepare("UPDATE projection SET count=count+? WHERE id=1").run(Number(entry.payload))
        consumer.prepare("UPDATE cursor SET seq=? WHERE id=1").run(entry.seq)
        consumer.exec("COMMIT")
        if (entry.seq === 4) yield* pause("suffix-committed")
        applied.push(entry.seq)
      })
  }).pipe(Stream.takeUntil((entry) => entry.seq === 5), Stream.runCollect)
  yield* emit({
    phase: "complete",
    initial,
    state: state(),
    cursors: (yield* client.progress).delivered,
    snapshots,
    applied,
    delivered: entries.map((entry) => entry.seq),
    retained: (yield* journal.entries({ runId, after: cursor(3).afterSeq, limit: 10 })).entries.map((entry) =>
      entry.seq
    ),
    privateOnWire: wire.join("\n").includes("private-crash-checkpoint")
  })
}).pipe(Effect.provide(services), Effect.scoped)

// TestSocket is in-process, so hold a real event-loop handle at deterministic
// fault barriers. Only the parent sends SIGKILL; there is no cleanup on that path.
const keepAlive = setInterval(() => {}, 1000)
Effect.runPromise(program).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`)
  process.exitCode = 1
}).finally(() => clearInterval(keepAlive))
