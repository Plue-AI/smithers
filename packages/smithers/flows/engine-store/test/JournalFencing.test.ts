import { describe, expect, it } from "@effect/vitest"
import { DurableWriter, type Service as WriterService } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { type DurableReceipt, Journal, type JournalError, makeNoop } from "@smthrs/journal/Journal"
import { Input, type RunId, type Seq, type SourceId, type SourceSeq } from "@smthrs/journal/JournalEvent"
import type { OwnerId } from "@smthrs/journal/OwnerId"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Deferred, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId
const sourceSeq = (value: number): SourceSeq => value as SourceSeq

const ownerA: OwnerId = { hostId: "host-a", pid: 1, nonce: "nonce-a" }
const ownerB: OwnerId = { hostId: "host-b", pid: 2, nonce: "nonce-b" }

const effect = <E>(name: string, body: () => Effect.Effect<void, E>) =>
  it.effect(name, () => body().pipe(Effect.provide(TestClock.layer())))

const input = (
  run: RunId,
  source: SourceId,
  eventType: string,
  payload: unknown,
  sequence?: SourceSeq
): Input =>
  new Input({
    runId: run,
    sourceId: source,
    ...(sequence === undefined ? {} : { sourceSeq: sequence }),
    eventType,
    payload
  }, { disableChecks: true })

const migratedDatabase = (database: Layer.Layer<DurableWriter | SqlClient.SqlClient> = TestDatabase.layer) =>
  Layer.provideMerge(Migrations.layer, database)

const options: SqlJournal.SqlJournalOptions = { capacity: 8, overflow: "reject" }

const journalLayer = (
  overrides: Partial<SqlJournal.SqlJournalOptions> = {},
  database: Layer.Layer<DurableWriter | SqlClient.SqlClient> = TestDatabase.layer
) => SqlJournal.layer({ ...options, ...overrides }).pipe(Layer.provideMerge(migratedDatabase(database)))

const withJournal = <A, E>(
  body: Effect.Effect<A, E, Journal | DurableWriter | SqlClient.SqlClient>,
  overrides: Partial<SqlJournal.SqlJournalOptions> = {},
  database: Layer.Layer<DurableWriter | SqlClient.SqlClient> = TestDatabase.layer
) => Effect.scoped(body.pipe(Effect.provide(journalLayer(overrides, database))))

/**
 * Lets the first `passthrough` writes commit immediately and parks every later
 * write behind the gate, so tests can hold the queue writer mid-batch.
 */
const gateWrites = (gate: Deferred.Deferred<void>, passthrough = 0): Layer.Layer<DurableWriter | SqlClient.SqlClient> =>
  Layer.provideMerge(
    Layer.effect(
      DurableWriter,
      Effect.gen(function*() {
        const writer = yield* DurableWriter
        let seen = 0
        const write: WriterService["write"] = (writeEffect) =>
          Effect.suspend(() => {
            seen += 1
            return seen <= passthrough
              ? writer.write(writeEffect)
              : Deferred.await(gate).pipe(Effect.andThen(writer.write(writeEffect)))
          })
        return DurableWriter.of({ write })
      })
    ),
    TestDatabase.layer
  )

/** The lease the journal's fence reads, beside the run row that mirrors it. */
const holdLease = (sql: SqlClient.SqlClient, run: RunId, owner: OwnerId) =>
  sql`
    INSERT INTO flows_consensus_leases (
      run_id, owner_host_id, owner_pid, owner_nonce, granted_at_ms, heartbeat_at_ms
    ) VALUES (
      ${run}, ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0, 0
    )
    ON CONFLICT (run_id) DO UPDATE SET
      owner_host_id = excluded.owner_host_id,
      owner_pid = excluded.owner_pid,
      owner_nonce = excluded.owner_nonce,
      granted_at_ms = excluded.granted_at_ms,
      heartbeat_at_ms = excluded.heartbeat_at_ms,
      claim_host_id = NULL,
      claim_pid = NULL,
      claim_nonce = NULL,
      claimed_at_ms = NULL
  `

const activateRun = (sql: SqlClient.SqlClient, run: RunId, owner: OwnerId) =>
  Effect.andThen(
    sql`
      INSERT INTO flows_runs (
        run_id, status, created_at_ms, started_at_ms,
        owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
      ) VALUES (
        ${run}, 'running', 0, 0,
        ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0, '{}'
      )
    `,
    holdLease(sql, run, owner)
  )

