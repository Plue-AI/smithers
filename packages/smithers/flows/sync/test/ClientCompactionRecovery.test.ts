import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncClient from "../src/SyncClient.ts"
import { SyncError } from "../src/SyncError.ts"
import * as SyncProtocol from "../src/SyncProtocol.ts"
import * as SyncServer from "../src/SyncServer.ts"
import * as TestSocket from "../src/test/TestSocket.ts"
import * as TestSync from "../src/test/TestSync.ts"
import * as TestEntry from "./fixtures/entry.ts"

const runId = "compaction-recovery" as JournalEvent.RunId
const scope = { _tag: "Run", runId } as const
const seq = (value: number) => value as JournalEvent.Seq
const restored = (value: number): SyncProtocol.RunCursor => ({ generation: 0, runId, afterSeq: seq(value) })
const compacted = (floor: number, target = runId) =>
  new SyncError({
    code: "compacted",
    message: "History compacted",
    resync: { runId: target, checkpointSeq: seq(floor) }
  })
const entry = (value: number) =>
  TestEntry.entry(runId, value, {
    eventId: `event-${value}`,
    sourceId: "writer" as JournalEvent.SourceId,
    eventType: "increment",
    payload: 1
  })

/** Honours the exact requested cursor; replaying a restored prefix doubles the counter. */
const server = (options: { floor?: number; target?: JournalEvent.RunId } = {}) => {
  const requests: Array<SyncProtocol.WorkspaceCursor> = []
  const floor = options.floor ?? 2
  const client = {
    "Sync.Read": (request: SyncProtocol.ReadRequest) =>
      Effect.suspend(() => {
        requests.push(request.cursors)
        const after = request.cursors.find((cursor) => cursor.runId === runId)?.afterSeq ?? -1
        if (after < floor) return Effect.fail(compacted(floor, options.target))
        return Effect.succeed({
          entries: [3, 4, 5].filter((value) => value > after).map(entry),
          cursors: [restored(5)],
          done: true
        })
      }),
    "Sync.Subscribe": () => Stream.empty
  } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
  return { client, requests }
}

