import * as Dialect from "@smthrs/database/Dialect"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { executeUntilParked } from "./ExecuteUntilParked.ts"
/**
 * Retention over the real durable engine schema.
 *
 * Nothing in the composition deleted a `flows_runs` row or any row that hangs
 * off one: a workspace database grew with every run it ever finished, and the
 * journal grew with it because compaction is off by default. These cases drive
 * the retention operation against the production SQLite stores — the same rows
 * the engine writes — and pin the two halves that make it safe to run: every
 * dependent of a deleted run goes with it in the same transaction, and nothing
 * a live run still needs is touched.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as RetentionOps from "../src/internal/RetentionOps.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

// The cases age runs by advancing the virtual clock, and every millisecond of
// virtual time the composition's scheduled work has to be stepped through
// costs real time. Two seconds of virtual age with a one-second threshold
// exercises the same before/after cutoff comparison a day would.
const agingMs = 2_000
const thresholdMs = 1_000
/** Far enough out that no seeded clock deadline comes due mid-case. */
const distantDeadlineMs = 30 * 24 * 60 * 60 * 1000

const owner: Ownership.OwnerId = { hostId: "retention-host", pid: 11, nonce: "retention-nonce" }

const runState = JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: "Retention/Test", payload: {} })

const flowName = "Retention/Test"

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "retention-snapshot" as never, changeId: "retention-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