const reclaimRun = (sql: SqlClient.SqlClient, run: RunId, owner: OwnerId) =>
  Effect.andThen(
    sql`
      UPDATE flows_runs
      SET owner_host_id = ${owner.hostId},
        owner_pid = ${owner.pid},
        owner_nonce = ${owner.nonce}
      WHERE run_id = ${run}
    `,
    holdLease(sql, run, owner)
  )

const seqsOf = (sql: SqlClient.SqlClient, run: RunId) =>
  Effect.map(
    sql<{ readonly seq: number }>`
      SELECT seq FROM flows_journal_events WHERE run_id = ${run} ORDER BY seq ASC
    `,
    (rows) => rows.map((row) => row.seq)
  )

// A compile-time pin: the lifecycle receipt vocabulary has no "Dropped" arm.
const lifecycleTag = (receipt: DurableReceipt): "Accepted" | "Duplicate" => receipt._tag

describe("SqlJournal ownership fencing", () => {
  effect("a fenced durable emit from the current owner commits", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("fenced")
        yield* activateRun(sql, run, ownerA)
        const receipt = yield* journal.emitDurable(input(run, sourceId("s"), "created", 1), ownerA)
        expect(lifecycleTag(receipt)).toBe("Accepted")
        expect(yield* seqsOf(sql, run)).toEqual([receipt.seq])
      })
    ))

  effect("a reclaimed run fences out the zombie owner's durable writes", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("reclaimed")
        yield* activateRun(sql, run, ownerA)
        yield* journal.emitDurable(input(run, sourceId("a"), "first", 1), ownerA)
        yield* reclaimRun(sql, run, ownerB)
        const failure = yield* Effect.flip(
          journal.emitDurable(input(run, sourceId("a"), "zombie", 2), ownerA)
        )
        expect((failure as JournalError).code).toBe("fence_lost")
        // The fenced-out entry must not reach the durable journal.
        expect(yield* seqsOf(sql, run)).toEqual([0])
        const next = yield* journal.emitDurable(input(run, sourceId("b"), "second", 3), ownerB)
        expect(next._tag).toBe("Accepted")
        expect(yield* seqsOf(sql, run)).toEqual([0, next.seq])
      })
    ))

  effect("emitDurable fences writes when an owner is supplied", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("routed")
        yield* activateRun(sql, run, ownerA)
        const receipt = yield* journal.emitDurable(input(run, sourceId("s"), "created", 1), ownerA)
        // Committed synchronously, without a flush: the fenced path is durable.
        expect(yield* seqsOf(sql, run)).toEqual([receipt.seq])
        yield* reclaimRun(sql, run, ownerB)
        const failure = yield* Effect.flip(journal.emitDurable(input(run, sourceId("s"), "zombie", 2), ownerA))
        expect((failure as JournalError).code).toBe("fence_lost")
        expect(yield* seqsOf(sql, run)).toEqual([receipt.seq])
      })
    ))

  effect("the unfenced durable channel stays first-writer-wins for external-trigger admissions", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("external")
        yield* activateRun(sql, run, ownerA)
        yield* reclaimRun(sql, run, ownerB)
        // Deferred completions and other first-writer-wins admissions carry no
        // owner and must land regardless of who owns the run.
        yield* journal.emitDurableUnfenced(input(run, sourceId("trigger"), "first", 1))
        const durable = yield* journal.emitDurableUnfenced(input(run, sourceId("trigger"), "durable", 2))
        expect(durable._tag).toBe("Accepted")
        expect(yield* seqsOf(sql, run)).toEqual([0, 1])
      })
    ))

  effect("a fenced retry of an already-committed entry reports fence_lost after fence loss", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("retry")
        yield* activateRun(sql, run, ownerA)
        const first = yield* journal.emitDurable(
          input(run, sourceId("s"), "created", 1, sourceSeq(0)),
          ownerA
        )
        // While the fence holds, a retry of the same identity is idempotent.
        const held = yield* journal.emitDurable(
          input(run, sourceId("s"), "created", 1, sourceSeq(0)),
          ownerA
        )
        expect(held).toEqual({ _tag: "Duplicate", seq: first.seq, sourceSeq: 0, status: "committed" })
        yield* reclaimRun(sql, run, ownerB)
        // Once the fence is lost, the fence outranks dedup: the zombie is
        // told it lost the run, never handed a `Duplicate` receipt for work
        // the journal will no longer accept from it.
        const retry = yield* Effect.flip(
          journal.emitDurable(input(run, sourceId("s"), "created", 1, sourceSeq(0)), ownerA)
        )
        expect((retry as JournalError).code).toBe("fence_lost")
        expect(yield* seqsOf(sql, run)).toEqual([first.seq])
      })
    ))
})