describe("SyncClient compaction recovery admission", () => {
  it.effect("refuses deleted history without an explicit recovery handler", () =>
    Effect.gen(function*() {
      const transport = server()
      const client = yield* SyncClient.make(transport)
      const failure = yield* Effect.flip(
        client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1), Stream.runCollect)
      )
      expect(failure).toMatchObject({ code: "compacted", resync: { runId, checkpointSeq: 2 } })
      expect((yield* client.progress).delivered).toEqual([])
      expect(transport.requests).toEqual([[]])
    }))

  it.effect("refuses a compaction target outside the subscribed run before calling recovery", () =>
    Effect.gen(function*() {
      const transport = server({ target: "foreign" as JournalEvent.RunId })
      const client = yield* SyncClient.make(transport)
      let calls = 0
      const failure = yield* Effect.flip(
        client.subscribe({
          scope,
          cursors: [],
          onResync: () =>
            Effect.sync(() => {
              calls++
              return restored(2)
            })
        }).pipe(Stream.take(1), Stream.runCollect)
      )
      expect(failure).toMatchObject({ code: "protocol_violation" })
      expect(calls).toBe(0)
      expect((yield* client.progress).delivered).toEqual([])
      expect(transport.requests).toEqual([[]])
    }))

  it.effect("resumes after the snapshot actually restored, without replaying its newer prefix", () =>
    Effect.gen(function*() {
      const transport = server()
      const client = yield* SyncClient.make(transport)
      let count = 0
      const suffix = yield* client.subscribe({
        scope,
        cursors: [],
        onResync: (request) =>
          Effect.gen(function*() {
            expect(request.checkpointSeq).toBe(2)
            expect((yield* client.progress).delivered).toEqual([])
            // The latest snapshot advanced to 4 after the server observed floor 2.
            // It contains five increments (sequences 0 through 4).
            count = 5
            return restored(4)
          }),
        apply: () =>
          Effect.sync(() => {
            count++
          })
      }).pipe(Stream.take(1), Stream.runCollect)
      expect(suffix.map((event) => event.seq)).toEqual([5])
      expect(count).toBe(6)
      expect(transport.requests).toEqual([[], [restored(4)]])
      expect((yield* client.progress).delivered).toEqual([restored(5)])
    }))

  it.effect("refuses invalid, foreign, and behind-floor restoration receipts without advancing", () =>
    Effect.gen(function*() {
      for (
        const receipt of [
          undefined,
          { generation: 0, runId, afterSeq: -1 },
          { generation: 0, runId, afterSeq: 2.5 },
          { generation: 0, runId, afterSeq: Number.NaN },
          { generation: 0, runId, afterSeq: Number.MAX_SAFE_INTEGER },
          {
            get runId() {
              throw new Error("unreadable receipt")
            }
          },
          { generation: 0, runId: "foreign", afterSeq: 4 },
          restored(1)
        ]
      ) {
        const transport = server()
        const client = yield* SyncClient.make(transport)
        const failure = yield* Effect.flip(
          client.subscribe({
            scope,
            cursors: [],
            onResync: () => Effect.succeed(receipt as SyncProtocol.RunCursor)
          }).pipe(Stream.take(1), Stream.runCollect)
        )
        expect(failure).toMatchObject({ code: "invalid_request" })
        expect((yield* client.progress).delivered).toEqual([])
        expect(transport.requests).toEqual([[]])
      }
    }))

  it.effect("captures each restored cursor field once before validating and committing", () =>
    Effect.gen(function*() {
      const transport = server()
      const client = yield* SyncClient.make(transport)
      let reads = 0
      const receipt = {
        generation: 0,
        runId,
        get afterSeq() {
          return seq(++reads === 1 ? 4 : 1000)
        }
      }
      yield* client.subscribe({ scope, cursors: [], onResync: () => Effect.succeed(receipt) })
        .pipe(Stream.take(1), Stream.runCollect)
      expect(reads).toBe(1)
      expect(transport.requests).toEqual([[], [restored(4)]])
      expect((yield* client.progress).delivered).toEqual([restored(5)])
    }))

  it.effect("does not acknowledge an interrupted snapshot application", () =>
    Effect.gen(function*() {
      const transport = server()
      const client = yield* SyncClient.make(transport)
      const applying = yield* Deferred.make<void>()
      const pending = yield* client.subscribe({
        scope,
        cursors: [],
        onResync: () => Deferred.succeed(applying, undefined).pipe(Effect.andThen(Effect.never))
      }).pipe(Stream.runDrain, Effect.forkChild)
      yield* Deferred.await(applying)
      yield* Fiber.interrupt(pending)
      expect((yield* client.progress).delivered).toEqual([])
      expect(transport.requests).toEqual([[]])
    }))
})

const storage = SqlJournal.layer({ capacity: 64, overflow: "reject" }).pipe(
  Layer.provideMerge(Layer.provideMerge(JournalMigrations.layer, TestDatabase.layer))
)
const Counter = Schema.Struct({ version: Schema.Literal(1), count: Schema.Int })
const publicSource = Layer.effect(
  SyncServer.SnapshotSource,
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    return {
      read: (request: SyncProtocol.SnapshotRequest) =>
        Effect.gen(function*() {
          if (
            request.runId !== runId || request.lineageId !== "counter-lineage" ||
            request.projection !== "counter" || request.projectionVersion !== 1
          ) {
            return yield* Effect.fail(new SyncError({ code: "not_found", message: "Unknown public projection" }))
          }
          const saved = yield* journal.latestCheckpoint(runId).pipe(Effect.orDie)
          if (Option.isNone(saved)) {
            return yield* Effect.fail(new SyncError({ code: "not_found", message: "No snapshot" }))
          }
          const state = yield* Schema.decodeUnknownEffect(Counter)(saved.value.state).pipe(Effect.orDie)
          // Select only the public projection. The stored checkpoint also has a
          // private field that must never be copied into the RPC result.
          return {
            protocolVersion: 1 as const,
            runId,
            lineageId: "counter-lineage",
            projection: "counter",
            projectionVersion: 1,
            seq: saved.value.seq,
            state: { version: 1, count: state.count }
          }
        })
    }
  })
).pipe(Layer.provide(storage))
const services = SyncServer.layer.pipe(Layer.provideMerge(Layer.mergeAll(
  storage,
  publicSource,
  RunCatalog.layerStatic([runId]),
  TestSync.layerTrustAllAsOwner
)))
const owner = { hostId: "compactor", pid: 42, nonce: "checkpoint-owner" }

