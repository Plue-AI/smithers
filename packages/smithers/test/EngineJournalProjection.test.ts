import { NodeCrypto } from "@effect/platform-node"
import * as ControlSchema from "@smthrs/control/ControlSchema"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import * as GatewayProjection from "@smthrs/gateway/GatewayProjection"
import { CallFact } from "@smthrs/journal"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Context, Deferred, Effect, Fiber, Layer, Schedule, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Projection from "../src/internal/EngineJournalProjection.ts"

const setup = Effect.gen(function*() {
  const native = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
  const control = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
  const engineJournal = Context.get(native, Journal.Journal)
  const controlJournal = Context.get(control, Journal.Journal)
  const engineState = Context.get(native, DurableEngineState.DurableEngineState)
  return {
    engineJournal,
    controlJournal,
    engineState,
    runs: Context.get(native, RunStore.RunStore),
    sql: Context.get(native, SqlClient.SqlClient),
    options: { engineJournal, controlJournal, engineState, controlRunId: "control-root", executionId: "native-root" }
  }
}).pipe(Effect.provide(NodeCrypto.layer))

const emit = (journal: Journal.Service, runId: string, payload: unknown, sourceId = "fixture", sourceSeq = 0) =>
  journal.emitDurableUnfenced(
    new JournalEvent.Input({
      runId: runId as JournalEvent.RunId,
      sourceId: sourceId as JournalEvent.SourceId,
      sourceSeq: sourceSeq as JournalEvent.SourceSeq,
      eventType: "flows.engine.attempt-finished",
      payload,
      meta: { lineageId: "native-lineage" }
    })
  )

const rows = (journal: Journal.Service) =>
  Effect.map(
    journal.entries({ runId: "control-root" as JournalEvent.RunId, limit: 1000 }),
    (page) => page.entries.filter((entry) => entry.eventType !== "control.engine.bound")
  )
const record = (entry: JournalEvent.Entry) => entry.payload as Record<string, unknown>

