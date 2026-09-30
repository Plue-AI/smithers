/**
 * The journal's durable channel accepts an `OwnerId` and fences the append on
 * it: the INSERT only lands while the consensus strategy still records that
 * owner as the run's owner, and otherwise the append fails `fence_lost` rather
 * than writing behind a live successor.
 *
 * The default strategy, `SqlConsensus`, keeps its lease in
 * `flows_consensus_leases`, a table this package's own migrations create, so
 * this suite stands the fence up by writing the lease row the strategy's
 * `guard` reads. `ConsensusConformance` drives the same fence through the
 * strategy's public operations, and `@smthrs/engine-store` pins the behaviour
 * against the whole composed schema in its `JournalFencing` suite.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { Journal, JournalError } from "../src/Journal.ts"
import { Input, type RunId, type Seq, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/OwnerId.ts"
import * as SqlJournal from "../src/SqlJournal.ts"
import * as Leases from "./fixtures/leases.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId

const owner: OwnerId = { hostId: "host-a", pid: 42, nonce: "nonce-a" }

const input = (run: RunId, source: SourceId, sourceSeq: number): Input =>
  new Input({
    runId: run,
    sourceId: source,
    sourceSeq: sourceSeq as SourceSeq,
    eventType: "flows.engine.run-decision",
    payload: { decision: "created" }
  }, { disableChecks: true })

const stack = SqlJournal.layer({ capacity: 8, overflow: "reject" }).pipe(
  Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
)

const withStack = <A, E>(
  body: Effect.Effect<A, E, Journal | DurableWriter | SqlClient.SqlClient | Scope.Scope>
) => Effect.scoped(body.pipe(Effect.provide(stack), Effect.provide(TestClock.layer())))

const claim = Leases.hold
const reclaim = Leases.hold

describe("SqlJournal durable fencing", () => {
  it.effect("refuses an unreadable consensus lease as sink_failed without appending", () =>
    withStack(Effect.gen(function*() {
      const journal = yield* Journal
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const run = runId("fenced-unreadable")
      yield* claim(sql, run, owner)
      yield* sql`DROP TABLE flows_consensus_leases`

      const failure = yield* Effect.flip(journal.emitDurable(input(run, sourceId("driver"), 0), owner))

      expect(failure.code).toBe("sink_failed")
      expect(failure.cause).toMatchObject({ code: "persistence_failed" })
      expect((failure.cause as { cause?: unknown }).cause).toBeDefined()
      const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM flows_journal_events`
      expect(Number(rows[0]!.count)).toBe(0)
    })))

  it.effect("commits a fenced append while the supplied owner still holds the run", () =>
    Effect.gen(function*() {
      const receipt = yield* withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("fenced-commit")
        yield* claim(sql, run, owner)
        return yield* journal.emitDurable(input(run, sourceId("driver"), 0), owner)
      }))

      expect(receipt._tag).toBe("Accepted")
    }))

  it.effect("fails the append with fence_lost once the run has a different owner", () =>
    Effect.gen(function*() {
      const failure = yield* withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("fenced-lost")
        yield* claim(sql, run, { hostId: "host-b", pid: 7, nonce: "nonce-b" })
        return yield* Effect.flip(journal.emitDurable(input(run, sourceId("driver"), 0), owner))
      }))

      expect(failure).toBeInstanceOf(JournalError)
      expect((failure as JournalError).code).toBe("fence_lost")
    }))

  it.effect("separates an unmatched owner from one that is not an OwnerId at all", () =>
    Effect.gen(function*() {
      // Two different caller mistakes, and the journal must not conflate them.
      //
      // An empty `hostId` or `nonce` is a legal string that simply matches no
      // claimed row, which is what `fence_lost` means. A fractional, `NaN`, or
      // infinite `pid` is not a process id: it fails the `OwnerId` schema, and
      // reporting it as `fence_lost` would tell the caller another process
      // owns the run and send it hunting a race that never happened.
      const unmatched: ReadonlyArray<OwnerId> = [
        { hostId: "", pid: 42, nonce: "nonce-a" },
        { hostId: "host-a", pid: 42, nonce: "" }
      ]
      // Built through a cast: the point is that these no longer typecheck as
      // an `OwnerId`, and that the runtime agrees.
      const invalid = [
        { hostId: "host-a", pid: 42.5, nonce: "nonce-a" },
        { hostId: "host-a", pid: Number.NaN, nonce: "nonce-a" },
        { hostId: "host-a", pid: Number.POSITIVE_INFINITY, nonce: "nonce-a" },
        { hostId: "host-a", pid: -1, nonce: "nonce-a" },
        undefined,
        null
      ] as unknown as ReadonlyArray<OwnerId>

      const result = yield* withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("fenced-malformed")
        yield* claim(sql, run, owner)
        const lost = yield* Effect.forEach(
          unmatched,
          (holder, index) => Effect.flip(journal.emitDurable(input(run, sourceId("driver"), index), holder))
        )
        const rejected = yield* Effect.forEach(
          invalid,
          (holder, index) => Effect.flip(journal.emitDurable(input(run, sourceId("invalid"), index), holder))
        )
        // The same contract on the other two fenced methods.
        const checkpointed = yield* Effect.flip(
          journal.checkpoint({ runId: run, seq: 0 as Seq, state: null }, undefined as unknown as OwnerId)
        )
        const compacted = yield* Effect.flip(
          journal.compact({ runId: run }, undefined as unknown as OwnerId)
        )
        const rows = yield* sql<{ readonly total: number }>`
        SELECT COUNT(*) AS total FROM flows_journal_events WHERE run_id = ${run}
      `
        const checkpoints = yield* sql<{ readonly total: number }>`
        SELECT COUNT(*) AS total FROM flows_journal_checkpoints WHERE run_id = ${run}
      `
        return {
          lost,
          rejected,
          checkpointed,
          compacted,
          total: Number(rows[0]!.total),
          checkpointTotal: Number(checkpoints[0]!.total)
        }
      }))

      for (const failure of result.lost) {
        expect(failure).toBeInstanceOf(JournalError)
        expect((failure as JournalError).code).toBe("fence_lost")
      }
      for (const failure of result.rejected) {
        expect(failure).toBeInstanceOf(JournalError)
        expect((failure as JournalError).code).toBe("invalid_event")
        expect((failure as JournalError).message).toBe("emitDurable requires a well-formed owner fence")
      }
      expect(result.checkpointed.code).toBe("invalid_event")
      expect(result.checkpointed.message).toBe("checkpoint requires a well-formed owner fence")
      expect(result.compacted.code).toBe("invalid_event")
      expect(result.compacted.message).toBe("compact requires a well-formed owner fence")
      // Nothing was written, checkpointed, or deleted by any of them.
      expect(result.total).toBe(0)
      expect(result.checkpointTotal).toBe(0)
    }))

  it.effect("stays idempotent when a fenced retry re-emits an already-committed entry", () =>
    Effect.gen(function*() {
      const receipts = yield* withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("fenced-retry")
        yield* claim(sql, run, owner)
        const first = yield* journal.emitDurable(input(run, sourceId("driver"), 0), owner)
        const second = yield* journal.emitDurable(input(run, sourceId("driver"), 0), owner)
        return [first, second] as const
      }))

      expect(receipts[0]._tag).toBe("Accepted")
      expect(receipts[1]._tag).toBe("Duplicate")
    }))

  it.effect("rejects a checkpoint from a superseded owner with fence_lost", () =>
    Effect.gen(function*() {
      const failure = yield* withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("fenced-checkpoint-superseded")
        yield* claim(sql, run, owner)
        yield* journal.emitDurable(input(run, sourceId("driver"), 0), owner)
        // The run is reclaimed under a new owner; the old owner's fence is gone.
        yield* reclaim(sql, run, { hostId: "host-b", pid: 7, nonce: "nonce-b" })
        return yield* Effect.flip(journal.checkpoint({ runId: run, seq: 0 as Seq, state: null }, owner))
      }))

      expect(failure).toBeInstanceOf(JournalError)
      expect((failure as JournalError).code).toBe("fence_lost")
    }))

  it.effect("rejects a compaction from a superseded owner with fence_lost", () =>
    Effect.gen(function*() {
      const failure = yield* withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("fenced-compact-superseded")
        yield* claim(sql, run, owner)
        yield* journal.emitDurable(input(run, sourceId("driver"), 0), owner)
        yield* journal.checkpoint({ runId: run, seq: 0 as Seq, state: null }, owner)
        // The run is reclaimed under a new owner; the old owner's fence is gone.
        yield* reclaim(sql, run, { hostId: "host-b", pid: 7, nonce: "nonce-b" })
        return yield* Effect.flip(journal.compact({ runId: run }, owner))
      }))

      expect(failure).toBeInstanceOf(JournalError)
      expect((failure as JournalError).code).toBe("fence_lost")
    }))

  // A released lease is what every non-running run holds: `RunStore`'s
  // suspension and terminal transitions release the strategy's lease, so the
  // fence no longer answers for the owner at all. The PID-only mismatch keeps
  // the row and changes one member of the tuple.
  const lostFences: ReadonlyArray<{
    readonly label: string
    readonly lose: (sql: SqlClient.SqlClient, run: RunId) => Effect.Effect<unknown, unknown>
  }> = [
    { label: "a released lease", lose: Leases.release },
    {
      label: "a PID-only mismatch",
      lose: (sql, run) => sql`UPDATE flows_consensus_leases SET owner_pid = 7 WHERE run_id = ${run}`
    }
  ]

  for (const { label, lose } of lostFences) {
    for (const operation of ["fresh append", "duplicate append", "checkpoint", "compact"] as const) {
      it.effect(`rejects ${operation} with ${label} without changing durable state`, () =>
        withStack(Effect.gen(function*() {
          const journal = yield* Journal
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const run = runId("fenced-boundary")
          const source = sourceId("driver")
          yield* claim(sql, run, owner)
          for (const sequence of [0, 1, 2]) {
            yield* journal.emitDurable(input(run, source, sequence), owner)
          }
          yield* journal.checkpoint({ runId: run, seq: 0 as Seq, state: { version: 0 } }, owner)
          yield* journal.compact({ runId: run }, owner)
          yield* journal.checkpoint({ runId: run, seq: 2 as Seq, state: { version: 1 } }, owner)

          const durableState = Effect.gen(function*() {
            const events = yield* sql`
              SELECT * FROM flows_journal_events WHERE run_id = ${run} ORDER BY seq
            `
            const checkpoints = yield* sql`
              SELECT * FROM flows_journal_checkpoints WHERE run_id = ${run} ORDER BY seq
            `
            const floors = yield* sql<{ readonly floor: number | null }>`
              SELECT MAX(seq) AS floor FROM flows_journal_checkpoints
              WHERE run_id = ${run} AND compacted_at_ms IS NOT NULL
            `
            return { events, checkpoints, floor: floors[0]!.floor }
          })
          const before = yield* durableState
          expect(before.events).toHaveLength(3)
          expect(before.checkpoints).toHaveLength(2)
          expect(before.floor).toBe(0)

          yield* lose(sql, run)
          // The fresh identity exercises the fenced INSERT; the duplicate
          // must pass fenceGuard before it can be classified as idempotent.
          // Replacing the uncompacted checkpoint is otherwise valid, and
          // compaction would delete two events and advance the existing floor.
          const attempted = operation === "checkpoint"
            ? journal.checkpoint({ runId: run, seq: 2 as Seq, state: { version: 2 } }, owner).pipe(Effect.asVoid)
            : operation === "compact"
            ? journal.compact({ runId: run }, owner).pipe(Effect.asVoid)
            : journal.emitDurable(input(run, source, operation === "fresh append" ? 3 : 2), owner).pipe(Effect.asVoid)
          const failure = yield* attempted.pipe(Effect.match({
            onFailure: (error) => error,
            onSuccess: () => undefined
          }))
          const after = yield* durableState

          expect(failure).toBeInstanceOf(JournalError)
          expect(failure?.code).toBe("fence_lost")
          expect(after.events).toEqual(before.events)
          expect(after.checkpoints).toEqual(before.checkpoints)
          expect(after.floor).toBe(before.floor)
        })))
    }
  }
})
