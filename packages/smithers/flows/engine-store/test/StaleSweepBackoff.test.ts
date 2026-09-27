/**
 * B-04: what the stale-running sweep costs when the owners are alive.
 *
 * `staleRunningRuns` is `ORDER BY heartbeat_at_ms, run_id LIMIT 64` with no
 * cursor, and the sweep woke that same batch every heartbeat. When the probe
 * answers "the owner is alive" the batch never drains, so two things went
 * wrong at once: the sixty-fifth stale row was never probed at all — the
 * oldest sixty-four are ahead of it forever — and every refusal wrote a
 * durable journal record through the default source id, one row per refused
 * run per second, for as long as the owners stayed alive.
 *
 * Both are fixed by remembering the refusal: a run whose owner was just proven
 * alive is not re-probed until its backoff elapses, which is what lets the
 * batch move past it, and the refusal record is addressed by
 * `(run, owner, heartbeat)` so the journal admits it once.
 *
 * Uses the SQL `DurableEngineState` over the same database as `RunStore`,
 * because the evidence is `flows_runs` itself.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal, SqlJournal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { spawn } from "node:child_process"
import { once } from "node:events"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as Migrations from "../src/Migrations.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("StaleSweepBackoff/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 4096, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(migratedDatabase))

const staleAfterMs = Duration.toMillis(Ownership.heartbeatStaleAfter)
const heartbeatMs = Duration.toMillis(Ownership.heartbeatInterval)

/** One row per stale run, all older than the cutoff, ordered by heartbeat. */
const rows = 65
const runIdOf = (index: number) => `stale-${String(index).padStart(2, "0")}`

/**
 * A `running` row under a named owner with a frozen lease and no waiting row.
 *
 * Written straight through SQL because no live composition can produce it: an
 * owner that is gone never got to release, and an owner that is alive but
 * stalled never got to pulse.
 */
const insertRunOwnedBy = (runId: string, owner: Ownership.OwnerId, heartbeatAtMs: number) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter.DurableWriter
    const stateJson = JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} })
    yield* writer.write(sql`
      INSERT INTO flows_runs (
        run_id,
        status,
        created_at_ms,
        started_at_ms,
        owner_host_id,
        owner_pid,
        owner_nonce,
        heartbeat_at_ms,
        state_json,
        lineage_id,
        round_ordinal
      ) VALUES (
        ${runId},
        'running',
        0,
        0,
        ${owner.hostId},
        ${owner.pid},
        ${owner.nonce},
        ${heartbeatAtMs},
        ${stateJson},
        ${runId},
        0
      )
    `).pipe(Effect.orDie)
  })

/**
 * A hard-killed-looking row whose owner is nonetheless alive: `running`, a
 * heartbeat frozen at `index` milliseconds, and no waiting row. The nonce
 * carries the run id so the injected probe can say which row it was asked
 * about — the probe is handed an owner and a lease, never a run id.
 */
const insertStaleRun = (index: number) =>
  insertRunOwnedBy(runIdOf(index), { hostId: "live-host", pid: 424242, nonce: runIdOf(index) }, index)

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  withCrypto(
    Effect.scoped(effect as Effect.Effect<A, E, Scope.Scope>).pipe(
      Effect.provide(services),
      Effect.provide(TestClock.layer())
    ) as Effect.Effect<A>
  )

/** Every `steal-refused-owner-alive` decision journaled for one run. */
const refusalsOf = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as never, limit: 200 })
    return page.entries.filter((entry) =>
      entry.eventType === "flows.engine.run-decision" &&
      (entry.payload as { readonly decision?: string }).decision === "steal-refused-owner-alive"
    )
  })

/** Every run decision journaled for one run, in order. */
const decisionsFor = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as never, limit: 200 })
    return page.entries
      .filter((entry) => entry.eventType === "flows.engine.run-decision")
      .map((entry) => (entry.payload as { readonly decision: string }).decision)
  })

/** The `evidence` field of every refusal journaled for one run, in order. */
const refusalEvidenceOf = (runId: string) =>
  Effect.map(
    refusalsOf(runId),
    (entries) => entries.map((entry) => (entry.payload as { readonly evidence: string }).evidence)
  )

