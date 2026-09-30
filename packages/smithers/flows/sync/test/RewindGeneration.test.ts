import { describe, expect, it } from "@effect/vitest"
import { JournalEvent } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as SyncClient from "../src/SyncClient.ts"
import { SyncError } from "../src/SyncError.ts"
import type * as SyncProtocol from "../src/SyncProtocol.ts"

const runId = "rewound" as JournalEvent.RunId
const seq = (n: number) => n as JournalEvent.Seq
const entry = new JournalEvent.Entry({
  runId,
  seq: seq(51),
  eventId: "new-future",
  sourceId: "new" as JournalEvent.SourceId,
  sourceSeq: 0 as JournalEvent.SourceSeq,
  emittedAtMs: 1,
  eventType: "event",
  payload: null,
  meta: null
})

describe("sync rewind generation", () => {
  for (const bootstrap of [false, true]) {
    it.effect(`${bootstrap ? "read page" : "live frame"} refuses a new future below the cursor before deduplication`, () =>
      Effect.gen(function*() {
        const position = { runId, afterSeq: seq(51), generation: 1 }
        const client = yield* SyncClient.make({
          client: {
            "Sync.Read": () =>
              Effect.succeed(
                bootstrap
                  ? { entries: [], cursors: [position], done: true }
                  : { entries: [], cursors: [], done: true }
              ),
            "Sync.Subscribe": () =>
              Stream.fromIterable([
                { _tag: "Entries", runId, generation: 1, fromSeq: seq(51), toSeq: seq(51), entries: [entry] },
                { _tag: "Closed" }
              ] as ReadonlyArray<SyncProtocol.Frame>)
          } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
        })
        const delivered: Array<number> = []
        const failure = yield* Effect.flip(
          client.subscribe({
            scope: { _tag: "Run", runId },
            cursors: [{ runId, afterSeq: seq(100) }]
          }).pipe(Stream.tap((entry) => Effect.sync(() => delivered.push(entry.seq))), Stream.runDrain)
        )
        expect(failure).toMatchObject({ code: "lineage_changed" })
        expect(delivered).toEqual([])
        expect((yield* client.progress).delivered).toEqual([])
      }))
  }
})

// Exercise the same SQL archive transaction and journal that a durable host
// uses. A cursor's old sequence can be above the entire replacement history.
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as Journal from "@smthrs/journal/Journal"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as SqlTimeTravelStore from "@smthrs/time-travel/SqlTimeTravelStore"
import * as Deferred from "effect/Deferred"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncServer from "../src/SyncServer.ts"

const owner = { hostId: "rewinder", pid: 1, nonce: "nonce" }
const database = Layer.provideMerge(EngineMigrations.layer, TestDatabase.layer)
const storage = Layer.provideMerge(SqlJournal.layer({ capacity: 16, overflow: "reject" }), database)
const stack = Layer.mergeAll(storage, RunCatalog.layerStatic([runId]), SyncPrincipal.layerWorkspace("rewind-test"))

const setup = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const journal = yield* Journal.Journal
  const store = yield* SqlTimeTravelStore.make
  yield* sql`
    INSERT INTO flows_runs (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
    VALUES (${runId}, 'running', 0, '{}', ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0)
  `
  for (const n of [50, 100]) {
    yield* sql`
      INSERT INTO flows_journal_events
        (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
      VALUES (${runId}, ${n}, ${`old-${n}`}, 'old', ${n}, 0, 'event', '{}', '{}')
    `
  }
  const rewind = store.archiveAndTruncate(runId, { lineageId: "original", seq: 50 }, [], owner)
  return { journal, rewind }
})

