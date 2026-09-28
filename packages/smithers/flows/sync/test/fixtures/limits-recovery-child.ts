/** Exact byte ceilings through disk, JSON RPC, live admission and a fresh process. */
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Deferred, Effect, Fiber, Layer, Redacted, Stream } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import assert from "node:assert/strict"
import { join } from "node:path"
import * as BranchCommands from "../../src/BranchCommands.ts"
import * as BranchProtocol from "../../src/BranchProtocol.ts"
import * as BranchShare from "../../src/BranchShare.ts"
import * as RunCatalog from "../../src/RunCatalog.ts"
import { SyncError } from "../../src/SyncError.ts"
import * as Protocol from "../../src/SyncProtocol.ts"
import * as SyncServer from "../../src/SyncServer.ts"
import * as TestSocket from "../../src/test/TestSocket.ts"
import * as TestSync from "../../src/test/TestSync.ts"

const [mode, directory] = process.argv.slice(2)
if ((mode !== "seed" && mode !== "reopen") || !directory) throw new Error("Expected seed/reopen and directory")
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const journalLayer = SqlJournal.layer({ capacity: 32, overflow: "reject" }).pipe(Layer.provideMerge(
  Layer.provideMerge(
    JournalMigrations.layer,
    Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename: join(directory, "limits.sqlite") }))
  )
))
const base = Layer.mergeAll(
  journalLayer,
  BranchShare.layerHmac({
    activeKid: "primary",
    keys: [{ kid: "primary", secret: Redacted.make("disk-limits-test-0123456789abcde") }]
  }),
  TestSync.layerTrustAllAsOwner
)
const program = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const share = yield* BranchShare.BranchShare
  const sql = yield* SqlClient.SqlClient
  let commandsTested = 0
  let framesTested = 0
  let snapshotsTested = 0
  let malformedRecordsTested = 0
  if (mode === "seed") yield* sql`CREATE TABLE snapshots (run TEXT PRIMARY KEY, body TEXT NOT NULL)`
  for (const limit of [4096, BranchCommands.defaultMaxCommandBytes]) {
    for (const prefix of ["", "é😀\\\"\n"]) {
      for (const offset of [-1, 0, 1]) {
        const branchId = `command-${limit}-${prefix.length}-${offset}-${
          "é".repeat(prefix === "" ? 0 : 100)
        }` as BranchProtocol.BranchId
        const runId = BranchProtocol.branchRunId(branchId)
        const capability = yield* share.mint({
          branchId,
          capabilityId: "limit-reader",
          access: "write",
          ttlMs: 120_000
        })
        const blank = yield* BranchCommands.submission({
          branchId,
          commandId: "c" as BranchProtocol.CommandId,
          participantId: "alice" as BranchProtocol.ParticipantId,
          name: "branch.say",
          args: prefix
        })
        const submission = { ...blank, args: prefix + "x".repeat(limit + offset - bytes(blank)) }
        assert.equal(bytes(submission), limit + offset)
        // What the journal stores: the submission plus its verified capability id.
        const admitted = { ...submission, capabilityId: "limit-reader" }
        const attached = yield* Deferred.make<void>()
        const observed = Journal.Journal.of({
          ...journal,
          stream: (request) =>
            journal.stream(request).pipe(
              Stream.onStart(Deferred.succeed(attached, undefined))
            )
        })
        const server = yield* SyncServer.makeLive.pipe(
          Effect.provideService(Journal.Journal, observed),
          Effect.provide(RunCatalog.layerStatic([runId]))
        )
        const request = { protocolVersion: 1, scope: { _tag: "Run", runId } as const, cursors: [], capability }
        yield* Effect.gen(function*() {
          const remote = yield* TestSync.connect(yield* TestSocket.makePair()).pipe(
            Effect.provideService(SyncServer.SyncServer, server)
          )
          if (mode === "seed") {
            const live = yield* remote.subscribe({
              ...request,
              apply: (entry) =>
                Effect.sync(() => {
                  assert.deepEqual(entry.payload, admitted)
                })
            })
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
            yield* Deferred.await(attached)
            const commands = yield* BranchCommands.makeLiveWith({ maxCommandBytes: limit })
            if (offset > 0) {
              assert.equal((yield* Effect.flip(commands.submit({ capability, submission }))).code, "frame_too_large")
              yield* Fiber.interrupt(live)
              assert.deepEqual((yield* remote.progress).applied, [])
            } else {
              yield* commands.submit({ capability, submission })
              assert.deepEqual((yield* Fiber.join(live)).map((entry) => entry.payload), [admitted])
            }
          }
          const stored = (yield* journal.entries({ runId, limit: 2 })).entries
          assert.deepEqual(stored.map((entry) => entry.payload), offset > 0 ? [] : [admitted])
          if (offset <= 0) {
            const fresh = yield* TestSync.connect(yield* TestSocket.makePair()).pipe(
              Effect.provideService(SyncServer.SyncServer, server)
            )
            const entries = yield* fresh.subscribe({
              ...request,
              apply: (entry) =>
                Effect.sync(() => {
                  assert.deepEqual(entry.payload, admitted)
                })
            })
              .pipe(Stream.take(1), Stream.runCollect)
            assert.deepEqual(entries.map((entry) => entry.payload), [admitted])
            assert.deepEqual((yield* fresh.progress).applied, [{ generation: 0, runId, afterSeq: 0 }])
            const reconstructed = yield* BranchCommands.makeLiveWith({ maxCommandBytes: limit })
            assert.equal((yield* reconstructed.submit({ capability, submission })).status, "duplicate")
            assert.equal((yield* journal.entries({ runId, limit: 2 })).entries.length, 1)
          }
        }).pipe(Effect.scoped)
        commandsTested++
      }
    }
  }
  for (const limit of [4096, Protocol.defaultMaxFrameBytes]) {
    for (const offset of [-1, 0, 1]) {
      const runId = `frame-${limit}-${offset}` as JournalEvent.RunId
      const sourceId = "source" as JournalEvent.SourceId
      // The event-id encoding is written independently of makeEventId. All
      // contemporary millisecond timestamps occupy 13 ASCII digits.
      const envelope = {
        runId,
        seq: 0,
        eventId: `flows:event:${runId.length}:${runId}6:source0`,
        sourceId,
        sourceSeq: 0,
        emittedAtMs: 1_700_000_000_000,
        eventType: "bytes",
        payload: "é😀\\\"\n",
        meta: null
      }
      const payload = envelope.payload + "x".repeat(limit + offset - bytes(envelope))
      if (mode === "seed") {
        yield* journal.emitDurableUnfenced({
          runId,
          sourceId,
          sourceSeq: 0 as JournalEvent.SourceSeq,
          eventType: "bytes",
          payload,
          meta: null
        })
      }
      const stored = (yield* journal.entries({ runId, limit: 2 })).entries
      assert.equal(stored.length, 1)
      assert.equal(bytes(stored[0]), limit + offset)
      assert.equal(stored[0]!.payload, payload)
      const server = yield* SyncServer.makeLiveWith({ maxFrameBytes: limit }).pipe(
        Effect.provide(RunCatalog.layerStatic([runId]))
      )
      for (const live of [false, true]) {
        yield* Effect.gen(function*() {
          const served = live
            ? SyncServer.SyncServer.of({
              ...server,
              read: () => Effect.succeed({ entries: [], cursors: [], done: true })
            })
            : server
          const remote = yield* TestSync.connect(yield* TestSocket.makePair()).pipe(
            Effect.provideService(SyncServer.SyncServer, served)
          )
          let applied = 0
          const read = remote.subscribe({
            scope: { _tag: "Run", runId },
            cursors: [],
            apply: (entry) =>
              Effect.sync(() => {
                assert.equal(entry.payload, payload)
                applied++
              })
          }).pipe(Stream.take(1), Stream.runCollect)
          if (offset > 0) {
            const failure = yield* Effect.flip(read)
            assert.ok(failure instanceof SyncError)
            assert.equal(failure.code, "frame_too_large")
            assert.equal(applied, 0)
            assert.deepEqual((yield* remote.progress).applied, [])
          } else {
            assert.equal((yield* read)[0]!.payload, payload)
            assert.equal(applied, 1)
            assert.deepEqual((yield* remote.progress).applied, [{ generation: 0, runId, afterSeq: 0 }])
          }
        }).pipe(Effect.scoped)
      }
      framesTested++
      const identity = {
        protocolVersion: 1 as const,
        runId,
        lineageId: "byte-lineage",
        projection: "bytes",
        projectionVersion: 1
      }
      const blank: Protocol.Snapshot = { ...identity, seq: 0 as JournalEvent.Seq, state: "é😀\\\"\n" }
      const snapshot: Protocol.Snapshot = {
        ...blank,
        state: String(blank.state) + "x".repeat(limit + offset - bytes(blank))
      }
      assert.equal(bytes(snapshot), limit + offset)
      if (mode === "seed") yield* sql`INSERT INTO snapshots VALUES (${runId}, ${JSON.stringify(snapshot)})`
      const source: SyncServer.SnapshotSource["Service"] = {
        read: (request) =>
          Effect.gen(function*() {
            const rows = yield* sql<{ body: string }>`SELECT body FROM snapshots WHERE run=${request.runId}`.pipe(
              Effect.orDie
            )
            return JSON.parse(rows[0]!.body) as Protocol.Snapshot
          })
      }
      const snapshotServer = yield* SyncServer.makeLiveWith({ maxFrameBytes: limit }).pipe(
        Effect.provide(RunCatalog.layerStatic([runId])),
        Effect.provideService(SyncServer.SnapshotSource, source)
      )
      yield* Effect.gen(function*() {
        const remote = yield* TestSync.connect(yield* TestSocket.makePair()).pipe(
          Effect.provideService(SyncServer.SyncServer, snapshotServer)
        )
        const fetch = remote.snapshot({ ...identity, atLeastSeq: 0 as JournalEvent.Seq })
        if (offset > 0) assert.equal((yield* Effect.flip(fetch)).code, "frame_too_large")
        else assert.deepEqual(yield* fetch, snapshot)
        assert.deepEqual((yield* remote.progress).delivered, [])
        assert.deepEqual((yield* remote.progress).applied, [])
      }).pipe(Effect.scoped)
      snapshotsTested++
    }
  }
  for (const malformed of [true, false]) {
    const branchId = `invalid-history-${malformed}` as BranchProtocol.BranchId
    const runId = BranchProtocol.branchRunId(branchId)
    const capability = yield* share.mint({ branchId, capabilityId: "invalid-reader", access: "write", ttlMs: 60_000 })
    const payload = malformed ? { commandId: "invalid" } : {
      branchId: "foreign",
      commandId: "invalid",
      participantId: "alice",
      name: "branch.say",
      args: "wrong branch",
      target: ""
    }
    if (mode === "seed") {
      yield* journal.emitDurableUnfenced({
        runId,
        sourceId: "writer" as JournalEvent.SourceId,
        eventType: BranchProtocol.CommandEvent,
        payload
      })
    }
    const server = yield* SyncServer.makeLive.pipe(Effect.provide(RunCatalog.layerStatic([runId])))
    for (const live of [false, true]) {
      yield* Effect.gen(function*() {
        const served = live
          ? SyncServer.SyncServer.of({
            ...server,
            read: () => Effect.succeed({ entries: [], cursors: [], done: true })
          })
          : server
        const remote = yield* TestSync.connect(yield* TestSocket.makePair()).pipe(
          Effect.provideService(SyncServer.SyncServer, served)
        )
        let applied = 0
        const failure = yield* Effect.flip(
          remote.subscribe({
            scope: { _tag: "Run", runId },
            cursors: [],
            capability,
            apply: () =>
              Effect.sync(() => {
                applied++
              })
          }).pipe(Stream.take(1), Stream.runDrain)
        )
        assert.ok(failure instanceof SyncError)
        assert.equal(failure.code, malformed ? "decode_failed" : "protocol_violation")
        assert.equal(typeof failure.cause, "string")
        assert.equal(applied, 0)
        assert.deepEqual((yield* remote.progress).applied, [])
      }).pipe(Effect.scoped)
    }
    const commands = yield* BranchCommands.makeLive
    const failure = yield* Effect.flip(commands.submit({
      capability,
      submission: yield* BranchCommands.submission({
        branchId,
        commandId: "new" as BranchProtocol.CommandId,
        participantId: "alice" as BranchProtocol.ParticipantId,
        name: "branch.say"
      })
    }))
    assert.equal(failure.code, malformed ? "decode_failed" : "protocol_violation")
    assert.equal(typeof failure.cause, "string")
    assert.deepEqual((yield* journal.entries({ runId, limit: 10 })).entries.map((entry) => entry.payload), [payload])
    malformedRecordsTested++
  }
  for (const mismatch of ["lineageId", "projectionVersion", "protocolVersion"] as const) {
    const runId = `invalid-snapshot-${mismatch}` as JournalEvent.RunId
    const identity = {
      protocolVersion: 1 as const,
      runId,
      lineageId: "expected-lineage",
      projection: "count",
      projectionVersion: 1
    }
    const body = {
      ...identity,
      seq: 0,
      state: { count: 1 },
      [mismatch]: mismatch === "lineageId" ? "foreign-lineage" : 2
    }
    if (mode === "seed") yield* sql`INSERT INTO snapshots VALUES (${runId}, ${JSON.stringify(body)})`
    const server = yield* SyncServer.makeLive.pipe(
      Effect.provide(RunCatalog.layerStatic([runId])),
      Effect.provideService(SyncServer.SnapshotSource, {
        read: (request) =>
          Effect.gen(function*() {
            const rows = yield* sql<{ body: string }>`SELECT body FROM snapshots WHERE run=${request.runId}`.pipe(
              Effect.orDie
            )
            return JSON.parse(rows[0]!.body) as Protocol.Snapshot
          })
      })
    )
    yield* Effect.gen(function*() {
      const remote = yield* TestSync.connect(yield* TestSocket.makePair()).pipe(
        Effect.provideService(SyncServer.SyncServer, server)
      )
      const failure = yield* Effect.flip(remote.snapshot({ ...identity, atLeastSeq: 0 as JournalEvent.Seq }))
      assert.equal(failure.code, "protocol_violation")
      assert.equal(typeof failure.cause, "string")
      assert.deepEqual((yield* remote.progress).applied, [])
    }).pipe(Effect.scoped)
    malformedRecordsTested++
  }
  process.stdout.write(
    `${
      JSON.stringify({
        mode,
        commandsTested,
        framesTested,
        snapshotsTested,
        malformedRecordsTested,
        node: process.version
      })
    }\n`
  )
}).pipe(Effect.provide(base), Effect.scoped)
Effect.runPromise(program).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`)
  process.exitCode = 1
})