describe("SqlJournal lossy and lifecycle channels", () => {
  effect("the lossy channel drops per policy while the lifecycle channel commits", () => {
    const gate = Deferred.makeUnsafe<void>()
    const run = runId("channels")
    const source = sourceId("telemetry")
    return withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* journal.emitLossy(input(run, source, "event", 0))
        yield* Effect.yieldNow
        yield* journal.emitLossy(input(run, source, "event", 1))
        const dropped = yield* journal.emitLossy(input(run, source, "event", 2))
        expect(dropped).toMatchObject({ _tag: "Dropped", seq: 2, policy: "drop-newest" })
        yield* Deferred.succeed(gate, undefined)
        yield* journal.flush
        const durable = yield* journal.emitDurableUnfenced(input(run, sourceId("lifecycle"), "finished", 3))
        expect(lifecycleTag(durable)).toBe("Accepted")
        // The dropped telemetry admission consumed seq 2; the lifecycle entry
        // is allocated after it and always lands.
        expect(yield* seqsOf(sql, run)).toEqual([0, 1, durable.seq])
      }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined))),
      { capacity: 1, overflow: "drop-newest", batchSize: 1 },
      gateWrites(gate)
    )
  })

  effect("the lossy channel backpressures with a typed failure under the reject policy", () => {
    const gate = Deferred.makeUnsafe<void>()
    const run = runId("reject")
    const source = sourceId("telemetry")
    return withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* journal.emitLossy(input(run, source, "event", 0))
        yield* Effect.yieldNow
        yield* journal.emitLossy(input(run, source, "event", 1))
        const failure = yield* Effect.flip(journal.emitLossy(input(run, source, "event", 2)))
        expect((failure as JournalError).code).toBe("queue_overflow")
        yield* Deferred.succeed(gate, undefined)
        yield* journal.flush
      }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined))),
      { capacity: 1, overflow: "reject", batchSize: 1 },
      gateWrites(gate)
    )
  })

  effect("drop-oldest cannot evict a lifecycle entry", () => {
    const gate = Deferred.makeUnsafe<void>()
    const run = runId("evictions")
    const source = sourceId("telemetry")
    return withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        // Lifecycle entries never share the lossy queue: they are already
        // durable before any telemetry eviction can happen.
        const lifecycle = yield* journal.emitDurableUnfenced(input(run, sourceId("lifecycle"), "started", 0))
        yield* journal.emitLossy(input(run, source, "event", 1))
        yield* Effect.yieldNow
        yield* journal.emitLossy(input(run, source, "event", 2))
        const evicting = yield* journal.emitLossy(input(run, source, "event", 3))
        expect(evicting).toMatchObject({
          _tag: "Accepted",
          evicted: { policy: "drop-oldest", count: 1 }
        })
        yield* Deferred.succeed(gate, undefined)
        yield* journal.flush
        const seqs = yield* seqsOf(sql, run)
        expect(seqs).toContain(lifecycle.seq)
        expect(seqs).toEqual([0, 1, 3])
      }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined))),
      { capacity: 1, overflow: "drop-oldest", batchSize: 1 },
      gateWrites(gate, 1)
    )
  })

  effect("emitLossy stays on the optimistic queue", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("sql-lossy")
        const receipt = yield* journal.emitLossy(input(run, sourceId("telemetry"), "event", 0))
        expect(receipt._tag).toBe("Accepted")
        yield* journal.flush
        expect(yield* seqsOf(sql, run)).toEqual([0])
      })
    ))

  it("the lifecycle receipt type cannot represent Dropped", () => {
    const forged = {
      _tag: "Dropped",
      seq: 0 as Seq,
      sourceSeq: sourceSeq(0),
      policy: "drop-newest"
    } as const
    // @ts-expect-error -- Dropped is unrepresentable in the lifecycle receipt.
    const dropped: DurableReceipt = forged
    expect(dropped).toBeDefined()
    expect(lifecycleTag({ _tag: "Duplicate", seq: 0 as Seq, sourceSeq: sourceSeq(0), status: "committed" }))
      .toBe("Duplicate")
  })

  effect("the noop journal reports emitLossy as unavailable", () =>
    Effect.gen(function*() {
      const journal = makeNoop()
      const failure = yield* Effect.flip(journal.emitLossy(input(runId("run"), sourceId("s"), "x", 1)))
      expect((failure as JournalError).code).toBe("journal_closed")
      expect((failure as JournalError).message).toContain("emitLossy")
    }))
})