describe("the stale-running sweep backs off refused rows (B-04)", () => {
  it.effect("probes past the batch within two ticks and journals one refusal per lease", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        /** Owner nonces the probe was asked about, in order, per tick. */
        const probed: Array<string> = []
        const driver = yield* RunDriver.make({
          owner: { hostId: "sweep-host", pid: 1, nonce: "sweeper" },
          journalSource: "stale-sweep-backoff",
          // The owner is alive on every probe, so no steal ever succeeds and
          // the stale set never shrinks. That is the shape this case is about.
          isAlive: (expectedOwner) =>
            Effect.sync(() => {
              probed.push(expectedOwner.nonce)
              return true
            }),
          engine: Effect.succeed(fakeEngine)
        })
        yield* driver.register(TestFlow, () => Effect.succeed("never reached"))
        for (let index = 1; index <= rows; index++) {
          yield* insertStaleRun(index)
        }

        // Cross the staleness horizon so every row is sweepable, then take
        // exactly two sweep ticks.
        yield* TestClock.adjust(staleAfterMs + heartbeatMs)
        yield* TestDatabase.until(Effect.sync(() => probed.length >= 64))
        yield* TestDatabase.until(refusalsOf(runIdOf(64)).pipe(Effect.map((rows) => rows.length === 1)))
        const afterFirstTick = [...probed]
        yield* TestClock.adjust(heartbeatMs)
        yield* TestDatabase.until(Effect.sync(() => probed.length >= 65))
        yield* TestDatabase.until(refusalsOf(runIdOf(65)).pipe(Effect.map((rows) => rows.length === 1)))
        const afterSecondTick = [...probed]

        // Then keep ticking well past the first backoff: the refusals repeat,
        // and the journal must not.
        yield* TestClock.adjust(heartbeatMs * 10)

        return {
          afterFirstTick,
          afterSecondTick,
          refusalsFirst: (yield* refusalsOf(runIdOf(1))).length,
          refusalsLast: (yield* refusalsOf(runIdOf(rows))).length,
          probesForLast: probed.filter((nonce) => nonce === runIdOf(rows)).length,
          statuses: yield* Effect.forEach(
            [runIdOf(1), runIdOf(rows)],
            (runId) => Effect.flatMap(store.get(runId), (row) => Effect.succeed(row.status))
          )
        }
      }))

      // The first tick can only reach the batch, which is the oldest 64 rows.
      expect(result.afterFirstTick).toHaveLength(64)
      expect(result.afterFirstTick).not.toContain(runIdOf(rows))
      // The second tick has to reach past them, or the sixty-fifth row is
      // never arbitrated at all.
      expect(result.afterSecondTick).toContain(runIdOf(rows))
      // And it is probed, not merely enumerated.
      expect(result.probesForLast).toBeGreaterThanOrEqual(1)
      // One durable refusal record per (run, owner, heartbeat), however many
      // times the sweep re-probes: the lease never moved, so there is only
      // ever one thing to say.
      expect(result.refusalsFirst).toBe(1)
      expect(result.refusalsLast).toBe(1)
      // Nothing was stolen from a live owner.
      expect(result.statuses).toEqual(["running", "running"])
    }))

  it.effect("forgets a refusal once its row leaves the stale window", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter.DurableWriter
        const probed: Array<number> = []
        const driver = yield* RunDriver.make({
          owner: { hostId: "sweep-host", pid: 1, nonce: "sweeper" },
          journalSource: "stale-sweep-backoff",
          isAlive: (_expectedOwner, context) =>
            Effect.sync(() => {
              probed.push(context.nowMs)
              return true
            }),
          engine: Effect.succeed(fakeEngine)
        })
        yield* driver.register(TestFlow, () => Effect.succeed("never reached"))
        yield* insertStaleRun(1)

        /** Rewrites the row's lease, which is what a stalling owner does. */
        const setHeartbeat = (heartbeatAtMs: number) =>
          writer.write(sql`
            UPDATE flows_runs SET heartbeat_at_ms = ${heartbeatAtMs} WHERE run_id = ${runIdOf(1)}
          `).pipe(Effect.orDie)

        // Three refusals in a row: the wait doubles each time, so by the third
        // the row is deferred for several ticks.
        yield* TestClock.adjust(staleAfterMs + heartbeatMs)
        yield* TestDatabase.until(Effect.sync(() => probed.length >= 1))
        yield* TestDatabase.until(refusalsOf(runIdOf(1)).pipe(Effect.map((rows) => rows.length === 1)))
        yield* TestClock.adjust(heartbeatMs * 2)
        yield* TestDatabase.until(Effect.sync(() => probed.length >= 2))
        yield* TestClock.adjust(heartbeatMs * 4)
        yield* TestDatabase.until(Effect.sync(() => probed.length >= 3))
        const afterThreeRefusals = probed.length

        // The owner starts heartbeating again, so the row leaves the stale
        // window entirely and the sweep stops seeing it.
        const nowMs = yield* Clock.currentTimeMillis
        yield* setHeartbeat(nowMs)
        yield* TestClock.adjust(heartbeatMs)
        const whileFresh = probed.length

        // …and then stalls again, under a new lease. The refusal the driver
        // was holding was about the old one, so this stall is arbitrated now
        // rather than waiting out a backoff it did not earn.
        yield* setHeartbeat((yield* Clock.currentTimeMillis) - staleAfterMs - 1)
        yield* TestClock.adjust(heartbeatMs)
        yield* TestDatabase.until(Effect.sync(() => probed.length >= 4))
        return { afterThreeRefusals, whileFresh, afterNewLease: probed.length }
      }))

      expect(result.afterThreeRefusals).toBe(3)
      // A row outside the stale window is not probed at all.
      expect(result.whileFresh).toBe(3)
      // The new stall is probed on the first tick that sees it.
      expect(result.afterNewLease).toBe(4)
    }))

  /**
   * One lease can be refused for two different reasons, and both have to be
   * sayable.
   *
   * A refusal is addressed by the run, the owner, and the lease it was refused
   * against, so the journal's first-writer admission collapses repeats. That
   * address left out WHY the steal was refused, and the two reasons carry
   * different payloads: an owner whose heartbeat is still inside the window is
   * refused by the lease alone (`lease-fresh`, no probe consulted), and the
   * same owner, still alive but no longer pulsing, is refused by the probe
   * (`probe`). A run woken while its owner was fresh and then swept once that
   * owner stalled therefore wrote two different records to one address, which
   * the journal rejects as `idempotency_conflict` — a defect, killing the
   * drive fiber, losing the probe refusal, and taking down any `execute`
   * joined to that run.
   *
   * The wake is the operator `resume` path, which is also the shape a signal
   * completion and an `execute` join take.
   */
  it.effect("says why a lease was refused, so one lease can record both reasons", () =>
    Effect.gen(function*() {
      const logs: Array<string> = []
      const capture = Logger.make((options) => {
        logs.push(String(options.message))
      })
      const result = yield* run(
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const driver = yield* RunDriver.make({
            owner: { hostId: "sweep-host", pid: 1, nonce: "sweeper" },
            journalSource: "stale-sweep-backoff",
            // The owner never dies; it only stops pulsing. That is the whole
            // point: the lease expires while the process is still there.
            isAlive: () => Effect.succeed(true),
            engine: Effect.succeed(fakeEngine)
          })
          yield* driver.register(TestFlow, () => Effect.succeed("never reached"))
          const stalled: Ownership.OwnerId = { hostId: "live-host", pid: 424242, nonce: "stalled" }
          yield* insertRunOwnedBy("contested", stalled, 0)

          // Woken while the lease is still fresh: refused by the lease.
          yield* driver.resume(TestFlow, "contested")
          const afterWake = yield* refusalEvidenceOf("contested")

          // The owner stalls on that same heartbeat until the lease expires,
          // so the stale sweep arbitrates the SAME (run, owner, lease) with a
          // probe instead.
          yield* TestClock.adjust(staleAfterMs + heartbeatMs)
          yield* TestDatabase.until(
            refusalEvidenceOf("contested").pipe(Effect.map((values) => values.includes("probe")))
          )
          const afterSweep = yield* refusalEvidenceOf("contested")

          // A caller joining the run must be told to wait, not be killed by
          // the journal write the sweep just attempted.
          const settled = yield* driver.execute(TestFlow, {
            executionId: "contested",
            payload: {},
            discard: false
          })
          return { afterWake, afterSweep, settled, row: yield* store.get("contested") }
        }).pipe(Effect.provide(Logger.layer([capture])))
      )

      expect(result.afterWake).toEqual(["lease-fresh"])
      // Both reasons survive: the lease refusal the operator's resume hit, and
      // the probe refusal that answered for the stalled owner.
      expect(result.afterSweep).toEqual(["lease-fresh", "probe"])
      // Nothing was stolen, and the join was answered rather than killed.
      expect(result.row.status).toBe("running")
      expect(result.settled).toBeInstanceOf(Flow.Suspended)
      expect(logs.filter((message) => message.includes("coordinated drain failed"))).toEqual([])
    }))

  /**
   * A refusal is EVIDENCE about a run this driver does not own, and evidence
   * must never raise on the fiber that drives every run in the process.
   *
   * Addressing a refusal by `(run, owner, lease, evidence)` makes the journal
   * deduplicate it, and the payload under that address is a pure function of
   * the address, so this driver cannot conflict with itself. It is not the
   * only writer. Another process arbitrating the same row, an older release
   * whose payload carried different fields, or a journal copied by a
   * time-travel fork all leave a record at an address this driver will write
   * to next, and the journal answers `idempotency_conflict` for same address /
   * different content. Emitted through the plain decision path that error was
   * an `Effect.orDie` on the drive loop: the audit write killed the driver,
   * lost the record it was trying to make, and took down every `execute`
   * joined to that run — for a disagreement about an audit row.
   *
   * The record is therefore emitted converging, the shape `ActionPersistence`
   * uses on its replay branches: `Accepted` stands, `Duplicate` is the
   * deduplication doing its job, and a conflict is logged and left alone,
   * because the durable record is the one that was there first.
   *
   * The conflicting record is pre-written here through the journal itself, at
   * the exact address `stealRefusedSourceId` mints, which is the only way to
   * reach the conflict without pretending the journal is something else.
   */
  it.effect("logs a refusal the journal will not admit, and keeps driving the run", () =>
    Effect.gen(function*() {
      const logs: Array<string> = []
      const capture = Logger.make((options) => {
        logs.push(String(options.message))
      })
      const result = yield* run(
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const journal = yield* Journal.Journal
          const stalled: Ownership.OwnerId = { hostId: "live-host", pid: 424242, nonce: "stalled" }
          yield* insertRunOwnedBy("contested", stalled, 0)

          // Exactly the address `RunDriver.stealRefusedSourceId` mints for
          // this (owner, lease, evidence). Spelled out rather than imported so
          // that changing the address shape has to be a deliberate edit here.
          const refusalSource = `stale-sweep-backoff:steal-refused:lease-fresh:${
            JSON.stringify([stalled.hostId, stalled.pid, stalled.nonce])
          }:0`
          const foreignRefusal = JournalRecords.runDecision({
            runId: "contested",
            lineageId: FlowEngine.Lineage.root("contested"),
            sourceId: refusalSource,
            sourceSeq: 0
          }, {
            decision: "steal-refused-owner-alive",
            evidence: "lease-fresh",
            expectedOwner: stalled,
            heartbeatAtMs: 0,
            // The difference. Nothing this driver writes carries this field,
            // so its own refusal is same-address / different-content.
            recordedBy: "another process"
          })
          const preWritten = yield* journal.emitDurableUnfenced(foreignRefusal)

          const driver = yield* RunDriver.make({
            owner: { hostId: "sweep-host", pid: 1, nonce: "sweeper" },
            journalSource: "stale-sweep-backoff",
            isAlive: () => Effect.succeed(true),
            engine: Effect.succeed(fakeEngine)
          })
          yield* driver.register(TestFlow, () => Effect.succeed("never reached"))

          // The operator's `resume`: the driver refuses the steal, and its
          // refusal record collides with the one already at that address.
          yield* driver.resume(TestFlow, "contested")

          // A caller joining the run is answered rather than killed.
          const settled = yield* driver.execute(TestFlow, {
            executionId: "contested",
            payload: {},
            discard: false
          })

          // A third record, identical to the one holding the address: the
          // journal answers `Duplicate`, which is what makes the middle write
          // a genuine content conflict rather than a broken address.
          const third = yield* journal.emitDurableUnfenced(foreignRefusal)
          return {
            preWritten: preWritten._tag,
            third: third._tag,
            refusals: yield* refusalsOf("contested"),
            settled,
            row: yield* store.get("contested")
          }
        }).pipe(Effect.provide(Logger.layer([capture])))
      )

      expect(result.preWritten).toBe("Accepted")
      // The first writer still holds the address, with its content intact.
      expect(result.refusals).toHaveLength(1)
      expect((result.refusals[0]!.payload as { readonly recordedBy?: string }).recordedBy).toBe("another process")
      // The conflict is an outcome the driver logged, not a defect it raised.
      expect(logs.some((message) => message.includes("was not admitted to the journal (idempotency_conflict)"))).toBe(
        true
      )
      expect(logs.filter((message) => message.includes("coordinated drain failed"))).toEqual([])
      // The run is untouched and the join was answered.
      expect(result.row.status).toBe("running")
      expect(result.settled).toBeInstanceOf(Flow.Suspended)
      expect(result.third).toBe("Duplicate")
    }))
})