describe("snapshot recovery over production SQLite and JSON RPC", () => {
  for (const race of ["newer snapshot", "moving floor"] as const) {
    it.live(`matches a full-history fold across a ${race}`, () =>
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const sql = yield* SqlClient.SqlClient
        // Only the ownership lease is fixture data: checkpoint and compaction
        // still use the production fenced journal APIs, not direct
        // checkpoint-row writes.
        yield* sql`
          INSERT INTO flows_consensus_leases (run_id, owner_host_id, owner_pid, owner_nonce, granted_at_ms, heartbeat_at_ms)
          VALUES (${runId}, ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0, 0)
        `
        for (let index = 0; index < 6; index++) {
          yield* journal.emitDurableUnfenced({
            runId,
            sourceId: "writer" as JournalEvent.SourceId,
            eventType: "increment",
            payload: 1
          })
        }
        yield* journal.flush
        const full = (yield* journal.entries({ runId, limit: 10 })).entries
        expect(full.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
        const reference = full.reduce((count, event) => count + Number(event.payload), 0)
        const checkpoint = (through: number) =>
          journal.checkpoint({
            runId,
            seq: seq(through),
            state: { version: 1, count: through + 1, internalSecret: "private-checkpoint-fixture" }
          }, owner).pipe(Effect.andThen(journal.compact({ runId, upTo: seq(through) }, owner)))
        yield* checkpoint(2)
        const wire: Array<string> = []
        const pair = yield* TestSocket.makePair()
        pair.faults.installFilter((bytes) => {
          wire.push(new TextDecoder().decode(bytes))
          return true
        })
        const client = yield* TestSync.connect(pair)
        const applied: Array<number> = []
        let count = 0
        const suffix = yield* client.subscribe({
          scope,
          cursors: [],
          // The client receives only the explicitly public projection over RPC.
          onResync: (request) =>
            Effect.gen(function*() {
              if (applied.length === 0 && race === "newer snapshot") yield* checkpoint(4)
              const saved = yield* client.snapshot({
                protocolVersion: 1,
                runId: request.runId,
                lineageId: "counter-lineage",
                projection: "counter",
                projectionVersion: 1,
                atLeastSeq: request.checkpointSeq
              })
              expect(saved.runId).toBe(request.runId)
              expect(saved.seq).toBeGreaterThanOrEqual(request.checkpointSeq)
              const state = yield* Schema.decodeUnknownEffect(Counter)(saved.state).pipe(Effect.orDie)
              count = state.count
              applied.push(saved.seq)
              if (applied.length === 1 && race === "moving floor") yield* checkpoint(4).pipe(Effect.orDie)
              return { generation: 0, runId: saved.runId, afterSeq: saved.seq }
            }).pipe(Effect.orDie),
          apply: (event) =>
            Effect.sync(() => {
              count += Number(event.payload)
            })
        }).pipe(Stream.take(1), Stream.runCollect)
        expect(suffix.map((event) => event.seq)).toEqual([5])
        expect(count).toBe(reference)
        expect(applied).toEqual(race === "newer snapshot" ? [4] : [2, 4])
        expect((yield* client.progress).delivered).toEqual([restored(5)])
        expect(wire.join("\n")).toContain("compacted")
        expect(wire.join("\n")).not.toContain("private-checkpoint-fixture")
      }).pipe(Effect.provide(services), Effect.scoped))
  }
})
