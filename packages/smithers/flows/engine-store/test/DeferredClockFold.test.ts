/**
 * The deferred/clock fold rebuilds `flows_clock_deadlines` and the completion
 * and consumption stamps of `flows_deferred_completions` from the journal.
 *
 * Every case runs the production SQL stores and journal over one database
 * (SQLite, or PostgreSQL under the storage matrix): the live tables are
 * written by `DeferredPersistence`, snapshotted, damaged, and rebuilt, and the
 * rebuilt tables must equal the live ones. A reference the store cannot join
 * fails typed and writes nothing.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database/DurableWriter"
import { FlowEngine } from "@smthrs/engine"
import { DurableClock, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DeferredClockFold from "../src/DeferredClockFold.ts"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import { EventTypes } from "../src/EventTypes.ts"
import * as DeferredPersistence from "../src/internal/DeferredPersistence.ts"
import { deferredClockFacts } from "../src/migrations/0009_deferred_clock_facts.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const owner = { hostId: "fold-host", pid: 7, nonce: "fold-owner" }

const TestFlow = Flow.make("DeferredClockFold/Test", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("unused")
})

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 256, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
)

type Services =
  | Journal.Journal
  | RunStore.RunStore
  | DurableEngineState.DurableEngineState
  | SqlClient.SqlClient
  | DurableWriter
  | Scope.Scope

/** The stores over one fresh database, on a virtual clock. */
const run = <A, E>(body: Effect.Effect<A, E, Services>) =>
  withCrypto(
    Effect.scoped(body).pipe(
      Effect.provide(Layer.provideMerge(services, TestStores.database)),
      Effect.provide(TestClock.layer())
    )
  )

/** Creates a run and leaves it running under `owner`, so its clocks may be scheduled. */
const owned = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const outcome = yield* runs.claimAndOwn(runId, { status: "pending", owner: null, heartbeatAtMs: null }, owner, 0)
    expect(outcome).toEqual({ _tag: "Activated" })
  })

const persistence = Effect.gen(function*() {
  const resumes: Array<string> = []
  const service = yield* DeferredPersistence.make({
    owner,
    journalSource: "fold-test",
    scheduleResume: (_flow, executionId, reason) => Effect.sync(() => void resumes.push(`${executionId}:${reason}`))
  })
  return { service, resumes }
})

interface Tables {
  readonly clocks: ReadonlyArray<unknown>
  readonly deferreds: ReadonlyArray<unknown>
}

/** Both tables, ordered, every column. */
const tables = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const clocks = yield* sql<Record<string, unknown>>`
    SELECT flow_name, execution_id, clock_name, deferred_name, due_at_ms, completed_at_ms
    FROM flows_clock_deadlines ORDER BY execution_id, clock_name
  `
  const deferreds = yield* sql<Record<string, unknown>>`
    SELECT flow_name, execution_id, deferred_name, exit_json, metadata_json, completed_at_ms, consumed_at_ms
    FROM flows_deferred_completions ORDER BY execution_id, deferred_name
  `
  const numbers = (row: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, key.endsWith("_ms") && value !== null ? Number(value) : value])
    )
  return { clocks: clocks.map(numbers), deferreds: deferreds.map(numbers) } satisfies Tables
})