describe("SQL rewind through the sync server", () => {
  for (const scope of [{ _tag: "Run", runId }, { _tag: "Workspace" }] as const) {
    it.effect(`${scope._tag} reads and subscriptions reject a stale generation and expose the archive boundary`, () =>
      Effect.scoped(
        Effect.gen(function*() {
          const { journal, rewind } = yield* setup
          const server = yield* SyncServer.makeLive
          expect(yield* journal.generation!(runId)).toEqual({ generation: 0, afterSeq: -1 })
          yield* rewind
          const receipt = yield* journal.emitDurable(
            new JournalEvent.Input({
              runId,
              sourceId: "new" as JournalEvent.SourceId,
              eventType: "event",
              payload: "replacement",
              meta: {}
            }),
            owner
          )
          expect(receipt.seq).toBe(51)
          const cursors = [{ runId, afterSeq: seq(100) }]
          const readFailure = yield* Effect.flip(server.read({ protocolVersion: 1, scope, cursors, limit: 10 }))
          const followFailure = yield* Effect.flip(
            server.subscribe({ protocolVersion: 1, scope, cursors, credit: 1 }).pipe(Stream.runDrain)
          )
          for (const failure of [readFailure, followFailure]) {
            expect(SyncError.is(failure)).toBe(true)
            expect(failure).toMatchObject({ code: "lineage_changed", rewind: { runId, generation: 1, afterSeq: 50 } })
          }
          const recovered = [{ runId, afterSeq: seq(50), generation: 1 }]
          const page = yield* server.read({ protocolVersion: 1, scope, cursors: recovered, limit: 10 })
          expect(page.entries.map((entry) => entry.seq)).toEqual([51])
          expect(page.cursors).toEqual([{ runId, afterSeq: seq(51), generation: 1 }])
          const frames = yield* server.subscribe({ protocolVersion: 1, scope, cursors: recovered, credit: 1 }).pipe(
            Stream.runCollect
          )
          expect(frames[0]).toMatchObject({ generation: 1, toSeq: 51 })
          const client = yield* SyncClient.make({
            client: {
              "Sync.Read": server.read,
              "Sync.Subscribe": server.subscribe
            } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
          })
          yield* client.subscribe({ scope, cursors: recovered }).pipe(Stream.take(1), Stream.runDrain)
          expect((yield* client.progress).delivered).toEqual(page.cursors)
          yield* rewind
          const staleClient = yield* Effect.flip(
            client.subscribe({
              scope,
              cursors: [
                { runId, afterSeq: seq(50), generation: 2 }
              ]
            }).pipe(Stream.runDrain)
          )
          expect(staleClient).toMatchObject({ code: "lineage_changed" })
          expect(yield* journal.generation!(runId)).toEqual({ generation: 2, afterSeq: 50 })
        }).pipe(Effect.provide(stack))
      ))

    // #2631: a fresh follower of a run rewound and then compacted has no cursor
    // to learn the new generation from. The refusal names it, so a documented
    // generation-less recovery receipt resumes the replacement history.
    it.effect(`${scope._tag} fresh followers recover a rewound, compacted run from a receipt without a generation`, () =>
      Effect.scoped(
        Effect.gen(function*() {
          const { journal, rewind } = yield* setup
          const server = yield* SyncServer.makeLive
          yield* rewind
          for (const payload of ["replacement", "suffix"]) {
            yield* journal.emitDurable(
              new JournalEvent.Input({
                runId,
                sourceId: "new" as JournalEvent.SourceId,
                eventType: "event",
                payload,
                meta: {}
              }),
              owner
            )
          }
          yield* journal.checkpoint({ runId, seq: seq(51), state: { through: 51 } }, owner)
          yield* journal.compact({ runId, upTo: seq(51) }, owner)
          const refusal = yield* Effect.flip(server.read({ protocolVersion: 1, scope, cursors: [], limit: 10 }))
          expect(refusal).toMatchObject({ code: "compacted", resync: { runId, checkpointSeq: 51, generation: 1 } })

          const client = yield* SyncClient.make({
            client: {
              "Sync.Read": server.read,
              "Sync.Subscribe": server.subscribe
            } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
          })
          const resyncs: Array<SyncProtocol.Resync> = []
          const delivered = yield* client.subscribe({
            scope,
            cursors: [],
            onResync: (resync) =>
              Effect.sync(() => {
                resyncs.push(resync)
                return { runId: resync.runId, afterSeq: resync.checkpointSeq }
              })
          }).pipe(Stream.take(1), Stream.runCollect)
          expect(resyncs).toEqual([{ runId, checkpointSeq: 51, generation: 1 }])
          expect(Array.from(delivered, (entry) => [entry.seq, entry.payload])).toEqual([[52, "suffix"]])
          const progress = yield* client.progress
          expect(progress.delivered).toEqual([{ runId, afterSeq: seq(52), generation: 1 }])
          expect(progress.applied).toEqual([{ runId, afterSeq: seq(51), generation: 1 }])
        }).pipe(Effect.provide(stack))
      ))

    it.effect(`${scope._tag} idle followers notice a rewind even before replacement sequences reach their cursor`, () =>
      Effect.scoped(
        Effect.gen(function*() {
          const { journal, rewind } = yield* setup
          const ready = yield* Deferred.make<void>()
          const observed = {
            ...journal,
            generation: (id: JournalEvent.RunId) =>
              journal.generation!(id).pipe(Effect.tap(() => Deferred.succeed(ready, undefined)))
          }
          const server = yield* SyncServer.makeLive.pipe(Effect.provideService(Journal.Journal, observed))
          const fiber = yield* server.subscribe({
            protocolVersion: 1,
            scope,
            cursors: [{ runId, afterSeq: seq(100) }],
            credit: 10
          }).pipe(
            Stream.runDrain,
            Effect.flip,
            Effect.forkScoped
          )
          yield* Deferred.await(ready)
          yield* rewind
          yield* TestClock.adjust(1000)
          expect(yield* Fiber.join(fiber)).toMatchObject({ code: "lineage_changed" })
        }).pipe(Effect.provide(stack))
      ))
  }
})

describe("generation admission", () => {
  it("recognizes only well-formed rewind payloads on lineage changes", () => {
    const failure = new SyncError({
      code: "lineage_changed",
      message: "rewound",
      rewind: { runId, generation: 1, afterSeq: -1 }
    })
    expect(SyncError.is(failure)).toBe(true)
    const wire = { _tag: failure._tag, code: failure.code, message: failure.message, rewind: failure.rewind }
    expect(SyncError.is(wire)).toBe(true)
    expect(SyncError.is({ ...wire, rewind: { runId, generation: -1, afterSeq: 0 } })).toBe(false)
    expect(SyncError.is({ ...wire, code: "closed" })).toBe(false)
  })

  it.effect("does not let a delayed delivery overwrite another subscription's generation", () =>
    Effect.scoped(Effect.gen(function*() {
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let reads = 0
      const client = yield* SyncClient.make({
        client: {
          "Sync.Read": () =>
            Effect.sync(() => ({
              entries: [entry],
              cursors: [{ runId, afterSeq: entry.seq, generation: reads++ }],
              done: true
            })),
          "Sync.Subscribe": () => Stream.empty
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })
      const slow = yield* client.subscribe({
        scope: { _tag: "Run", runId },
        cursors: [],
        apply: () => Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(release)))
      }).pipe(Stream.take(1), Stream.runDrain, Effect.flip, Effect.forkScoped)
      yield* Deferred.await(ready)
      yield* client.subscribe({ scope: { _tag: "Run", runId }, cursors: [] }).pipe(Stream.take(1), Stream.runDrain)
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(slow)).toMatchObject({ code: "lineage_changed" })
      expect((yield* client.progress).delivered).toEqual([{ runId, afterSeq: entry.seq, generation: 1 }])
    })))
})