describe("private engine journal projection", () => {
  it("reopens both SQLite files and converges a committed call outbox after a lost destination receipt", () =>
    Effect.runPromise(Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "call-outbox-"))),
      (directory) =>
        Effect.gen(function*() {
          const open = Effect.gen(function*() {
            const native = yield* Layer.build(Layer.fresh(TestStores.layerAt(join(directory, "native.db"))))
            const control = yield* Layer.build(Layer.fresh(TestStores.layerAt(join(directory, "control.db"))))
            return {
              engineJournal: Context.get(native, Journal.Journal),
              controlJournal: Context.get(control, Journal.Journal),
              engineState: Context.get(native, DurableEngineState.DurableEngineState),
              controlRunId: "control-root",
              executionId: "native-root"
            }
          }).pipe(Effect.provide(NodeCrypto.layer))
          const callId = `cell-call-v1:${"a".repeat(64)}`
          yield* Effect.scoped(Effect.gen(function*() {
            const ports = yield* open
            for (const phase of ["invoked", "settled"] as const) {
              yield* ports.engineJournal.emitDurableUnfenced(
                new JournalEvent.Input({
                  runId: "native-root" as JournalEvent.RunId,
                  sourceId: `call-fact-v1:${callId}:${phase}` as JournalEvent.SourceId,
                  sourceSeq: 0 as JournalEvent.SourceSeq,
                  eventType: CallFact.eventType,
                  payload: {
                    version: 1,
                    phase,
                    callId,
                    identity: {
                      runId: "control-root",
                      frame: 1,
                      cell: "cell",
                      ordinal: 0,
                      declaration: "d",
                      layers: []
                    },
                    flowName: "write",
                    ...(phase === "invoked"
                      ? { input: { token: "private-input", path: "a" } }
                      : { outcome: "failure", value: null, message: "timeout" })
                  }
                })
              )
            }
            let lost = false
            const controlJournal: Journal.Service = {
              ...ports.controlJournal,
              emitDurableUnfenced: (input) =>
                ports.controlJournal.emitDurableUnfenced(input).pipe(Effect.flatMap((receipt) => {
                  if (input.eventType !== Projection.eventKind || lost) return Effect.succeed(receipt)
                  lost = true
                  return Effect.fail(
                    new Journal.JournalError({ code: "sink_failed", message: "lost receipt after commit" })
                  )
                }))
            }
            expect((yield* Effect.result((yield* Projection.make({ ...ports, controlJournal })).catchUp))._tag).toBe(
              "Failure"
            )
            expect(yield* rows(ports.controlJournal)).toHaveLength(1)
          }))
          yield* Effect.scoped(Effect.gen(function*() {
            const ports = yield* open
            yield* (yield* Projection.make(ports)).catchUp
            const committed = yield* rows(ports.controlJournal)
            expect(committed).toHaveLength(2)
            yield* (yield* Projection.make(ports)).catchUp
            expect(yield* rows(ports.controlJournal)).toEqual(committed)
            expect(JSON.stringify(committed)).not.toContain("private-input")
            const events = committed.map((entry) =>
              Schema.decodeUnknownSync(ControlSchema.ControlEvent)({
                runId: "control-root",
                sequence: entry.seq as number,
                kind: entry.eventType,
                occurredAt: entry.emittedAtMs as number,
                payload: entry.payload
              })
            )
            expect(GatewayProjection.nodeOutput(events)).toMatchObject([{
              nodeId: "call-1",
              outcome: "failure",
              output: "timeout"
            }])
            expect(GatewayProjection.transcript(events)).toHaveLength(2)
          }))
        }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
    )))

  it("commits one trusted binding and follows trampoline membership without rewriting copied identities", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      const state = JSON.stringify({ version: 1, flowName: "agent/run", payload: {} })
      yield* f.runs.create("native-root", state)
      yield* f.runs.create("round-1", state, { lineageId: "native-root", roundOrdinal: 1, parentRunId: "native-root" })
      yield* emit(f.engineJournal, "native-root", { root: true })
      yield* emit(f.engineJournal, "round-1", { round: true })
      expect(yield* f.engineState.runChildren("native-root")).toEqual([])
      const projector = yield* Projection.make({ ...f.options, runLineage: f.runs.lineage })
      yield* projector.catchUp
      const first = yield* f.controlJournal.entries({ runId: "control-root" as JournalEvent.RunId, limit: 100 })
      expect(first.entries.filter((entry) => entry.eventType === "control.engine.bound").map(record)).toEqual([
        { version: 1, controlRunId: "control-root", executionId: "native-root" }
      ])
      expect((yield* rows(f.controlJournal)).map((entry) => record(entry).executionId)).toEqual([
        "native-root",
        "round-1"
      ])
      yield* (yield* Projection.make({ ...f.options, runLineage: f.runs.lineage })).catchUp
      expect((yield* f.controlJournal.entries({ runId: "control-root" as JournalEvent.RunId, limit: 100 })).entries)
        .toEqual(first.entries)
    }))))

  it("calls the record hook before that record is readable in the control journal", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* emit(f.engineJournal, "native-root", { step: "first" }, "first")
      yield* emit(f.engineJournal, "native-root", { step: "second" }, "second")
      // What the control journal already held each time the hook ran. The
      // order is the whole guarantee: a client that acts on a copied record
      // is acting on something this host has already acted on, so a receipt
      // naming `flows/<id>/flow.ts` is readable only once the rebuild behind
      // it is done.
      const seen: Array<{ readonly sequence: number; readonly copied: ReadonlyArray<unknown> }> = []
      const projector = yield* Projection.make({
        ...f.options,
        onRecord: (entry) =>
          rows(f.controlJournal).pipe(
            Effect.map((entries) =>
              void seen.push({ sequence: entry.seq, copied: entries.map((row) => record(row).payload) })
            ),
            Effect.orDie
          )
      })
      yield* projector.catchUp

      expect(seen).toEqual([
        { sequence: 0, copied: [] },
        { sequence: 1, copied: [{ step: "first" }] }
      ])
      expect((yield* rows(f.controlJournal)).map((entry) => record(entry).payload)).toEqual([
        { step: "first" },
        { step: "second" }
      ])
    }))))

  it("does not invent missing evidence from native sequence reservations abandoned on rollback", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* emit(f.engineJournal, "native-root", { committed: "before" }, "before")
      const rollback = yield* Effect.result(f.engineJournal.transact(Effect.gen(function*() {
        yield* emit(f.engineJournal, "native-root", { uncommitted: true }, "rolled-back")
        return yield* Effect.fail("abandon native attempt")
      })))
      expect(rollback._tag).toBe("Failure")
      yield* emit(f.engineJournal, "native-root", { committed: "after" }, "after")
      const native = yield* f.engineJournal.entries({ runId: "native-root" as JournalEvent.RunId, limit: 10 })
      expect(native.entries.map((entry) => entry.seq)).toEqual([0, 2])
      const projector = yield* Projection.make(f.options)
      yield* projector.catchUp
      const projected = yield* rows(f.controlJournal)
      expect(projected.map((entry) => entry.eventType)).toEqual([Projection.eventKind, Projection.eventKind])
      expect(projected.map(record)).toMatchObject([
        { sequence: 0, payload: { committed: "before" } },
        { sequence: 2, payload: { committed: "after" } }
      ])
      const restarted = yield* Projection.make(f.options)
      yield* restarted.catchUp
      expect(yield* rows(f.controlJournal)).toEqual(projected)
    }))))

  it("discards a page crossed by a rewind without acquiring the native write transaction", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* emit(f.engineJournal, "native-root", { before: true })
      let rewind = true
      const source: Journal.Service = {
        ...f.engineJournal,
        transact: () =>
          Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "read side may not take the writer" })),
        entries: (options) =>
          f.engineJournal.entries(options).pipe(Effect.tap(() => {
            if (!rewind) return Effect.void
            rewind = false
            return f.engineJournal.transact(Effect.gen(function*() {
              yield* f
                .sql`INSERT INTO flows_journal_generations (run_id, generation, after_seq) VALUES ('native-root', 1, -1)`
              yield* f.sql`UPDATE flows_journal_events SET payload_json = ${
                JSON.stringify({ after: true })
              } WHERE run_id = 'native-root' AND seq = 0`
            })).pipe(Effect.orDie)
          }))
      }
      const projector = yield* Projection.make({ ...f.options, engineJournal: source })
      yield* projector.catchUp
      expect((yield* rows(f.controlJournal)).map(record)).toMatchObject([
        { reason: "rewound", generation: 1 },
        { generation: 1, payload: { after: true } }
      ])
    }))))

  it(
    "reads the committed native page while an independent writer still holds its transaction",
    () =>
      Effect.runPromise(Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "smithers-projection-reader-"))),
        (directory) =>
          Effect.scoped(
            Effect.gen(function*() {
              const path = join(directory, "native.sqlite")
              const source = yield* Layer.build(Layer.fresh(TestStores.layerAt(path)))
              const writer = yield* Layer.build(Layer.fresh(TestStores.layerAt(path)))
              const destination = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
              const engineJournal = Context.get(source, Journal.Journal)
              const controlJournal = Context.get(destination, Journal.Journal)
              yield* emit(engineJournal, "native-root", { committed: true })
              const entered = yield* Deferred.make<void>()
              const release = yield* Deferred.make<void>()
              const writerJournal = Context.get(writer, Journal.Journal)
              const held = yield* Effect.forkScoped(writerJournal.transact(Effect.gen(function*() {
                yield* emit(writerJournal, "native-root", { uncommitted: true }, "writer")
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              })))
              yield* Deferred.await(entered)
              const projector = yield* Projection.make({
                engineJournal,
                controlJournal,
                engineState: Context.get(source, DurableEngineState.DurableEngineState),
                controlRunId: "control-root",
                executionId: "native-root"
              })
              yield* projector.catchUp.pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
              expect((yield* rows(controlJournal)).map(record)).toMatchObject([{ payload: { committed: true } }])
              yield* Fiber.join(held)
              yield* projector.catchUp
              expect((yield* rows(controlJournal)).map(record)).toMatchObject([
                { payload: { committed: true } },
                { payload: { uncommitted: true } }
              ])
            }).pipe(Effect.provide(NodeCrypto.layer))
          ),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
      )),
    30_000
  )

  it("records an exact omission for a destination size refusal and continues into later events and children", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      const bounded = yield* Layer.build(
        SqlJournal.layer({ capacity: 1024, overflow: "reject", maxEntryBytes: 1024 }).pipe(
          Layer.provide(TestStores.databaseAt(":memory:")),
          Layer.provide(NodeCrypto.layer)
        )
      )
      const controlJournal = Context.get(bounded, Journal.Journal)
      yield* emit(f.engineJournal, "native-root", { large: "x".repeat(2048) }, "large")
      yield* emit(f.engineJournal, "native-root", { next: true }, "small")
      yield* f.engineState.recordRunParent("child", "native-root")
      yield* emit(f.engineJournal, "child", { child: true })
      const projector = yield* Projection.make({ ...f.options, controlJournal })
      yield* projector.catchUp
      const projected = yield* rows(controlJournal)
      expect(projected.map(record)).toMatchObject([
        { reason: "invalid_event", fromSequence: 0, throughSequence: 0 },
        { sequence: 1, payload: { next: true } },
        { executionId: "child", payload: { child: true } }
      ])
      const restarted = yield* Projection.make({ ...f.options, controlJournal })
      yield* restarted.catchUp
      expect(yield* rows(controlJournal)).toEqual(projected)
    }))))

  it("copies native outcomes and recorded child edges, ignores prefix lookalikes, and deduplicates a restart", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* emit(f.engineJournal, "native-root", {
        result: { _tag: "Success", value: { check: "typecheck", passed: true } }
      }, "first")
      yield* emit(f.engineJournal, "native-root", { state: "failed" }, "second")
      yield* f.engineState.recordRunParent("unrelated-opaque-id", "native-root")
      yield* emit(f.engineJournal, "unrelated-opaque-id", { child: "recorded" })
      yield* emit(f.engineJournal, "native-root-prefix-lookalike", { secret: "not owned" })
      const projector = yield* Projection.make(f.options)
      yield* projector.catchUp
      const first = yield* rows(f.controlJournal)
      expect(first).toHaveLength(3)
      expect(first.every((entry) => entry.eventType === Projection.eventKind)).toBe(true)
      expect(first.map((entry) => record(entry).executionId)).toEqual([
        "native-root",
        "native-root",
        "unrelated-opaque-id"
      ])
      expect(record(first[0]!)).toMatchObject({
        version: 1,
        sequence: 0,
        sourceSequence: 0,
        sourceId: "first",
        eventType: "flows.engine.attempt-finished",
        meta: { lineageId: "native-lineage" },
        payload: { result: { _tag: "Success", value: { check: "typecheck", passed: true } } }
      })
      expect(record(first[1]!)).toMatchObject({ sequence: 1, sourceSequence: 0, sourceId: "second" })
      expect(first[0]?.sourceId).not.toBe(first[2]?.sourceId)
      const restarted = yield* Projection.make(f.options)
      yield* restarted.catchUp
      expect(yield* rows(f.controlJournal)).toEqual(first)
    }))))

  it("retries an acknowledged destination write after a lost response without skipping the page", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* emit(f.engineJournal, "native-root", { first: true }, "one")
      yield* emit(f.engineJournal, "native-root", { second: true }, "two")
      let lose = true
      const destination: Journal.Service = {
        ...f.controlJournal,
        emitDurableUnfenced: (input) =>
          Effect.flatMap(f.controlJournal.emitDurableUnfenced(input), (receipt) => {
            if (!lose) return Effect.succeed(receipt)
            lose = false
            return Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "lost response after commit" }))
          })
      }
      const projector = yield* Projection.make({ ...f.options, controlJournal: destination })
      expect((yield* Effect.result(projector.catchUp))._tag).toBe("Failure")
      yield* projector.catchUp
      expect((yield* rows(f.controlJournal)).map((entry) => record(entry).payload)).toEqual([{ first: true }, {
        second: true
      }])
    }))))

  it("preserves changed native sequence values under a new rewind generation", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* emit(f.engineJournal, "native-root", { before: true })
      const projector = yield* Projection.make(f.options)
      yield* projector.catchUp
      yield* f.sql`INSERT INTO flows_journal_generations (run_id, generation, after_seq) VALUES ('native-root', 1, -1)
        ON CONFLICT (run_id) DO UPDATE SET generation = 1, after_seq = -1`
      yield* f.sql`UPDATE flows_journal_events SET payload_json = ${
        JSON.stringify({ after: true })
      } WHERE run_id = 'native-root' AND seq = 0`
      yield* projector.catchUp
      const projected = yield* rows(f.controlJournal)
      expect(projected).toHaveLength(3)
      expect(record(projected[0]!)).toMatchObject({ generation: 0, sequence: 0, payload: { before: true } })
      expect(projected[1]?.eventType).toBe(Projection.gapKind)
      expect(record(projected[1]!)).toMatchObject({ reason: "rewound", generation: 1, afterSequence: -1 })
      expect(record(projected[2]!)).toMatchObject({ generation: 1, sequence: 0, payload: { after: true } })
      const restarted = yield* Projection.make(f.options)
      yield* restarted.catchUp
      expect(yield* rows(f.controlJournal)).toEqual(projected)
    }))))

  it("reports compacted and missing sequences without inventing native completion", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      const owner = { hostId: "host", pid: 42, nonce: "nonce" }
      yield* f.runs.create("native-root", JSON.stringify({ version: 1, flowName: "fixture", payload: {} }))
      yield* f
        .sql`UPDATE flows_runs SET status = 'running', owner_host_id = ${owner.hostId}, owner_pid = ${owner.pid}, owner_nonce = ${owner.nonce}, heartbeat_at_ms = 1 WHERE run_id = 'native-root'`
      yield* f
        .sql`INSERT INTO flows_consensus_leases (run_id, owner_host_id, owner_pid, owner_nonce, granted_at_ms, heartbeat_at_ms) VALUES ('native-root', ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 1, 1)`
      yield* emit(f.engineJournal, "native-root", { value: 0 }, "zero")
      yield* emit(f.engineJournal, "native-root", { value: 1 }, "one")
      yield* emit(f.engineJournal, "native-root", { value: 2 }, "two")
      yield* emit(f.engineJournal, "native-root", { value: 3 }, "three")
      yield* f.engineJournal.checkpoint({
        runId: "native-root" as JournalEvent.RunId,
        seq: 1 as JournalEvent.Seq,
        state: null
      }, owner)
      expect((yield* f.engineJournal.compact({ runId: "native-root" as JournalEvent.RunId }, owner)).deleted).toBe(1)
      const projector = yield* Projection.make(f.options)
      yield* projector.catchUp
      const projected = yield* rows(f.controlJournal)
      expect(projected.map((entry) => entry.eventType)).toEqual([
        Projection.gapKind,
        Projection.eventKind,
        Projection.eventKind,
        Projection.eventKind
      ])
      expect(projected.map(record)).toMatchObject([
        { reason: "compacted", throughSequence: 0 },
        { sequence: 1, payload: { value: 1 } },
        { sequence: 2, payload: { value: 2 } },
        { sequence: 3, payload: { value: 3 } }
      ])
      const restarted = yield* Projection.make(f.options)
      yield* restarted.catchUp
      expect(yield* rows(f.controlJournal)).toEqual(projected)
    }))))

  it("pages beyond one batch and follows newly recorded children", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* f.engineJournal.transact(
        Effect.forEach(
          Array.from({ length: 260 }, (_, index) => index),
          (index) => emit(f.engineJournal, "native-root", { index }, "batch", index),
          { discard: true }
        )
      )
      const projector = yield* Projection.make(f.options)
      yield* projector.catchUp
      expect(yield* rows(f.controlJournal)).toHaveLength(260)
      const follower = yield* Effect.forkScoped(projector.follow)
      yield* f.engineState.recordRunParent("later-child", "native-root")
      yield* emit(f.engineJournal, "later-child", { observed: true })
      const observed = yield* Effect.retry(
        Effect.gen(function*() {
          const projected = yield* rows(f.controlJournal)
          return projected.length === 261 ? projected : yield* Effect.fail("not copied yet")
        }),
        { times: 200, schedule: Schedule.spaced("10 millis") }
      ).pipe(Effect.timeout("5 seconds"))
      expect(record(observed[260]!)).toMatchObject({ executionId: "later-child", payload: { observed: true } })
      yield* Fiber.interrupt(follower)
    }))))

  it("rechecks durable history written by an independent SQLite connection", () =>
    Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "smithers-engine-projection-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
        )
        const filename = join(directory, "engine.db")
        const native = yield* Layer.build(Layer.fresh(TestStores.layerAt(filename)))
        const writer = yield* Layer.build(Layer.fresh(TestStores.layerAt(filename)))
        const control = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
        const destination = Context.get(control, Journal.Journal)
        const firstRead = yield* Deferred.make<void>()
        const source = Context.get(native, Journal.Journal)
        const projector = yield* Projection.make({
          engineJournal: {
            ...source,
            entries: (options) =>
              source.entries(options).pipe(
                Effect.tap(() => Deferred.succeed(firstRead, undefined))
              )
          },
          engineState: Context.get(native, DurableEngineState.DurableEngineState),
          controlJournal: destination,
          controlRunId: "control-root",
          executionId: "native-root"
        })
        const follower = yield* Effect.forkScoped(projector.follow)
        // The first empty page is already read. This separate writer cannot
        // wake the source journal's PubSub, so only the durable recheck finds it.
        yield* Deferred.await(firstRead)
        yield* emit(Context.get(writer, Journal.Journal), "native-root", { externalWriter: true })
        const observed = yield* Effect.retry(
          Effect.gen(function*() {
            const projected = yield* rows(destination)
            return projected.length === 1 ? projected : yield* Effect.fail("not copied yet")
          }),
          { times: 200, schedule: Schedule.spaced("10 millis") }
        ).pipe(Effect.timeout("5 seconds"))
        expect(record(observed[0]!)).toMatchObject({ executionId: "native-root", payload: { externalWriter: true } })
        yield* Fiber.interrupt(follower)
      }).pipe(Effect.provide(NodeCrypto.layer))
    )))

  it("records a read failure and refuses a successful catch-up until the source recovers", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* emit(f.engineJournal, "native-root", { real: true })
      let unavailable = true
      const source: Journal.Service = {
        ...f.engineJournal,
        entries: (options) =>
          unavailable
            ? Effect.fail(new Journal.JournalError({ code: "read_failed", message: "unavailable" }))
            : f.engineJournal.entries(options)
      }
      const projector = yield* Projection.make({ ...f.options, engineJournal: source })
      expect((yield* Effect.result(projector.catchUp))._tag).toBe("Failure")
      expect((yield* Effect.result(projector.catchUp))._tag).toBe("Failure")
      expect(yield* rows(f.controlJournal)).toHaveLength(1)
      unavailable = false
      yield* projector.catchUp
      const projected = yield* rows(f.controlJournal)
      expect(projected.map((entry) => entry.eventType)).toEqual([Projection.gapKind, Projection.eventKind])
      expect(record(projected[0]!)).toMatchObject({ reason: "read_failed", afterSequence: -1 })
      expect(record(projected[1]!)).toMatchObject({ payload: { real: true } })
    }))))

  it.each([1, 2] as const)(
    "records a refusal of generation read %i without guessing the current generation",
    (phase) =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        const refusal = Effect.fail(new Journal.JournalError({ code: "read_failed", message: "storage unavailable" }))
        let reads = 0
        const source: Journal.Service = {
          ...f.engineJournal,
          generation: (id) => ++reads === phase ? refusal : f.engineJournal.generation!(id)
        }
        const projector = yield* Projection.make({ ...f.options, engineJournal: source })
        expect((yield* Effect.result(projector.catchUp))._tag).toBe("Failure")
        expect((yield* rows(f.controlJournal)).map(record)).toEqual([{
          executionId: "native-root",
          generation: null,
          reason: "read_failed",
          phase: "source-generation",
          lastObservedGeneration: null,
          afterSequence: -1
        }])
      })))
  )

  it("waits for an admitted native run to exist and reach a terminal commit", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      const observedAdmission = yield* Deferred.make<void>()
      const runs: Pick<RunStore.Service, "get"> = {
        get: (id) =>
          f.runs.get(id).pipe(
            Effect.onExit(() => Deferred.succeed(observedAdmission, undefined))
          )
      }
      const projector = yield* Projection.make(f.options)
      let finished = false
      const follower = yield* Effect.forkScoped(
        projector.followUntilSettled(runs).pipe(Effect.tap(() => {
          finished = true
          return Effect.void
        }))
      )
      yield* Deferred.await(observedAdmission)
      expect(finished).toBe(false)
      yield* f.engineJournal.transact(Effect.gen(function*() {
        yield* f.runs.create("native-root", JSON.stringify({ version: 1, flowName: "fixture", payload: {} }))
        yield* emit(f.engineJournal, "native-root", {
          result: { _tag: "Success", value: "committed after handler return" }
        })
        yield* f.sql`UPDATE flows_runs SET status = 'completed' WHERE run_id = 'native-root'`
      }))
      yield* Fiber.join(follower).pipe(Effect.timeout("5 seconds"))
      expect(finished).toBe(true)
      expect((yield* rows(f.controlJournal)).map(record)).toMatchObject([
        { payload: { result: { _tag: "Success", value: "committed after handler return" } } }
      ])
    }))))

  it("drains a terminal event committed after the preceding page but before the terminal row read", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* f.runs.create("native-root", JSON.stringify({ version: 1, flowName: "fixture", payload: {} }))
      let pageReads = 0
      let rowReads = 0
      const projector = yield* Projection.make({
        ...f.options,
        engineJournal: {
          ...f.engineJournal,
          entries: (options) =>
            f.engineJournal.entries(options).pipe(Effect.tap(() => {
              pageReads++
              return Effect.void
            }))
        }
      })
      yield* projector.followUntilSettled({
        get: (id) =>
          Effect.gen(function*() {
            rowReads++
            // The first catchUp has already fetched the empty source page. Commit
            // the native result now, then return the actual terminal SQL row.
            expect(pageReads).toBe(1)
            yield* f.engineJournal.transact(Effect.gen(function*() {
              yield* emit(f.engineJournal, "native-root", { result: { _tag: "Success", value: "final drain" } })
              yield* f.sql`UPDATE flows_runs SET status = 'completed' WHERE run_id = 'native-root'`
            })).pipe(Effect.orDie)
            return yield* f.runs.get(id)
          })
      }).pipe(Effect.timeout("5 seconds"))
      expect(rowReads).toBe(1)
      expect(pageReads).toBe(2)
      expect((yield* rows(f.controlJournal)).map(record)).toMatchObject([
        { payload: { result: { _tag: "Success", value: "final drain" } } }
      ])
    }))))
})