/**
 * B-09: what two engine processes over one `.flows/engine.db` do to each
 * other's running rows.
 *
 * The lease is only a timeout. A driver whose owner stalls longer than
 * `heartbeatStaleAfter` — a stop-the-world pause, a swapped-out process, a
 * disk that blocked — looks exactly like a driver that died, so the other
 * process reclaims a run that is still executing somewhere. Every composition
 * in the repository answered `isAlive: () => Effect.succeed(false)`, which
 * made that the guaranteed outcome rather than the unlucky one.
 *
 * `Ownership.sameHostPidProbe` is the evidence the lease was standing in for.
 * These cases compose two real drivers over one real database and one real
 * child process, and take the arbitration both ways: refused while the pid is
 * alive, granted once it has exited.
 */
describe("two drivers over one database arbitrate by pid (B-09)", () => {
  /** A real process this host can be asked about, killed when the scope closes. */
  const liveProcess = Effect.acquireRelease(
    Effect.sync(() => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })),
    (child) =>
      Effect.sync(() => {
        child.kill("SIGKILL")
      })
  )

  it.effect("refuses a live owner's row and takes it once that process exits", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const child = yield* liveProcess
        // The other driver's identity: this very host, and a pid that is
        // really running until this test stops it.
        const ownerA: Ownership.OwnerId = { hostId: "sweep-host", pid: child.pid as number, nonce: "driver-a" }
        yield* insertRunOwnedBy("contested", ownerA, 0)

        let executions = 0
        const driverB = yield* RunDriver.make({
          owner: { hostId: "sweep-host", pid: process.pid, nonce: "driver-b" },
          journalSource: "stale-sweep-backoff",
          // The production Node check, not a stub: the answer comes from the
          // operating system's process table.
          isAlive: Ownership.sameHostPidProbe,
          engine: Effect.succeed(fakeEngine)
        })
        yield* driverB.register(TestFlow, () =>
          Effect.sync(() => {
            executions = executions + 1
            return "taken over"
          }))

        // Past the lease window, which is the only thing the old code had to
        // go on. The row is sweepable and driver A is alive.
        yield* TestClock.adjust(staleAfterMs + heartbeatMs)
        yield* TestDatabase.until(refusalsOf("contested").pipe(Effect.map((rows) => rows.length === 1)))
        const whileAlive = {
          executions,
          row: yield* store.get("contested"),
          refusals: (yield* refusalsOf("contested")).length
        }

        // Driver A dies the way a crash kills it, and is reaped, so the pid
        // names nothing by the time the next probe asks.
        child.kill("SIGKILL")
        yield* Effect.promise(() => once(child, "exit"))

        // Past the first refusal's backoff, which is two ticks.
        yield* TestClock.adjust(heartbeatMs * 3)
        yield* TestDatabase.until(store.get("contested").pipe(Effect.map((row) => row.status === "completed")))
        return {
          whileAlive,
          afterExit: { executions, row: yield* store.get("contested") },
          decisions: yield* decisionsFor("contested")
        }
      }))

      // A live pid is never stolen from, however stale its lease.
      expect(result.whileAlive.row.status).toBe("running")
      expect(result.whileAlive.row.owner).toEqual(expect.objectContaining({ nonce: "driver-a" }))
      expect(result.whileAlive.executions).toBe(0)
      // And the refusal was recorded once, against the probe rather than the
      // lease: the lease had already expired.
      expect(result.whileAlive.refusals).toBe(1)
      expect(result.decisions).toContain("steal-refused-owner-alive")
      // Once the process is gone the run is reclaimed and finished, so a crash
      // does not strand a run behind its own dead owner.
      expect(result.afterExit.executions).toBe(1)
      expect(result.afterExit.row.status).toBe("completed")
      expect(result.afterExit.row.owner).toBeNull()
      expect(result.decisions).toContain("stolen-and-activated")
    }))
})