/** The time-travel archive table, which the engine ladder does not install. */
const createArchiveTable = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_archive (
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 0),
    seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 0),
    event_id TEXT NOT NULL CHECK (length(event_id) > 0),
    source_id TEXT NOT NULL CHECK (length(source_id) > 0),
    source_seq INTEGER NOT NULL CHECK (typeof(source_seq) = 'integer' AND source_seq >= 0),
    emitted_at_ms INTEGER NOT NULL CHECK (typeof(emitted_at_ms) = 'integer' AND emitted_at_ms >= 0),
    event_type TEXT NOT NULL CHECK (length(event_type) > 0),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    meta_json TEXT NOT NULL CHECK (json_valid(meta_json)),
    archived_at_ms INTEGER NOT NULL CHECK (typeof(archived_at_ms) = 'integer' AND archived_at_ms >= 0),
    PRIMARY KEY (run_id, generation, seq)
  )`.pipe(Effect.orDie)
})

const archive = (runId: string, seq: number) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    yield* sql`INSERT INTO flows_time_travel_archive
      (run_id, generation, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json, archived_at_ms)
      VALUES (${runId}, ${0}, ${seq}, ${`${runId}-archive-${seq}`}, ${"retention-test"}, ${seq}, ${0}, ${"archived"}, ${"{}"}, ${"{}"}, ${0})`
      .pipe(Effect.orDie)
  })

const seedTimeTravelReceipt = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_audits (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL
    )`.pipe(Effect.orDie)
    yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_receipts (
      id TEXT PRIMARY KEY,
      audit_id TEXT NOT NULL,
      effect_id TEXT NOT NULL,
      receipt_json TEXT NOT NULL
    )`.pipe(Effect.orDie)
    yield* sql`INSERT INTO flows_time_travel_audits
      (id, run_id) VALUES (${`audit-${runId}`}, ${runId})`.pipe(Effect.orDie)
    yield* sql`INSERT INTO flows_time_travel_receipts
      (id, audit_id, effect_id, receipt_json)
      VALUES (${`receipt-${runId}`}, ${`audit-${runId}`}, ${`effect-${runId}`}, ${"{}"})`.pipe(Effect.orDie)
  })

const timeTravelReceiptIds = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const rows = yield* sql<{ readonly id: string }>`SELECT id FROM flows_time_travel_receipts ORDER BY id`.pipe(
    Effect.orDie
  )
  return rows.map((row) => row.id)
})

const countOf = (table: string, column: string, runId: string) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const rows = yield* sql<{ readonly total: number }>`
      SELECT COUNT(*) AS total FROM ${sql.unsafe(table)} WHERE ${sql.unsafe(column)} = ${runId}
    `.pipe(Effect.orDie)
    return Number(rows[0]?.total ?? 0)
  })

/** Every table keyed by a run, and how many rows each holds for one run. */
const footprint = (runId: string) =>
  Effect.all({
    runs: countOf("flows_runs", "run_id", runId),
    attempts: countOf("flows_attempts", "run_id", runId),
    clocks: countOf("flows_clock_deadlines", "execution_id", runId),
    deferreds: countOf("flows_deferred_completions", "execution_id", runId),
    journal: countOf("flows_journal_events", "run_id", runId),
    checkpoints: countOf("flows_journal_checkpoints", "run_id", runId),
    stepCache: countOf("flows_step_cache_recorded", "recorded_run_id", runId),
    archive: countOf("flows_time_travel_archive", "run_id", runId),
    childEdges: countOf("flows_run_parents", "child_id", runId),
    parentEdges: countOf("flows_run_parents", "parent_id", runId)
  })

/** How many facts the run's run-store companion journal stream holds. */
const companionFacts = (runId: string) =>
  countOf("flows_journal_events", "run_id", JournalEvent.companionRunId(RunStore.companionStream, runId))

/** Creates a run, takes ownership, and leaves it `running` under `owner`. */
const activate = (runId: string, parentRunId?: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, runState, parentRunId === undefined ? undefined : { parentRunId })
    const row = yield* runs.get(runId)
    const expected = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, expected, owner, yield* Effect.clockWith((clock) => clock.currentTimeMillis))
    expect(claim._tag).toBe("Claimed")
    if (claim._tag !== "Claimed") return
    expect(yield* runs.activate(runId, owner, claim.claimedAtMs, expected)).toEqual({ _tag: "Activated" })
  })

/** Everything a finished run leaves behind, on one run id. */
const seedDependents = (runId: string) =>
  Effect.gen(function*() {
    const attempts = yield* AttemptStore.AttemptStore
    const state = yield* DurableEngineState.DurableEngineState
    const journal = yield* Journal.Journal
    const sql = yield* Effect.service(SqlClient.SqlClient)

    yield* attempts.put({
      runId,
      stepKeyDigest: `${runId}-step`,
      attempt: 1,
      state: "succeeded",
      startedAtMs: 0,
      finishedAtMs: 1,
      meta: { tier: "sealed" }
    }, owner).pipe(Effect.orDie)
    yield* state.scheduleClock({
      flowName,
      executionId: runId,
      clockName: `${runId}-clock`,
      deferredName: `${runId}-deferred`,
      dueAtMs: distantDeadlineMs,
      completedAtMs: null
    }, owner)
    yield* state.completeDeferred({
      flowName,
      executionId: runId,
      deferredName: `${runId}-deferred`,
      exit: Exit.succeed("done"),
      completedAtMs: 1
    })
    const receipt = yield* journal.emitDurableUnfenced(
      new JournalEvent.Input({
        runId: JournalEvent.RunId.make(runId),
        sourceId: JournalEvent.SourceId.make("retention-test"),
        eventType: "flows.retention.seed",
        payload: { runId }
      })
    ).pipe(Effect.orDie)
    // The checkpoint is written directly: `Journal.checkpoint` is owner-fenced
    // on a `running` row, so a finished run can never carry one written
    // through the service.
    yield* sql`INSERT INTO flows_journal_checkpoints (run_id, seq, state_json, created_at_ms)
      VALUES (${runId}, ${receipt.seq}, ${"{}"}, ${0})`.pipe(Effect.orDie)
    // The step cache's provenance row. It is on the engine ladder and it keys
    // on a run, and this pass used to leave it: `Retention.collect` swept it
    // and `retain` did not, so an engine workspace collected by `retain` kept
    // one row per cached step of every run it deleted.
    yield* sql`INSERT INTO flows_step_cache_recorded
      (key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq)
      VALUES (${`${runId}-digest`}, ${"{}"}, ${"{}"}, ${0}, ${runId}, ${0})`.pipe(Effect.orDie)
    yield* archive(runId, 0)
  })

/** Drives an owned run to a terminal status. */
const finish = (runId: string, status: "completed" | "failed" | "cancelled") =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const outcome = yield* runs.transitionOwned(runId, owner, status)
    expect(outcome).toEqual({ _tag: "Transitioned" })
  })

/** The reserved continuation column, read directly off the run row. */
const parentRunIdOf = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const rows = yield* sql<{ readonly parent_run_id: string | null }>`
      SELECT parent_run_id FROM flows_runs WHERE run_id = ${runId}
    `.pipe(Effect.orDie)
    return rows[0]?.parent_run_id ?? null
  })

/** The parent an engine hands `execute`, which becomes the DAG edge. */
const parentInstance = (executionId: string) => ({ executionId } as FlowRuntime.FlowInstance["Service"])

const statusOf = (runId: string) =>
  Effect.map(Effect.flatMap(RunStore.RunStore, (runs) => runs.get(runId)), (row) => row.status)

const stores = TestStores.layerAt(":memory:")

const retention = Effect.gen(function*() {
  yield* createArchiveTable
  return yield* RetentionOps.make()
})

describe("retention", () => {
  it.effect("discovers optional run-scoped tables and retains assumed ladder tables", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* createArchiveTable
          yield* seedTimeTravelReceipt("outside-empty-pass")
          return {
            discovered: yield* RetentionOps.installedTables(sql, { assumeLadder: false }),
            assumed: yield* RetentionOps.installedTables(sql, { assumeLadder: true }),
            empty: yield* RetentionOps.deleteRuns(sql, [], { dryRun: true, assumeLadder: false })
          }
        }).pipe(Effect.provide(stores))
      )

      expect(result.discovered.map((entry) => entry.table)).toContain("flows_time_travel_archive")
      expect(result.discovered.map((entry) => entry.table)).not.toContain("flows_time_travel_snapshots")
      expect(result.assumed).toEqual(result.discovered)
      expect(result.empty.deleted).toEqual({})
    }))

  it.effect("deletes receipts through doomed audits and preserves a live run's receipt", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        yield* activate("receipt-doomed")
        yield* seedTimeTravelReceipt("receipt-doomed")
        yield* finish("receipt-doomed", "completed")
        yield* TestClock.adjust(agingMs)
        yield* activate("receipt-live")
        yield* seedTimeTravelReceipt("receipt-live")

        const planned = yield* retain.retain({ olderThanMs: thresholdMs, dryRun: true })
        expect(planned.timeTravelReceipts).toBe(1)
        expect(yield* timeTravelReceiptIds).toEqual([
          "receipt-receipt-doomed",
          "receipt-receipt-live"
        ])

        const report = yield* retain.retain({ olderThanMs: thresholdMs })

        expect(report.runIds).toEqual(["receipt-doomed"])
        expect(report.timeTravelReceipts).toBe(1)
        expect(yield* timeTravelReceiptIds).toEqual(["receipt-receipt-live"])
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("deletes aged terminal runs with every dependent row and leaves live runs whole", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        const state = yield* DurableEngineState.DurableEngineState

        // Three aged terminal runs, one per terminal status, each carrying an
        // attempt, a pending clock deadline, a deferred completion, a journal
        // entry, a checkpoint, an archive row, and a parent edge.
        for (
          const [runId, status] of [
            ["aged-completed", "completed"],
            ["aged-failed", "failed"],
            ["aged-cancelled", "cancelled"]
          ] as const
        ) {
          yield* activate(runId)
          yield* seedDependents(runId)
          yield* finish(runId, status)
        }
        yield* state.recordRunParent("aged-failed", "aged-completed")

        yield* TestClock.adjust(agingMs)

        // A terminal run inside the retention window, and a live one.
        yield* activate("fresh-completed")
        yield* seedDependents("fresh-completed")
        yield* finish("fresh-completed", "completed")
        yield* activate("still-running")
        yield* seedDependents("still-running")

        const before = yield* footprint("still-running")
        const report = yield* retain.retain({ olderThanMs: thresholdMs })
        const after = yield* footprint("still-running")

        expect([...report.runIds].sort()).toEqual(["aged-cancelled", "aged-completed", "aged-failed"])
        expect(report.runs).toBe(3)
        expect(report.attempts).toBe(3)
        expect(report.clockDeadlines).toBe(3)
        expect(report.deferredCompletions).toBe(3)
        // One seeded entry per run, plus the three ownership facts (claimed,
        // activated, released) each run's companion stream holds.
        expect(report.journalEntries).toBe(3 + 3 * 3)
        expect(report.journalCheckpoints).toBe(3)
        expect(report.archiveEntries).toBe(3)
        expect(report.dryRun).toBe(false)

        // Every deleted run is gone from every table that keys on it, parent
        // edges included: the `flows_run_parents_gc` trigger drops those.
        for (const runId of ["aged-completed", "aged-failed", "aged-cancelled"]) {
          expect(yield* footprint(runId)).toEqual({
            runs: 0,
            attempts: 0,
            clocks: 0,
            deferreds: 0,
            journal: 0,
            checkpoints: 0,
            stepCache: 0,
            archive: 0,
            childEdges: 0,
            parentEdges: 0
          })
          expect(yield* companionFacts(runId)).toBe(0)
        }

        // The run inside the window and the live run are untouched.
        expect(yield* companionFacts("fresh-completed")).toBe(3)
        expect(yield* companionFacts("still-running")).toBe(2)
        expect((yield* footprint("fresh-completed")).runs).toBe(1)
        expect((yield* footprint("fresh-completed")).journal).toBe(1)
        expect(after).toEqual(before)
        expect(yield* statusOf("still-running")).toBe("running")
        expect(
          yield* state.clock({ flowName, executionId: "still-running", clockName: "still-running-clock" })
        ).toMatchObject({ _tag: "Some" })
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("keeps an aged terminal run whose descendant is still live", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention

        // grandparent <- parent <- child, all aged and terminal except the
        // child, which is still running. Deleting either ancestor would leave
        // the child's `parent_run_id` dangling.
        yield* activate("grandparent")
        yield* activate("parent", "grandparent")
        yield* activate("child", "parent")
        yield* finish("parent", "completed")
        yield* finish("grandparent", "completed")
        // A second lineage, terminal all the way down, is deleted whole.
        yield* activate("doomed-parent")
        yield* activate("doomed-child", "doomed-parent")
        yield* finish("doomed-child", "completed")
        yield* finish("doomed-parent", "completed")

        yield* TestClock.adjust(agingMs)
        const report = yield* retain.retain({ olderThanMs: thresholdMs })

        expect([...report.runIds].sort()).toEqual(["doomed-child", "doomed-parent"])
        expect([...report.retainedForLiveDescendants].sort()).toEqual(["grandparent", "parent"])
        expect(yield* statusOf("grandparent")).toBe("completed")
        expect(yield* statusOf("parent")).toBe("completed")
        expect(yield* statusOf("child")).toBe("running")
        expect((yield* footprint("doomed-parent")).runs).toBe(0)
        expect((yield* footprint("doomed-child")).runs).toBe(0)
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("keeps an aged terminal run whose ancestor is still live", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        const state = yield* DurableEngineState.DurableEngineState

        // A live parent that spawned a child, and the child settled first.
        // `agent/await` reads a child's result out of its run row, and a
        // parent parked on an approval, a deferred, or a timer can be parked
        // for longer than the retention threshold before it ever awaits. A
        // pass that collects the child leaves that await with `notFound` and
        // drops the parent's DAG edge with it.
        yield* activate("live-parent")
        // Linked the way a spawned child is linked in production: by the DAG
        // edge alone. `parent_run_id` is the trampoline continuation column
        // and stays NULL on a spawned child (`RunDriver.continueLineage`).
        yield* activate("finished-child")
        yield* state.recordRunParent("finished-child", "live-parent")
        yield* seedDependents("finished-child")
        yield* finish("finished-child", "completed")

        yield* TestClock.adjust(agingMs)
        const first = yield* retain.retain({ olderThanMs: thresholdMs })

        expect(first.runIds).toEqual([])
        expect(first.retainedForLiveAncestors).toEqual(["finished-child"])
        expect(first.runs).toBe(0)
        const child = yield* footprint("finished-child")
        expect(child.runs).toBe(1)
        expect(child.journal).toBe(1)
        expect(child.childEdges).toBe(1)
        expect((yield* footprint("live-parent")).parentEdges).toBe(1)
        expect(yield* statusOf("finished-child")).toBe("completed")

        // The child becomes collectable when the parent that could still ask
        // for it is finished and aged too.
        yield* finish("live-parent", "completed")
        yield* TestClock.adjust(agingMs)
        const second = yield* retain.retain({ olderThanMs: thresholdMs })

        expect([...second.runIds].sort()).toEqual(["finished-child", "live-parent"])
        expect(second.retainedForLiveAncestors).toEqual([])
        expect((yield* footprint("finished-child")).runs).toBe(0)
        expect((yield* footprint("live-parent")).runs).toBe(0)
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("keeps the settled child of a parked parent, spawned the way the engine spawns one", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        const ChildFlow = Flow.make("Retention/Child", {
          payload: {},
          success: Schema.String,
          body: opaqueHandlerBody
        })

        // A parent parked on an approval, a deferred, or a timer: live, and it
        // has not asked for its child's result yet.
        yield* activate("parked-parent")

        const engine = yield* EngineStore.make({
          owner: { hostId: "retention-host" },
          journalSource: "retention-test",
          isAlive: () => Effect.succeed(false)
        })
        yield* engine.register(ChildFlow, () => Effect.succeed("child-result"))
        // The spawn the engine itself writes. Nothing about the shape is
        // arranged by the test: `RunDriver` records the lineage as a
        // `flows_run_parents` edge and leaves the child row's
        // `parent_run_id` NULL, because that column carries the rounds of one
        // trampoline lineage instead.
        yield* executeUntilParked(engine, ChildFlow, {
          executionId: "spawned-child",
          payload: {},
          discard: true
        }).pipe(Effect.provideService(FlowRuntime.FlowInstance, parentInstance("parked-parent")))

        expect(yield* parentRunIdOf("spawned-child")).toBe(null)
        expect((yield* footprint("spawned-child")).childEdges).toBe(1)
        expect(yield* statusOf("spawned-child")).toBe("completed")

        yield* TestClock.adjust(agingMs)
        const report = yield* retain.retain({ olderThanMs: thresholdMs })

        expect(report.runIds).toEqual([])
        expect(report.retainedForLiveAncestors).toEqual(["spawned-child"])
        expect((yield* footprint("spawned-child")).runs).toBe(1)
        expect((yield* footprint("spawned-child")).childEdges).toBe(1)

        // The property the guard exists for: `agent/await` answers out of the
        // child's run row and its journal, both of which the pass left alone,
        // so the parent still gets the result it spawned the child for.
        const settled = yield* engine.poll(ChildFlow, "spawned-child")
        expect(Option.isSome(settled)).toBe(true)
        if (Option.isNone(settled)) return
        expect(settled.value._tag).toBe("Complete")
        if (settled.value._tag !== "Complete") return
        expect(settled.value.exit).toEqual(Exit.succeed("child-result"))

        // Nothing is pinned forever: the child goes with the parent that could
        // have asked for it, once that parent is terminal and aged too.
        yield* finish("parked-parent", "completed")
        yield* TestClock.adjust(agingMs)
        const second = yield* retain.retain({ olderThanMs: thresholdMs })

        expect([...second.runIds].sort()).toEqual(["parked-parent", "spawned-child"])
        expect((yield* footprint("spawned-child")).runs).toBe(0)
      }).pipe(
        Effect.scoped,
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("keeps a run whose second parent in a diamond is still live", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        const state = yield* DurableEngineState.DurableEngineState

        // A diamond: the child names two parents, and only the edge table
        // records the second one. One of them is aged and terminal, the other
        // is still live and can still await the child.
        yield* activate("settled-parent")
        yield* activate("second-parent")
        yield* activate("shared-child")
        yield* state.recordRunParent("shared-child", "settled-parent")
        yield* state.recordRunParent("shared-child", "second-parent")
        yield* finish("shared-child", "completed")
        yield* finish("settled-parent", "completed")

        yield* TestClock.adjust(agingMs)
        const first = yield* retain.retain({ olderThanMs: thresholdMs })

        // The child stays, held by the live parent alone. The terminal parent
        // goes, and `flows_run_parents_gc` takes the edge that named it with
        // it: an edge to a run that no longer exists is not lineage worth
        // keeping, and the walk reads the surviving edge either way.
        expect(first.runIds).toEqual(["settled-parent"])
        expect(first.retainedForLiveAncestors).toEqual(["shared-child"])
        expect(first.retainedForLiveDescendants).toEqual([])
        expect((yield* footprint("shared-child")).runs).toBe(1)
        expect((yield* footprint("shared-child")).childEdges).toBe(1)
        expect((yield* footprint("second-parent")).parentEdges).toBe(1)

        yield* finish("second-parent", "completed")
        yield* TestClock.adjust(agingMs)
        const second = yield* retain.retain({ olderThanMs: thresholdMs })

        expect([...second.runIds].sort()).toEqual(["second-parent", "shared-child"])
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("keeps an aged terminal run whose spawned child is still live", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        const state = yield* DurableEngineState.DurableEngineState

        // The downward direction over the same edge-only lineage. Collecting
        // the parent would fire `flows_run_parents_gc` and drop the running
        // child's ancestry, which the control plane reads out of that table.
        yield* activate("settled-spawner")
        yield* activate("running-child")
        yield* state.recordRunParent("running-child", "settled-spawner")
        yield* finish("settled-spawner", "completed")

        yield* TestClock.adjust(agingMs)
        const report = yield* retain.retain({ olderThanMs: thresholdMs })

        expect(report.runIds).toEqual([])
        expect(report.retainedForLiveDescendants).toEqual(["settled-spawner"])
        expect((yield* footprint("settled-spawner")).runs).toBe(1)
        expect((yield* footprint("running-child")).childEdges).toBe(1)
        expect(yield* statusOf("running-child")).toBe("running")
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("keeps an aged run its child still points at, and collects it once the child goes", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention

        // Nothing here is live: the child is terminal and simply younger than
        // the cutoff. `flows_runs.parent_run_id` is a self-referential foreign
        // key, so collecting the parent while that row exists would fail the
        // transaction.
        yield* activate("round-one")
        yield* finish("round-one", "completed")
        yield* TestClock.adjust(agingMs)
        yield* activate("round-two", "round-one")
        yield* finish("round-two", "completed")

        const first = yield* retain.retain({ olderThanMs: thresholdMs })

        expect(first.runIds).toEqual([])
        expect(first.retainedForLiveDescendants).toEqual(["round-one"])
        expect((yield* footprint("round-one")).runs).toBe(1)

        yield* TestClock.adjust(agingMs)
        const second = yield* retain.retain({ olderThanMs: thresholdMs })

        expect([...second.runIds].sort()).toEqual(["round-one", "round-two"])
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("collects past a retained lineage instead of spending the bound on it", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        const state = yield* DurableEngineState.DurableEngineState

        // Two aged children of one parked parent, both older than a third run
        // that nothing holds back. A bound applied before the lineage filter
        // fills its whole window with the two retained children and reports
        // nothing collected, pass after pass, while the workspace grows.
        yield* activate("long-parked-parent")
        for (const runId of ["held-one", "held-two"]) {
          yield* activate(runId)
          yield* state.recordRunParent(runId, "long-parked-parent")
          yield* finish(runId, "completed")
        }
        yield* TestClock.adjust(agingMs)
        yield* activate("collectable")
        yield* finish("collectable", "completed")
        yield* TestClock.adjust(agingMs)

        const report = yield* retain.retain({ olderThanMs: thresholdMs, limit: 1 })

        expect(report.runIds).toEqual(["collectable"])
        // The report carries the pass's own bound, so it names the oldest
        // retained run rather than every one of them.
        expect(report.retainedForLiveAncestors).toEqual(["held-one"])
        expect((yield* footprint("held-one")).runs).toBe(1)
        expect((yield* footprint("held-two")).runs).toBe(1)
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("reports what it would delete under dryRun without deleting it", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        yield* activate("aged")
        yield* seedDependents("aged")
        yield* finish("aged", "completed")
        yield* TestClock.adjust(agingMs)

        const planned = yield* retain.retain({ olderThanMs: thresholdMs, dryRun: true })
        const untouched = yield* footprint("aged")
        const executed = yield* retain.retain({ olderThanMs: thresholdMs })

        expect(planned.dryRun).toBe(true)
        expect(planned.runIds).toEqual(["aged"])
        expect(untouched.runs).toBe(1)
        expect(untouched.journal).toBe(1)
        expect({ ...planned, dryRun: false }).toEqual(executed)
        expect((yield* footprint("aged")).runs).toBe(0)
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("runs against a database that never installed the time-travel tables", () =>
    withCrypto(
      Effect.gen(function*() {
        // Time-travel block 5000 is not installed by the CLI, so the archive
        // table is absent from an ordinary engine database.
        const retain = yield* RetentionOps.make()
        yield* activate("aged")
        yield* finish("aged", "completed")
        yield* TestClock.adjust(agingMs)

        const report = yield* retain.retain({ olderThanMs: thresholdMs })

        expect(report.runIds).toEqual(["aged"])
        expect(report.archiveEntries).toBe(0)
        expect(yield* countOf("flows_runs", "run_id", "aged")).toBe(0)
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("bounds one invocation and converges across invocations", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        for (const runId of ["aged-a", "aged-b", "aged-c"]) {
          yield* activate(runId)
          yield* finish(runId, "completed")
        }
        yield* TestClock.adjust(agingMs)

        // A negative bound is read as zero, the way a negative age is. An
        // interpolated `LIMIT -1` is unbounded in SQLite, so without the clamp
        // a mistyped bound is a full sweep rather than a refused one.
        const refused = yield* retain.retain({ olderThanMs: thresholdMs, limit: -1 })
        expect(refused.runs).toBe(0)
        expect(refused.runIds).toEqual([])
        // A bound that is not an integer is refused the same way, and the
        // way `Retention.collect` refuses it, instead of reaching SQLite as
        // `LIMIT NaN` and failing as a scan error.
        for (const limit of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
          const invalid = yield* retain.retain({ olderThanMs: thresholdMs, limit })
          expect(invalid.runIds).toEqual([])
        }

        const first = yield* retain.retain({ olderThanMs: thresholdMs, limit: 2 })
        const second = yield* retain.retain({ olderThanMs: thresholdMs, limit: 2 })
        const third = yield* retain.retain({ olderThanMs: thresholdMs, limit: 2 })

        expect(first.runs).toBe(2)
        expect(second.runs).toBe(1)
        expect(third.runs).toBe(0)
        expect(third.runIds).toEqual([])
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  for (
    const { length, limit, unrelated } of [
      { length: 2, limit: 1, unrelated: false },
      { length: RetentionOps.defaultLimit + 1, limit: undefined, unrelated: false },
      { length: 3, limit: 1, unrelated: true }
    ]
  ) {
    it.effect(`converges over a terminal chain of ${length} with limit ${limit ?? "default"}${unrelated ? " and a younger unrelated run" : ""}`, () =>
      withCrypto(
        Effect.gen(function*() {
          const retain = yield* retention
          const sql = yield* SqlClient.SqlClient
          const ids = Array.from({ length }, (_, index) => `round-${String(index).padStart(4, "0")}`)
          for (const [index, runId] of ids.entries()) {
            yield* activate(runId, ids[index - 1])
            yield* finish(runId, "completed")
          }
          if (unrelated) {
            yield* TestClock.adjust(agingMs)
            yield* activate("unrelated")
            yield* finish("unrelated", "completed")
          }
          yield* TestClock.adjust(agingMs)

          const remaining = new Set(unrelated ? [...ids, "unrelated"] : ids)
          const options = { olderThanMs: thresholdMs, limit }
          while (remaining.size > 0) {
            const planned = yield* retain.retain({ ...options, dryRun: true })
            const report = yield* retain.retain(options)
            expect({ ...planned, dryRun: false }).toEqual(report)
            expect(report.runs).toBeGreaterThan(0)
            expect(report.runs).toBeLessThanOrEqual(limit ?? RetentionOps.defaultLimit)
            for (const runId of report.runIds) {
              expect(remaining.delete(runId)).toBe(true)
            }
            const rows = yield* sql<{ readonly run_id: string }>`SELECT run_id FROM flows_runs ORDER BY run_id`
            expect(rows.map((row) => row.run_id)).toEqual([...remaining].sort())
            expect(yield* sql`PRAGMA foreign_key_check`).toEqual([])
          }
          expect((yield* retain.retain(options)).runs).toBe(0)
        }).pipe(
          Effect.provideService(Jj.Jj, jj),
          Effect.provide(StepBoundary.layerTest()),
          Effect.provide(stores)
        )
      ))
  }

  it.effect("fills the bound past parents pinned by a younger terminal descendant", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        yield* activate("parent")
        yield* finish("parent", "completed")
        yield* activate("child", "parent")
        yield* finish("child", "completed")
        yield* TestClock.adjust(agingMs)
        yield* activate("unrelated")
        yield* finish("unrelated", "completed")
        yield* TestClock.adjust(agingMs)
        yield* activate("fresh", "child")
        yield* finish("fresh", "completed")

        const first = yield* retain.retain({ olderThanMs: thresholdMs, limit: 1 })
        expect(first.runIds).toEqual(["unrelated"])
        expect(first.retainedForLiveDescendants).toEqual(["child"])
        expect(yield* parentRunIdOf("fresh")).toBe("child")
        expect(yield* parentRunIdOf("child")).toBe("parent")
        yield* TestClock.adjust(agingMs)
        for (const runId of ["fresh", "child", "parent"]) {
          expect((yield* retain.retain({ olderThanMs: thresholdMs, limit: 1 })).runIds).toEqual([runId])
        }
        expect((yield* retain.retain({ olderThanMs: thresholdMs, limit: 1 })).runs).toBe(0)
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("collects a branching continuation lineage without selecting a parent before either child", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        const sql = yield* SqlClient.SqlClient
        for (
          const [runId, parent] of [
            ["root", undefined],
            ["left", "root"],
            ["right", "root"],
            ["leaf", "left"]
          ] as const
        ) {
          yield* activate(runId, parent)
          yield* finish(runId, "completed")
        }
        yield* TestClock.adjust(agingMs)
        expect((yield* retain.retain({ olderThanMs: thresholdMs, limit: 2 })).runIds).toEqual(["leaf", "left"])
        expect(yield* sql`PRAGMA foreign_key_check`).toEqual([])
        expect((yield* retain.retain({ olderThanMs: thresholdMs, limit: 2 })).runIds).toEqual(["right", "root"])
        expect(yield* sql`SELECT run_id FROM flows_runs`).toEqual([])
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("rolls back every table when a late retain delete aborts", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        const sql = yield* SqlClient.SqlClient
        const state = yield* DurableEngineState.DurableEngineState
        for (const runId of ["aged", "survivor"]) {
          yield* activate(runId)
          yield* seedDependents(runId)
          yield* seedTimeTravelReceipt(runId)
          yield* finish(runId, "completed")
        }
        yield* state.recordRunParent("aged", "survivor")
        yield* TestClock.adjust(agingMs)

        // ABORT rolls back only the failing statement. Attempts and journal
        // rows have already been deleted when this late inventory entry fires.
        yield* Dialect.trigger(sql, {
          name: `refuse_retention_archive`,
          table: `flows_time_travel_archive`,
          event: `BEFORE DELETE`,
          when: `OLD.run_id = 'aged'
            AND NOT EXISTS (SELECT 1 FROM flows_attempts WHERE run_id = 'aged')
            AND NOT EXISTS (SELECT 1 FROM flows_journal_events WHERE run_id = 'aged')`,
          reject: "late retention delete"
        }).pipe(Effect.orDie)
        const snapshot = Effect.gen(function*() {
          const tables = yield* sql<{ readonly name: string }>`
            SELECT name FROM ${TestDatabase.catalog(sql)} WHERE type = 'table' ORDER BY name
          `
          const rows: Record<string, ReadonlyArray<string>> = {}
          for (const { name } of tables) {
            rows[name] = (yield* sql`SELECT * FROM ${sql(name)}`).map((row) => JSON.stringify(row)).sort()
          }
          return rows
        }).pipe(Effect.orDie)
        const before = yield* snapshot
        expect((yield* footprint("aged")).attempts).toBe(1)
        expect((yield* footprint("aged")).journal).toBe(1)

        const exit = yield* Effect.exit(retain.retain({ olderThanMs: thresholdMs, limit: 1 }))

        expect(exit._tag).toBe("Failure")
        if (exit._tag !== "Failure") return
        expect(exit.cause.reasons[0]).toMatchObject({
          error: { code: "delete_failed", message: "flows_time_travel_archive could not be collected" }
        })
        expect(yield* snapshot).toEqual(before)
        yield* TestDatabase.dropTrigger(sql, "refuse_retention_archive").pipe(Effect.orDie)
        expect((yield* retain.retain({ olderThanMs: thresholdMs, limit: 1 })).runIds).toEqual(["aged"])
        expect((yield* footprint("aged")).runs).toBe(0)
        expect((yield* footprint("survivor")).journal).toBe(1)
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("fails typed when the schema it deletes from is not there", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* activate("aged")
        yield* finish("aged", "completed")
        yield* TestClock.adjust(agingMs)
        yield* sql`DROP TABLE flows_attempts ${
          sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
        }`.pipe(Effect.orDie)

        const exit = yield* Effect.exit(retain.retain({ olderThanMs: thresholdMs }))

        expect(exit._tag).toBe("Failure")
        if (exit._tag !== "Failure") return
        const error = exit.cause.reasons[0]
        expect(error).toMatchObject({ error: { code: "delete_failed" } })
        // Counting detects the missing table before deletion begins.
        expect(yield* countOf("flows_runs", "run_id", "aged")).toBe(1)
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("fails typed before deleting anything when the run table cannot be scanned", () =>
    withCrypto(
      Effect.gen(function*() {
        const retain = yield* retention
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* activate("aged")
        yield* finish("aged", "completed")
        yield* TestClock.adjust(agingMs)
        yield* sql`DROP TABLE flows_runs ${sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))}`
          .pipe(Effect.orDie)

        const exit = yield* Effect.exit(retain.retain({ olderThanMs: thresholdMs }))

        expect(exit._tag).toBe("Failure")
        if (exit._tag !== "Failure") return
        expect(exit.cause.reasons[0]).toMatchObject({ error: { code: "scan_failed" } })
      }).pipe(
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))

  it.effect("leaves a parked live run replayable after the finished runs around it are collected", () =>
    withCrypto(
      Effect.gen(function*() {
        const gate = DurableDeferred.make("retention-gate", { success: Schema.String })
        const ReplayFlow = Flow.make("Retention/Replay", {
          payload: {},
          success: Schema.String,
          body: opaqueHandlerBody
        })
        let dispatches = 0
        const first = Action.make({
          name: "first",
          success: Schema.String,
          tier: "sealed",
          idempotencyKey: "retention-first-v1",
          execute: Effect.sync(() => {
            dispatches++
            return "first-result"
          })
        })
        const handler = () =>
          Effect.gen(function*() {
            const head = yield* first
            const winner = yield* DurableDeferred.await(gate)
            return `${head}/${winner}`
          })

        const retain = yield* retention
        const makeEngine = EngineStore.make({
          owner: { hostId: "retention-host" },
          journalSource: "retention-test",
          isAlive: () => Effect.succeed(false)
        })

        // The finished neighbour ages first, before an engine exists: advancing
        // the virtual clock while one is composed steps every scheduled fiber
        // it holds through the whole interval.
        yield* activate("aged-neighbour")
        yield* seedDependents("aged-neighbour")
        yield* finish("aged-neighbour", "completed")
        yield* TestClock.adjust(agingMs)

        // A live run parked on a durable deferred, beside the aged one.
        const engine = yield* makeEngine
        yield* engine.register(ReplayFlow, handler)
        yield* executeUntilParked(engine, ReplayFlow, { executionId: "parked-run", payload: {}, discard: true })

        const report = yield* retain.retain({ olderThanMs: thresholdMs })
        expect(report.runIds).toEqual(["aged-neighbour"])

        // The parked run replays from its own journal and reaches its result.
        const resumed = yield* makeEngine
        yield* resumed.register(ReplayFlow, handler)
        yield* resumed.deferredDone(gate, {
          flowName: ReplayFlow._tag,
          executionId: "parked-run",
          deferredName: gate.name,
          exit: Exit.succeed("winner")
        })
        const value = yield* resumed.execute(ReplayFlow, {
          executionId: "parked-run",
          payload: {},
          discard: false
        })

        expect(value).toBe("first-result/winner")
        expect(dispatches).toBe(1)
        expect(yield* statusOf("parked-run")).toBe("completed")
      }).pipe(
        Effect.scoped,
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(stores)
      )
    ))
})