/** Drops the clock index and resets every stamp the fold owns. */
const damage = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DELETE FROM flows_clock_deadlines`
  yield* sql`UPDATE flows_deferred_completions SET consumed_at_ms = NULL, completed_at_ms = 0`
})

const address = (executionId: string, deferredName: string) => ({
  flowName: TestFlow._tag,
  executionId,
  deferredName
})

/** Writes every path the fold covers and returns the live tables. */
const scenario = Effect.gen(function*() {
  for (const runId of ["fired", "raced", "duplicate", "pending"]) yield* owned(runId)
  const { service } = yield* persistence
  const short = DurableClock.make({ name: "short", duration: "10 seconds" })
  const long = DurableClock.make({ name: "long", duration: "1 hour" })
  // A clock that fires on its own.
  yield* service.scheduleClock(TestFlow, { executionId: "fired", clock: short })
  // A clock whose deferred an external completion wins before it fires.
  yield* service.scheduleClock(TestFlow, { executionId: "raced", clock: short })
  // A clock still pending when the tables are read.
  yield* service.scheduleClock(TestFlow, { executionId: "pending", clock: long })
  yield* TestClock.adjust("5 seconds")
  yield* service.deferredDone({
    ...address("raced", short.deferred.name),
    exit: Exit.succeed("external"),
    metadata: { from: "webhook" }
  })
  // A completion delivered twice, then observed by its run.
  yield* service.deferredDone({ ...address("duplicate", "answer"), exit: Exit.succeed("first") })
  yield* service.deferredDone({ ...address("duplicate", "answer"), exit: Exit.succeed("second") })
  yield* service.deferredResult(DurableDeferred.make("answer", { success: Schema.String })).pipe(
    Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(TestFlow, "duplicate"))
  )
  yield* TestClock.adjust("5 seconds")
  // The due timers fire on their own fibers; wait, in real time, for both
  // short clocks to have committed their completion.
  const sql = yield* SqlClient.SqlClient
  for (let turn = 0; turn < 500; turn++) {
    const [pending] = yield* sql<{ readonly count: number | string }>`
      SELECT COUNT(*) AS count FROM flows_clock_deadlines WHERE clock_name = 'short' AND completed_at_ms IS NULL
    `
    if (Number(pending!.count) === 0) break
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))
  }
  return yield* tables
})

/** The rebuild's typed refusal; any other failure is a defect. */
const incomplete = Effect.flip(
  DeferredClockFold.rebuild().pipe(
    Effect.catchIf((error) => !(error instanceof DeferredClockFold.FoldIncomplete), Effect.die)
  )
)

describe("DeferredClockFold", () => {
  it.effect("rebuilds fired, raced, duplicate, consumed, and pending rows equal to the live tables", () =>
    run(Effect.gen(function*() {
      const live = yield* scenario
      // The raced clock completed when it fired, though its deferred had
      // already been completed from outside: the journal says so.
      expect(live.clocks).toEqual([
        expect.objectContaining({ execution_id: "fired", completed_at_ms: 10_000 }),
        expect.objectContaining({ execution_id: "pending", completed_at_ms: null }),
        expect.objectContaining({ execution_id: "raced", completed_at_ms: 10_000 })
      ])
      expect(live.deferreds).toEqual([
        expect.objectContaining({ execution_id: "duplicate", completed_at_ms: 5_000, consumed_at_ms: 5_000 }),
        expect.objectContaining({ execution_id: "fired", completed_at_ms: 10_000, consumed_at_ms: null }),
        expect.objectContaining({ execution_id: "raced", completed_at_ms: 5_000, consumed_at_ms: null })
      ])
      yield* damage
      const rebuilt = yield* DeferredClockFold.rebuild()
      expect(rebuilt).toEqual({ runs: 4, clocks: 3, deferreds: 3, unexplained: 0 })
      expect(yield* tables).toEqual(live)
    })))

  it.effect("journals references and digests, never the completion's value", () =>
    run(Effect.gen(function*() {
      yield* scenario
      const journal = yield* Journal.Journal
      const page = yield* journal.entries({
        runId: "raced" as JournalEvent.RunId,
        eventTypes: DeferredClockFold.eventTypes,
        limit: 10
      })
      const sql = yield* SqlClient.SqlClient
      const [row] = yield* sql<{ readonly exit_json: string; readonly metadata_json: string }>`
        SELECT exit_json, metadata_json FROM flows_deferred_completions WHERE execution_id = 'raced'
      `
      expect(page.entries.map((entry) => [entry.eventType, entry.payload])).toEqual([
        [EventTypes.clockScheduled, {
          flowName: TestFlow._tag,
          executionId: "raced",
          clockName: "short",
          deferredName: expect.any(String),
          dueAtMs: 10_000
        }],
        [EventTypes.deferredCompleted, {
          flowName: TestFlow._tag,
          executionId: "raced",
          deferredName: expect.any(String),
          completedAtMs: 5_000,
          exitDigest: JournalEvent.contentDigest(row!.exit_json),
          metadataDigest: JournalEvent.contentDigest(row!.metadata_json)
        }],
        [EventTypes.clockCompleted, {
          flowName: TestFlow._tag,
          executionId: "raced",
          clockName: "short",
          completedAtMs: 10_000
        }]
      ])
      expect(JSON.stringify(page.entries)).not.toContain("external")
      expect(JSON.stringify(page.entries)).not.toContain("webhook")
    })))

  it.effect("rebuilds the same tables from a restarted journal and state", () =>
    withCrypto(Effect.gen(function*() {
      const outcome = yield* Effect.gen(function*() {
        const live = yield* Effect.scoped(scenario).pipe(Effect.provide(Layer.fresh(services)))
        yield* damage
        const rebuilt = yield* Effect.scoped(DeferredClockFold.rebuild()).pipe(Effect.provide(Layer.fresh(services)))
        return { live, rebuilt, after: yield* tables }
      }).pipe(Effect.provide(TestStores.database), Effect.provide(TestClock.layer()))
      expect(outcome.rebuilt.clocks).toBe(3)
      expect(outcome.after).toEqual(outcome.live)
    })))

  it.effect("fails fold_incomplete and writes nothing when a journalled completion's row is gone", () =>
    run(Effect.gen(function*() {
      yield* scenario
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM flows_deferred_completions WHERE execution_id = 'duplicate'`
      yield* sql`DELETE FROM flows_clock_deadlines WHERE execution_id = 'pending'`
      const before = yield* tables
      const error = yield* incomplete
      expect(error._tag).toBe("@smthrs/engine-store/DeferredClockFold/FoldIncomplete")
      expect(error.code).toBe("fold_incomplete")
      expect(error.unjoined).toEqual([{
        reason: "row_missing",
        executionId: "duplicate",
        flowName: TestFlow._tag,
        name: "answer"
      }])
      expect(yield* tables).toEqual(before)
    })))

  it.effect("fails fold_incomplete when a row holds other bytes than the journal recorded", () =>
    run(Effect.gen(function*() {
      yield* scenario
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE flows_deferred_completions SET exit_json = '{"forged":true}' WHERE execution_id = 'raced'`
      yield* sql`UPDATE flows_deferred_completions SET metadata_json = '{"forged":true}' WHERE execution_id = 'fired'`
      const error = yield* incomplete
      expect(error.unjoined.map((unjoined) => [unjoined.reason, unjoined.executionId])).toEqual([
        ["digest_mismatch", "fired"],
        ["digest_mismatch", "raced"]
      ])
    })))

  it.effect("fails fold_incomplete when a clock's run row is gone", () =>
    run(Effect.gen(function*() {
      yield* scenario
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM flows_clock_deadlines WHERE execution_id = 'pending'`
      yield* sql`DELETE FROM flows_consensus_leases WHERE run_id = 'pending'`
      yield* sql`DELETE FROM flows_runs WHERE run_id = 'pending'`
      const error = yield* incomplete
      expect(error.unjoined).toEqual([{
        reason: "run_missing",
        executionId: "pending",
        flowName: TestFlow._tag,
        name: "long"
      }])
    })))

  it.effect("keeps a compacted run's fold in its checkpoint, and refuses a floor that kept none", () =>
    run(Effect.gen(function*() {
      const live = yield* scenario
      const journal = yield* Journal.Journal
      const sql = yield* SqlClient.SqlClient
      // A later entry for the checkpoint to sit on, so compaction deletes the
      // clock record below it.
      yield* journal.emitDurable(
        new JournalEvent.Input({
          runId: "pending" as JournalEvent.RunId,
          sourceId: "fold-test" as JournalEvent.SourceId,
          eventType: "fold.test.marker",
          payload: {}
        }),
        owner
      )
      const tail = yield* journal.entries({ runId: "pending" as JournalEvent.RunId, limit: 100 })
      const last = tail.entries.at(-1)!.seq
      // `pending` is still owned, so its checkpoint and compaction are fenced
      // through the owner exactly as an engine would write them.
      yield* journal.checkpoint({
        runId: "pending" as JournalEvent.RunId,
        seq: last,
        state: yield* DeferredClockFold.checkpointState("pending", last, { engine: "state" })
      }, owner)
      const compacted = yield* journal.compact({ runId: "pending" as JournalEvent.RunId }, owner)
      expect(compacted.deleted).toBeGreaterThan(0)
      const below = yield* sql<{ readonly count: number | string }>`
        SELECT COUNT(*) AS count FROM flows_journal_events
        WHERE run_id = 'pending' AND event_type = ${EventTypes.clockScheduled}
      `
      expect(Number(below[0]!.count)).toBe(0)
      yield* damage
      yield* DeferredClockFold.rebuild()
      expect(yield* tables).toEqual(live)

      yield* sql`UPDATE flows_journal_checkpoints SET state_json = '{"engine":"state"}' WHERE run_id = 'pending'`
      const error = yield* incomplete
      expect(error.unjoined).toEqual([{ reason: "checkpoint_missing", executionId: "pending" }])
    })))

  it.effect("folds only the entries up to a checkpoint's sequence", () =>
    run(Effect.gen(function*() {
      yield* scenario
      const journal = yield* Journal.Journal
      const page = yield* journal.entries({ runId: "raced" as JournalEvent.RunId, limit: 100 })
      const scheduled = page.entries.find((entry) => entry.eventType === EventTypes.clockScheduled)!
      const captured = yield* DeferredClockFold.capture("raced", scheduled.seq)
      expect(captured.clocks).toEqual([expect.objectContaining({ clockName: "short", completedAtMs: null })])
      expect(captured.deferreds).toEqual([])
      expect(Option.isSome(DeferredClockFold.fromCheckpoint({ [DeferredClockFold.checkpointKey]: captured }))).toBe(
        true
      )
      expect(DeferredClockFold.fromCheckpoint({ [DeferredClockFold.checkpointKey]: { clocks: 1 } })).toEqual(
        Option.none()
      )
      expect(DeferredClockFold.fromCheckpoint(null)).toEqual(Option.none())
    })))

  it.effect("continues the real journal across pages and restores the projection's complete checkpoint", () =>
    run(Effect.gen(function*() {
      yield* scenario
      const journal = yield* Journal.Journal
      const page = yield* journal.entries({ runId: "fired" as JournalEvent.RunId, limit: 100 })
      const last = page.entries.at(-1)!.seq
      const reads: Array<number | undefined> = []
      // A bounded journal reader still delegates every page to the real store.
      const paged = Journal.Journal.of({
        ...journal,
        entries: (options) => {
          reads.push(options.after)
          return journal.entries({ ...options, limit: 1 })
        }
      })
      const captured = yield* DeferredClockFold.capture("fired", last).pipe(
        Effect.provideService(Journal.Journal, paged)
      )
      expect(reads).toEqual([undefined, ...page.entries.slice(0, -1).map((entry) => entry.seq)])
      const sql = yield* SqlClient.SqlClient
      const [completion] = yield* sql<
        { readonly deferred_name: string; readonly exit_json: string; readonly metadata_json: string }
      >`
        SELECT deferred_name, exit_json, metadata_json FROM flows_deferred_completions
        WHERE execution_id = 'fired'
      `
      expect(captured).toEqual({
        clocks: [{
          flowName: TestFlow._tag,
          executionId: "fired",
          clockName: "short",
          deferredName: completion!.deferred_name,
          dueAtMs: 10_000,
          completedAtMs: 10_000
        }],
        deferreds: [{
          flowName: TestFlow._tag,
          executionId: "fired",
          deferredName: completion!.deferred_name,
          completedAtMs: 10_000,
          consumedAtMs: null,
          exitDigest: JournalEvent.contentDigest(completion!.exit_json),
          metadataDigest: JournalEvent.contentDigest(completion!.metadata_json)
        }]
      })
      let projected = DeferredClockFold.projection.initial
      for (const entry of page.entries) projected = yield* DeferredClockFold.projection.reduce(projected, entry)
      expect(DeferredClockFold.projection.name).toBe("flows.engine.deferred-clock")
      expect(DeferredClockFold.encode(projected)).toEqual(captured)
      const restored = DeferredClockFold.fromCheckpoint({ [DeferredClockFold.checkpointKey]: captured })
      expect(Option.isSome(restored)).toBe(true)
      if (Option.isSome(restored)) {
        expect(DeferredClockFold.encode(restored.value)).toEqual(captured)
        expect(restored.value.deferreds.get(DeferredClockFold.deferredKey({
          flowName: TestFlow._tag,
          executionId: "fired",
          deferredName: completion!.deferred_name
        }))).toEqual(captured.deferreds[0])
      }
    })))

  it.effect("backfills the records of rows written before the fold existed", () =>
    run(Effect.gen(function*() {
      const live = yield* scenario
      const sql = yield* SqlClient.SqlClient
      // The pre-fold journal: no completion, consumption, or clock records.
      yield* sql`DELETE FROM flows_journal_events WHERE ${sql.in("event_type", DeferredClockFold.eventTypes)}`
      yield* deferredClockFacts
      yield* deferredClockFacts
      const counts = yield* sql<{ readonly event_type: string; readonly count: number | string }>`
        SELECT event_type, COUNT(*) AS count FROM flows_journal_events
        WHERE ${sql.in("event_type", DeferredClockFold.eventTypes)}
        GROUP BY event_type ORDER BY event_type
      `
      expect(counts.map((row) => [row.event_type, Number(row.count)])).toEqual([
        [EventTypes.clockCompleted, 2],
        [EventTypes.clockScheduled, 3],
        [EventTypes.deferredCompleted, 3],
        [EventTypes.deferredConsumed, 1]
      ])
      yield* damage
      yield* DeferredClockFold.rebuild()
      expect(yield* tables).toEqual(live)
    })))

  it.effect("keeps a legacy completion record's row stamp and skips its digest check", () =>
    run(Effect.gen(function*() {
      const live = yield* scenario
      const sql = yield* SqlClient.SqlClient
      // A record written before digests existed carried the (redacted) value.
      const [row] = yield* sql<{ readonly deferred_name: string }>`
        SELECT deferred_name FROM flows_deferred_completions WHERE execution_id = 'raced'
      `
      yield* sql`
        UPDATE flows_journal_events SET payload_json = ${
        JSON.stringify({ ...address("raced", row!.deferred_name), exit: "[REDACTED]" })
      }
        WHERE run_id = 'raced' AND event_type = ${EventTypes.deferredCompleted}
      `
      yield* sql`UPDATE flows_deferred_completions SET exit_json = '{"other":1}' WHERE execution_id = 'raced'`
      yield* sql`UPDATE flows_deferred_completions SET consumed_at_ms = 1 WHERE execution_id = 'raced'`
      yield* DeferredClockFold.rebuild()
      const after = yield* tables
      expect(after.clocks).toEqual(live.clocks)
      expect(after.deferreds).toContainEqual(
        expect.objectContaining({ execution_id: "raced", completed_at_ms: 5_000, consumed_at_ms: null })
      )
    })))

  it("ignores entries it does not fold and keeps the first write of each row", () => {
    const entry = (eventType: string, payload: unknown, seq = 0) =>
      new JournalEvent.Entry({
        runId: "r" as JournalEvent.RunId,
        seq: seq as JournalEvent.Seq,
        eventId: `e${seq}`,
        sourceId: "s" as JournalEvent.SourceId,
        sourceSeq: seq as JournalEvent.SourceSeq,
        emittedAtMs: 0,
        eventType,
        payload,
        meta: null
      })
    const clock = { flowName: "f", executionId: "r", clockName: "c" }
    const deferred = { flowName: "f", executionId: "r", deferredName: "d" }
    let state = DeferredClockFold.initial
    for (
      const next of [
        entry("other", clock),
        entry(EventTypes.clockScheduled, null),
        entry(EventTypes.clockScheduled, { ...clock, dueAtMs: "soon" }),
        entry(EventTypes.clockCompleted, { ...clock, completedAtMs: -1 }),
        entry(EventTypes.deferredCompleted, { ...deferred, deferredName: "" }),
        entry(EventTypes.deferredConsumed, { ...deferred, consumedAtMs: -1 }),
        entry(EventTypes.clockCompleted, { ...clock, completedAtMs: 1 }),
        entry(EventTypes.deferredConsumed, { ...deferred, consumedAtMs: 1 }),
        entry(EventTypes.clockScheduled, { ...clock, deferredName: "d", dueAtMs: 5 }),
        entry(EventTypes.clockScheduled, { ...clock, deferredName: "d", dueAtMs: 9 }),
        entry(EventTypes.clockCompleted, { ...clock, completedAtMs: 6 }),
        entry(EventTypes.clockCompleted, { ...clock, completedAtMs: 7 }),
        entry(EventTypes.deferredCompleted, { ...deferred, completedAtMs: 2, exitDigest: "a".repeat(64) }),
        entry(EventTypes.deferredCompleted, { ...deferred, completedAtMs: 3 }),
        entry(EventTypes.deferredConsumed, { ...deferred, consumedAtMs: 4 }),
        entry(EventTypes.deferredConsumed, { ...deferred, consumedAtMs: 8 })
      ]
    ) state = DeferredClockFold.reduce(state, next)
    expect(DeferredClockFold.encode(state)).toEqual({
      clocks: [{ ...clock, deferredName: "d", dueAtMs: 5, completedAtMs: 6 }],
      deferreds: [{ ...deferred, completedAtMs: 2, exitDigest: "a".repeat(64), consumedAtMs: 4 }]
    })
  })
})
