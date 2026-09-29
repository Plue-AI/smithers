/**
 * Pins the lock order between lossy admission and the queued batch writer.
 *
 * A queued batch opens the writer transaction and then takes the run permit.
 * A new implicit producer for the same run used to take the run permit and
 * then read its allocation floor from the database, a read that waited on
 * that transaction. The batch waited for the permit, the producer waited for
 * the batch, and every `flush` behind them hung, including the one
 * `DeferredPersistence` awaits before it schedules a durable resume. The
 * floor read now runs before the permit.
 *
 * Compaction follows the same transaction-first order, with an open drain
 * and a second drain check inside SQL before closing its admission gate.
 * The barriers below also park a transaction-owning producer at its floor
 * result (or before preflight) while compaction reaches its SQL request.
 * These cases assert that neither the gate nor the run permit is held there,
 * then join all work, including automatic maintenance from batch settlement.
 * All statements use the production Node SQLite adapter.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter, type Service as WriterService } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, PubSub, Scope, Semaphore } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as Statement from "effect/unstable/sql/Statement"
import { vi } from "vitest"
import { Journal, type Service as JournalService } from "../src/Journal.ts"
import { Input, type RunId, type Seq, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlJournal from "../src/SqlJournal.ts"
import * as Leases from "./fixtures/leases.ts"

const run = "lock-order" as RunId
const first = "first-producer" as SourceId
const second = "second-producer" as SourceId

const implicit = (source: SourceId, eventType: string): Input =>
  new Input({ runId: run, sourceId: source, eventType, payload: { source } }, { disableChecks: true })

const explicit = (source: SourceId, eventType: string, sequence: number): Input =>
  new Input(
    { runId: run, sourceId: source, sourceSeq: sequence as SourceSeq, eventType, payload: { source } },
    { disableChecks: true }
  )

interface Barriers {
  /** Completed inside the armed write, once its transaction is open. */
  readonly batchHasTransaction: Deferred.Deferred<void>
  /** The armed write runs its body only once this completes. */
  readonly resumeBatch: Deferred.Deferred<void>
  /** Completed when `second-producer`'s producer-floor read starts executing. */
  readonly floorReadStarted: Deferred.Deferred<void>
  /** That read reaches the database only once this completes. */
  readonly floorReadGate: Deferred.Deferred<void>
  /** Completed after the producer-floor statement returns real SQLite rows. */
  readonly floorReadFinished: Deferred.Deferred<void>
  /** The statement result reaches allocation only once this completes. */
  readonly floorResultGate: Deferred.Deferred<void>
  /** The next `DurableWriter.write` pauses inside its transaction. */
  readonly armPause: () => void
  readonly writeRequested: Deferred.Deferred<void>
  readonly resumeWriteRequest: Deferred.Deferred<void>
  readonly writeAcquired: Deferred.Deferred<void>
  readonly armRequest: (skip?: number) => void
  readonly checkpointSources: Array<ReadonlyArray<string>>
  readonly observeCheckpoints: () => void
}

interface Seams extends Barriers {
  /** Reads and clears the armed flag; only the seams themselves call it. */
  readonly consumeArm: () => boolean
  readonly consumeRequest: () => boolean
  readonly checkpointsObserved: () => boolean
}

const seams: Effect.Effect<Seams> = Effect.gen(function*() {
  const batchHasTransaction = yield* Deferred.make<void>()
  const resumeBatch = yield* Deferred.make<void>()
  const floorReadStarted = yield* Deferred.make<void>()
  const floorReadGate = yield* Deferred.make<void>()
  const floorReadFinished = yield* Deferred.make<void>()
  const floorResultGate = yield* Deferred.make<void>()
  const writeRequested = yield* Deferred.make<void>()
  const resumeWriteRequest = yield* Deferred.make<void>()
  const writeAcquired = yield* Deferred.make<void>()
  const checkpointSources: Array<ReadonlyArray<string>> = []
  let checkpointsObserved = false
  let requestSkip: number | undefined
  let armed = false
  return {
    checkpointSources,
    observeCheckpoints: () => {
      checkpointsObserved = true
    },
    checkpointsObserved: () => checkpointsObserved,
    writeRequested,
    resumeWriteRequest,
    writeAcquired,
    armRequest: (skip = 0) => {
      requestSkip = skip
    },
    consumeRequest: () => {
      if (requestSkip === undefined) return false
      if (requestSkip-- > 0) return false
      requestSkip = undefined
      return true
    },
    batchHasTransaction,
    resumeBatch,
    floorReadStarted,
    floorReadGate,
    floorReadFinished,
    floorResultGate,
    armPause: () => {
      armed = true
    },
    consumeArm: () => {
      const wasArmed = armed
      armed = false
      return wasArmed
    }
  }
})

/**
 * The production adapter with two observation seams: a writer that can pause
 * one write inside its open transaction, and a client that reports (and can
 * hold) `second-producer`'s floor read. Nothing is mocked to succeed; every
 * statement still reaches SQLite.
 */
const observedDatabase = (seams: Seams): Layer.Layer<DurableWriter | SqlClient.SqlClient> =>
  Layer.provideMerge(
    Layer.effect(
      DurableWriter,
      Effect.gen(function*() {
        const writer = yield* DurableWriter
        const write: WriterService["write"] = (body) =>
          Effect.suspend(() => {
            const requested = seams.consumeRequest()
            const transaction = writer.write(Effect.gen(function*() {
              if (requested) yield* Deferred.succeed(seams.writeAcquired, undefined)
              return yield* Effect.suspend(() => {
                if (!seams.consumeArm()) return body
                // Inside the transaction: the connection stays held while this
                // waits, exactly as a batch mid-commit holds it.
                return Deferred.succeed(seams.batchHasTransaction, undefined).pipe(
                  Effect.andThen(Deferred.await(seams.resumeBatch)),
                  Effect.andThen(body)
                )
              })
            }))
            return requested
              ? Deferred.succeed(seams.writeRequested, undefined).pipe(
                Effect.andThen(Deferred.await(seams.resumeWriteRequest)),
                Effect.andThen(transaction)
              )
              : transaction
          })
        return DurableWriter.of({ write })
      })
    ),
    Layer.provideMerge(
      Layer.effect(
        SqlClient.SqlClient,
        Effect.gen(function*() {
          const base = yield* Effect.service(SqlClient.SqlClient)
          return new Proxy(base, {
            apply(target, thisArgument, argumentsList) {
              const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
              if (typeof statement.compile !== "function") return statement
              const [query, params] = statement.compile()
              if (seams.checkpointsObserved() && query.includes("SELECT run_id, seq, state_json")) {
                return statement.pipe(Effect.tap(() =>
                  committedSources(base).pipe(Effect.tap((sources) =>
                    Effect.sync(() => {
                      seams.checkpointSources.push(sources)
                    })
                  ))
                ))
              }
              return query.includes("MAX(source_seq) + 1") && params.includes(second)
                ? Deferred.succeed(seams.floorReadStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(seams.floorReadGate)),
                  Effect.andThen(statement),
                  Effect.tap(() =>
                    Deferred.succeed(seams.floorReadFinished, undefined)
                  ),
                  Effect.tap(() => Deferred.await(seams.floorResultGate))
                )
                : statement
            }
          }) as SqlClient.SqlClient
        })
      ),
      TestDatabase.layer
    )
  )

const journalLayer = SqlJournal.layer({ capacity: 8, overflow: "reject" })

const committedSources = (sql: SqlClient.SqlClient): Effect.Effect<ReadonlyArray<string>, unknown> =>
  sql<{ readonly source_id: string }>`
    SELECT source_id FROM flows_journal_events WHERE run_id = ${run} ORDER BY seq ASC
  `.pipe(Effect.map((rows) => rows.map((row) => row.source_id)))

const withDatabase = (
  name: string,
  body: (seams: Barriers) => Effect.Effect<void, unknown, DurableWriter | SqlClient.SqlClient | Scope.Scope>
) =>
  it.effect(name, () =>
    Effect.scoped(Effect.gen(function*() {
      const built = yield* seams
      yield* body(built).pipe(
        Effect.provide(Layer.provideMerge(Migrations.layer, observedDatabase(built)))
      )
    })).pipe(Effect.provide(TestClock.layer())))

const withJournal = (
  name: string,
  body: (seams: Barriers, journal: JournalService, sql: SqlClient.SqlClient) => Effect.Effect<void, unknown>
) =>
  withDatabase(name, (seams) =>
    Effect.gen(function*() {
      const journal = yield* Journal
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* body(seams, journal, sql)
    }).pipe(Effect.provide(journalLayer)))

/** Queues `first-producer` and holds its batch open inside the writer transaction. */
const holdBatchInTransaction = (seams: Barriers, journal: JournalService) =>
  Effect.gen(function*() {
    seams.armPause()
    yield* journal.emitLossy(implicit(first, "review"))
    yield* Deferred.await(seams.batchHasTransaction)
  })

const owner = { hostId: "compactor", pid: 1, nonce: "owner" }

const seedCheckpoint = (journal: JournalService, sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    yield* Leases.hold(sql, run, owner)
    const receipt = yield* journal.emitDurableUnfenced(implicit(first, "initial"))
    yield* journal.checkpoint({ runId: run, seq: receipt.seq, state: null }, owner)
  })

/** Observe the real semaphore and gate, without adding a production test API. */
const observeRunBarrier = () => {
  let barrier: { readonly semaphore: Semaphore.Semaphore; compaction: Deferred.Deferred<void> | undefined } | undefined
  const original = Map.prototype.set
  const spy = vi.spyOn(Map.prototype, "set").mockImplementation(function(this: Map<unknown, unknown>, key, value) {
    if (key === run && value && typeof value === "object" && "compactionLock" in value) barrier = value
    return original.call(this, key, value)
  })
  return {
    // Called exactly at the compactor's writer request, after its first drain.
    assertSqlWaitIsUnowned: Effect.gen(function*() {
      expect(barrier).toBeDefined()
      const available = yield* barrier!.semaphore.takeIfAvailable(1)
      if (available) yield* barrier!.semaphore.release(1)
      expect({ gateClosed: barrier!.compaction !== undefined, permitAvailable: available })
        .toEqual({ gateClosed: false, permitAvailable: true })
    }),
    restore: () => spy.mockRestore()
  }
}

describe("SqlJournal lock order", () => {
  for (const enclosing of ["managed", "raw SQL"] as const) {
    for (const channel of ["durable", "queued lossy"] as const) {
      withJournal(
        `${enclosing} nested compaction completes with ${channel} waiting for SQL`,
        (seams, journal, sql) =>
          Effect.gen(function*() {
            yield* seedCheckpoint(journal, sql)
            const transactionOwned = yield* Deferred.make<void>()
            const resumeCompaction = yield* Deferred.make<void>()
            const drainedWhileOwningSql = yield* Deferred.make<void>()
            const original = Map.prototype.set
            // No readers exist. A per-run Set registered here is the actual
            // compaction drain waiter, not a wall-clock guess about progress.
            const spy = vi.spyOn(Map.prototype, "set").mockImplementation(
              function(this: Map<unknown, unknown>, key, value) {
                if (key === run && value instanceof Set && [...value].some(Deferred.isDeferred)) {
                  Deferred.doneUnsafe(drainedWhileOwningSql, Effect.void)
                }
                return original.call(this, key, value)
              }
            )
            yield* Effect.gen(function*() {
              const body = Deferred.succeed(transactionOwned, undefined).pipe(
                Effect.andThen(Deferred.await(resumeCompaction)),
                Effect.andThen(journal.compact({ runId: run }, owner))
              )
              const compactor = yield* (enclosing === "managed" ? journal.transact(body) : sql.withTransaction(body))
                .pipe(Effect.forkChild({ startImmediately: true }))
              yield* Deferred.await(transactionOwned)
              seams.armRequest()
              yield* Deferred.succeed(seams.resumeWriteRequest, undefined)
              const event = explicit(second, "waiting", 0)
              const producer =
                yield* (channel === "durable" ? journal.emitDurableUnfenced(event) : journal.emitLossy(event))
                  .pipe(Effect.forkChild({ startImmediately: true }))
              yield* Effect.gen(function*() {
                yield* Deferred.await(seams.writeRequested)
                expect(yield* Deferred.isDone(seams.writeAcquired)).toBe(false)
                yield* Deferred.succeed(resumeCompaction, undefined)
                const result = yield* Effect.raceFirst(
                  Fiber.join(compactor),
                  Deferred.await(drainedWhileOwningSql).pipe(Effect.as("waited for SQL-dependent work"))
                )
                expect(result).toEqual({ runId: run, checkpointSeq: 0, deleted: 0 })
                expect(yield* Fiber.join(producer)).toMatchObject({ _tag: "Accepted", sourceSeq: 0 })
                yield* journal.flush
                const replay = yield* journal.entries({ runId: run, after: 0 as Seq, limit: 8 })
                expect(replay.entries.map(({ seq, sourceId }) => ({ seq, sourceId }))).toEqual([{
                  seq: 1,
                  sourceId: second
                }])
                expect(yield* journal.emitDurableUnfenced(event)).toMatchObject({
                  _tag: "Duplicate",
                  seq: 1,
                  sourceSeq: 0
                })
                expect((yield* Effect.flip(journal.emitDurableUnfenced(explicit(second, "conflict", 0)))).code)
                  .toBe("idempotency_conflict")
              }).pipe(Effect.ensuring(Fiber.interrupt(compactor).pipe(Effect.andThen(Fiber.interrupt(producer)))))
            }).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())))
          })
      )
    }
  }

  for (const enclosing of ["managed", "raw SQL"] as const) {
    for (const outcome of ["commit", "rollback", "cancel"] as const) {
      withDatabase(
        `${enclosing} nested compaction preserves older lossy reservations across ${outcome}`,
        (seams) =>
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            const events = [explicit(second, "older", 0), explicit(second, "still queued", 1)]
            yield* Effect.gen(function*() {
              const journal = yield* Journal
              yield* seedCheckpoint(journal, sql)
              const changes = yield* journal.changes
              const transactionOwned = yield* Deferred.make<void>()
              const resumeCompaction = yield* Deferred.make<void>()
              const compacted = yield* Deferred.make<void>()
              const finish = yield* Deferred.make<void>()
              const body = Effect.gen(function*() {
                yield* Deferred.succeed(transactionOwned, undefined)
                yield* Deferred.await(resumeCompaction)
                const newer = yield* journal.emitDurableUnfenced(explicit(first, "new checkpoint", 1))
                expect(newer.seq).toBe(3)
                yield* journal.checkpoint({ runId: run, seq: newer.seq, state: null }, owner)
                expect(yield* journal.compact({ runId: run }, owner)).toEqual({
                  runId: run,
                  checkpointSeq: 3,
                  deleted: 1
                })
                // Both the batch already taken from the queue and the entry
                // still queued must be persisted by this transaction.
                expect(yield* committedSources(sql)).toEqual([first, second, second])
                expect((yield* journal.entries({ runId: run, after: 3 as Seq, limit: 8 })).entries.map((e) => e.seq))
                  .toEqual([4, 5])
                // Repeating within this transaction sees duplicates and neither
                // inserts nor publishes the accepted identities twice.
                expect((yield* journal.compact({ runId: run }, owner)).deleted).toBe(0)
                yield* Deferred.succeed(compacted, undefined)
                yield* Deferred.await(finish)
                if (outcome === "rollback") return yield* Effect.fail("rollback outer transaction")
              })
              const compactor = yield* (enclosing === "managed" ? journal.transact(body) : sql.withTransaction(body))
                .pipe(Effect.forkChild({ startImmediately: true }))
              yield* Deferred.await(transactionOwned)
              seams.armRequest()
              yield* Deferred.succeed(seams.resumeWriteRequest, undefined)
              yield* Effect.gen(function*() {
                expect(yield* journal.emitLossy(events[0]!)).toMatchObject({ _tag: "Accepted", seq: 1 })
                yield* Deferred.await(seams.writeRequested)
                expect(yield* Deferred.isDone(seams.writeAcquired)).toBe(false)
                expect(yield* journal.emitLossy(events[1]!)).toMatchObject({ _tag: "Accepted", seq: 2 })
                yield* Deferred.succeed(resumeCompaction, undefined)
                yield* Deferred.await(compacted)
                expect(yield* PubSub.remaining(changes)).toBe(0)
                expect(yield* journal.emitLossy(events[0]!)).toMatchObject({
                  _tag: "Duplicate",
                  status: "pending",
                  seq: 1
                })
                const flushing = yield* journal.flush.pipe(Effect.forkChild({ startImmediately: true }))
                expect(flushing.pollUnsafe()).toBeUndefined()
                if (outcome === "cancel") {
                  yield* Fiber.interrupt(compactor)
                  const exit = yield* Fiber.await(compactor)
                  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
                } else {
                  yield* Deferred.succeed(finish, undefined)
                  const exit = yield* Fiber.await(compactor)
                  expect(Exit.isSuccess(exit)).toBe(outcome === "commit")
                }
                yield* Fiber.join(flushing)
                const published = yield* PubSub.takeUpTo(changes, 8)
                expect(published.map((e) => e.seq)).toEqual(
                  outcome === "commit" ? (enclosing === "managed" ? [3, 4, 5] : []) : [1, 2]
                )
                const checkpoints = yield* sql<{ seq: number; compacted_at_ms: number | null }>`
                SELECT seq, compacted_at_ms FROM flows_journal_checkpoints WHERE run_id = ${run}
              `
                expect(checkpoints).toHaveLength(1)
                expect(checkpoints[0]!.seq).toBe(outcome === "commit" ? 3 : 0)
                expect(checkpoints[0]!.compacted_at_ms === null).toBe(outcome !== "commit")
                if (outcome !== "commit") {
                  expect((yield* journal.compact({ runId: run }, owner)).checkpointSeq).toBe(0)
                }
              }).pipe(Effect.ensuring(Fiber.interrupt(compactor)))
            }).pipe(Effect.provide(journalLayer))
            // Cold cache: prove durable replay and database identity/content
            // checks, independent of the original instance's pending index.
            yield* Effect.gen(function*() {
              const reopened = yield* Journal
              const seqs = outcome === "commit" ? [4, 5] : [1, 2]
              const replay = yield* reopened.entries({
                runId: run,
                after: (outcome === "commit" ? 3 : 0) as Seq,
                limit: 8
              })
              expect(replay.entries.map(({ seq, sourceSeq, eventType }) => ({ seq, sourceSeq, eventType }))).toEqual([
                { seq: seqs[0], sourceSeq: 0, eventType: "older" },
                { seq: seqs[1], sourceSeq: 1, eventType: "still queued" }
              ])
              for (const [index, event] of events.entries()) {
                expect(yield* reopened.emitDurableUnfenced(event)).toMatchObject({
                  _tag: "Duplicate",
                  seq: seqs[index]
                })
              }
              expect((yield* Effect.flip(reopened.emitDurableUnfenced(explicit(second, "conflict", 0)))).code)
                .toBe("idempotency_conflict")
            }).pipe(Effect.provide(journalLayer))
          })
      )
    }
  }

  withJournal(
    "top-level compaction races both an active durable writer and queued lossy work",
    (seams, journal, sql) =>
      Effect.gen(function*() {
        yield* seedCheckpoint(journal, sql)
        yield* Deferred.succeed(seams.floorReadGate, undefined)
        const durable = yield* journal.emitDurableUnfenced(implicit(second, "durable"))
          .pipe(Effect.forkChild({ startImmediately: true }))
        // The floor read has returned inside SQL. Keep that writer registered
        // while the batch requests SQL and compaction starts its top-level drain.
        yield* Deferred.await(seams.floorReadFinished)
        seams.armRequest()
        yield* Deferred.succeed(seams.resumeWriteRequest, undefined)
        const lossy = explicit(first, "queued", 1)
        expect(yield* journal.emitLossy(lossy)).toMatchObject({ _tag: "Accepted", seq: 1 })
        yield* Deferred.await(seams.writeRequested)
        expect(yield* Deferred.isDone(seams.writeAcquired)).toBe(false)
        const compactor = yield* journal.compact({ runId: run }, owner).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        expect(compactor.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(seams.floorResultGate, undefined)
        expect(yield* Fiber.join(durable)).toMatchObject({ _tag: "Accepted", seq: 2 })
        expect(yield* Fiber.join(compactor)).toEqual({ runId: run, checkpointSeq: 0, deleted: 0 })
        yield* journal.flush
        expect(
          (yield* journal.entries({ runId: run, after: 0 as Seq, limit: 8 })).entries.map((e) => ({
            seq: e.seq,
            eventType: e.eventType
          }))
        )
          .toEqual([{ seq: 2, eventType: "durable" }, { seq: 3, eventType: "queued" }])
        expect(yield* journal.emitDurableUnfenced(lossy)).toMatchObject({ _tag: "Duplicate", seq: 3 })
      })
  )

  it.effect(
    "finishing a nested durable write does not drain its still-active outer write",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const base = yield* SqlClient.SqlClient
        const writer = yield* DurableWriter
        const innerFinished = yield* Deferred.make<void>()
        const resumeOuter = yield* Deferred.make<void>()
        let journal: JournalService
        // Reenter the journal sequentially from a real SQL adapter callback.
        // The inner savepoint completes before the outer write continues, so
        // they share SQL without parallel use of the connection/savepoint stack.
        const sql = new Proxy(base, {
          apply(target, thisArgument, argumentsList) {
            const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
            const [query, params] = statement.compile()
            return query.includes("MAX(source_seq) + 1") && params.includes(second)
              ? statement.pipe(Effect.tap(() =>
                Effect.gen(function*() {
                  expect(yield* journal.emitDurableUnfenced(explicit(first, "inner", 1)))
                    .toMatchObject({ _tag: "Accepted", seq: 1 })
                  yield* Deferred.succeed(innerFinished, undefined)
                  yield* Deferred.await(resumeOuter)
                })
              ))
              : statement
          }
        }) as SqlClient.SqlClient
        journal = Context.get(
          yield* Layer.build(journalLayer.pipe(Layer.provide(Layer.merge(
            Layer.succeed(SqlClient.SqlClient)(sql),
            Layer.succeed(DurableWriter)(writer)
          )))),
          Journal
        )
        yield* seedCheckpoint(journal, sql)
        const outer = yield* journal.emitDurableUnfenced(implicit(second, "outer"))
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.raceFirst(
          Deferred.await(innerFinished),
          Fiber.join(outer).pipe(
            Effect.andThen(Effect.die("outer write bypassed the nested-write barrier"))
          )
        )
        // If the inner completion incorrectly removed the outer reference, a
        // compactor would request SQL instead of registering its open drain.
        const drainRegistered = yield* Deferred.make<void>()
        const original = Map.prototype.set
        const spy = vi.spyOn(Map.prototype, "set").mockImplementation(
          function(this: Map<unknown, unknown>, key, value) {
            if (key === run && value instanceof Set && [...value].some(Deferred.isDeferred)) {
              Deferred.doneUnsafe(drainRegistered, Effect.void)
            }
            return original.call(this, key, value)
          }
        )
        yield* Effect.gen(function*() {
          const compacting = yield* journal.compact({ runId: run }, owner).pipe(
            Effect.forkChild({ startImmediately: true })
          )
          yield* Deferred.await(drainRegistered)
          expect(compacting.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(resumeOuter, undefined)
          expect(yield* Fiber.join(outer)).toMatchObject({ _tag: "Accepted", seq: 2 })
          expect((yield* Fiber.join(compacting)).checkpointSeq).toBe(0)
          expect((yield* journal.entries({ runId: run, after: 0 as Seq, limit: 8 })).entries.map((e) => e.eventType))
            .toEqual(["inner", "outer"])
          expect(yield* journal.emitDurableUnfenced(explicit(first, "inner", 1)))
            .toMatchObject({ _tag: "Duplicate", seq: 1 })
        }).pipe(Effect.ensuring(Fiber.interrupt(outer)), Effect.ensuring(Effect.sync(() => spy.mockRestore())))
      })).pipe(Effect.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))
  )

  withJournal(
    "an in-transaction floor read resumes after compaction has drained",
    (seams, journal, sql) =>
      Effect.gen(function*() {
        const observed = observeRunBarrier()
        yield* Effect.gen(function*() {
          yield* seedCheckpoint(journal, sql)
          yield* Deferred.succeed(seams.floorReadGate, undefined)
          const producer = yield* journal.transact(journal.emitLossy(implicit(second, "review")))
            .pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(seams.floorReadFinished)
          seams.observeCheckpoints()
          seams.armRequest()
          const compactor = yield* journal.compact({ runId: run }, owner)
            .pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.gen(function*() {
            yield* Deferred.await(seams.writeRequested)
            yield* observed.assertSqlWaitIsUnowned
            yield* Deferred.succeed(seams.resumeWriteRequest, undefined)
            // Compaction is now requesting the connection the producer owns.
            expect(compactor.pollUnsafe()).toBeUndefined()
            yield* Deferred.succeed(seams.floorResultGate, undefined)
            expect(yield* Fiber.join(producer)).toMatchObject({ _tag: "Accepted", seq: 1, sourceSeq: 0 })
            expect(yield* Fiber.join(compactor)).toEqual({ runId: run, checkpointSeq: 0, deleted: 0 })
            yield* journal.flush
            expect(yield* committedSources(sql)).toEqual([first, second])
            // A producer admitted after the initial drain. Compaction must
            // release SQL and let that batch commit before reading its checkpoint.
            expect(seams.checkpointSources).toEqual([[first, second]])
          }).pipe(Effect.ensuring(
            // Also makes the pre-fix invariant failure deterministic: release SQL
            // before interrupting the compactor that was waiting for it.
            Fiber.interrupt(producer).pipe(Effect.andThen(Fiber.interrupt(compactor)))
          ))
        }).pipe(Effect.ensuring(Effect.sync(observed.restore)))
      })
  )

  for (const channel of ["implicit lossy", "explicit lossy", "durable"] as const) {
    withJournal(
      `a transaction owner admits ${channel} after compaction requests SQL`,
      (seams, journal, sql) =>
        Effect.gen(function*() {
          const observed = observeRunBarrier()
          yield* Effect.gen(function*() {
            yield* seedCheckpoint(journal, sql)
            yield* releaseFloorRead(seams)
            const transactionOwned = yield* Deferred.make<void>()
            const resumeProducer = yield* Deferred.make<void>()
            const emit = channel === "durable"
              ? journal.emitDurableUnfenced(implicit(second, "review"))
              : journal.emitLossy(
                channel === "explicit lossy" ? explicit(second, "review", 0) : implicit(second, "review")
              )
            const producer = yield* journal.transact(
              Deferred.succeed(transactionOwned, undefined).pipe(
                Effect.andThen(Deferred.await(resumeProducer)),
                Effect.andThen(emit)
              )
            ).pipe(Effect.forkChild({ startImmediately: true }))
            yield* Deferred.await(transactionOwned)
            seams.armRequest()
            const compactor = yield* journal.compact({ runId: run }, owner)
              .pipe(Effect.forkChild({ startImmediately: true }))
            yield* Effect.gen(function*() {
              yield* Deferred.await(seams.writeRequested)
              yield* observed.assertSqlWaitIsUnowned
              yield* Deferred.succeed(seams.resumeWriteRequest, undefined)
              expect(compactor.pollUnsafe()).toBeUndefined()
              // In the old order compaction already held the run permit and
              // closed gate at this point, even before the producer's preflight.
              yield* Deferred.succeed(resumeProducer, undefined)
              expect(yield* Fiber.join(producer)).toMatchObject({ _tag: "Accepted", seq: 1 })
              yield* Fiber.join(compactor)
              yield* journal.flush
              expect(yield* committedSources(sql)).toEqual([first, second])
              if (channel === "explicit lossy") expect(yield* Deferred.isDone(seams.floorReadStarted)).toBe(false)
            }).pipe(Effect.ensuring(Fiber.interrupt(producer).pipe(Effect.andThen(Fiber.interrupt(compactor)))))
          }).pipe(Effect.ensuring(Effect.sync(observed.restore)))
        })
    )
  }

  withJournal(
    "cancelling an in-transaction producer releases SQL for compaction and subsequent admission",
    (seams, journal, sql) =>
      Effect.gen(function*() {
        yield* seedCheckpoint(journal, sql)
        yield* Deferred.succeed(seams.floorReadGate, undefined)
        const producer = yield* journal.transact(journal.emitLossy(implicit(second, "review")))
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(seams.floorReadFinished)
        seams.armRequest()
        const compactor = yield* journal.compact({ runId: run }, owner)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(seams.writeRequested)
        yield* Deferred.succeed(seams.resumeWriteRequest, undefined)
        expect(compactor.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(producer)
        const exit = yield* Fiber.await(producer)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(yield* Fiber.join(compactor)).toEqual({ runId: run, checkpointSeq: 0, deleted: 0 })
        yield* journal.flush
        expect(yield* committedSources(sql)).toEqual([first])
        yield* Deferred.succeed(seams.floorResultGate, undefined)
        expect(yield* journal.emitLossy(implicit(second, "review"))).toMatchObject({
          _tag: "Accepted",
          seq: 1,
          sourceSeq: 0
        })
        yield* journal.flush
        expect(yield* committedSources(sql)).toEqual([first, second])
      })
  )

  withDatabase(
    "batch-settlement automatic compaction lets an unrelated transaction admit and commit",
    (seams) =>
      Effect.gen(function*() {
        const captureReached = yield* Deferred.make<void>()
        const resumeCapture = yield* Deferred.make<void>()
        yield* Effect.gen(function*() {
          const journal = yield* Journal
          const sql = yield* Effect.service(SqlClient.SqlClient)
          // This is the background compactor forked by the queue consumer.
          yield* journal.emitLossy(implicit(first, "initial"))
          yield* Deferred.await(captureReached)
          // Let automatic checkpoint creation finish, but stop the following
          // compaction after its first drain and before it requests SQL.
          seams.armRequest(1)
          yield* Deferred.succeed(resumeCapture, undefined)
          yield* Deferred.await(seams.writeRequested)
          yield* Deferred.succeed(seams.floorReadGate, undefined)
          const producer = yield* journal.transact(journal.emitLossy(implicit(second, "wake")))
            .pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(seams.floorReadFinished)
          yield* Deferred.succeed(seams.resumeWriteRequest, undefined)
          const flushing = yield* journal.flush.pipe(Effect.forkChild({ startImmediately: true }))
          expect(flushing.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(seams.floorResultGate, undefined)
          expect(yield* Fiber.join(producer)).toMatchObject({ _tag: "Accepted", seq: 1 })
          yield* Fiber.join(flushing)
          const checkpoints = yield* sql<{ compacted_at_ms: number | null }>`
          SELECT compacted_at_ms FROM flows_journal_checkpoints WHERE run_id = ${run}
        `
          expect(checkpoints).toHaveLength(1)
          expect(checkpoints[0]!.compacted_at_ms).not.toBeNull()
          // Settlement may trigger a second policy attempt at the new tail.
          // Every identity must survive, either in replay or retained dedup.
          const identities = yield* sql<{ source_id: string }>`
            SELECT source_id, seq FROM flows_journal_events WHERE run_id = ${run}
            UNION ALL
            SELECT source_id, seq FROM flows_journal_dedup WHERE run_id = ${run}
            ORDER BY seq
          `
          expect(identities.map((row) => row.source_id)).toEqual([first, second])
          expect((yield* committedSources(sql)).at(-1)).toBe(second)
        }).pipe(Effect.provide(SqlJournal.layer({
          capacity: 8,
          batchSize: 1,
          overflow: "reject",
          compaction: {
            entryThreshold: 1,
            capture: () =>
              Deferred.succeed(captureReached, undefined).pipe(
                Effect.andThen(Deferred.await(resumeCapture)),
                Effect.as(null)
              )
          }
        })))
      })
  )

  // The floor read is not gated in these cases: it must reach the database
  // and wait there, on the connection the paused batch holds.
  const releaseFloorRead = (seams: Barriers) =>
    Deferred.succeed(seams.floorReadGate, undefined).pipe(
      Effect.andThen(Deferred.succeed(seams.floorResultGate, undefined))
    )

  withJournal(
    "a batch inside its transaction never waits on a new producer's floor read",
    (seams, journal, sql) =>
      Effect.gen(function*() {
        yield* releaseFloorRead(seams)
        yield* holdBatchInTransaction(seams, journal)
        const admission = yield* Effect.forkChild(journal.emitLossy(implicit(second, "review")), {
          startImmediately: true
        })
        yield* Deferred.await(seams.floorReadStarted)
        // The batch holds the transaction and the producer is at its floor
        // read. The producer holds no run permit, so the batch takes it the
        // moment it resumes; under the old order this join never returned.
        yield* Deferred.succeed(seams.resumeBatch, undefined)
        const receipt = yield* Fiber.join(admission)
        expect(receipt._tag).toBe("Accepted")
        yield* journal.flush
        expect(yield* committedSources(sql)).toEqual([first, second])
      })
  )

  withJournal(
    "interrupting the producer at its floor read loses nothing and leaves the queue live",
    (seams, journal, sql) =>
      Effect.gen(function*() {
        yield* releaseFloorRead(seams)
        yield* holdBatchInTransaction(seams, journal)
        const admission = yield* Effect.forkChild(journal.emitLossy(implicit(second, "review")), {
          startImmediately: true
        })
        yield* Deferred.await(seams.floorReadStarted)
        yield* Fiber.interrupt(admission)
        const exit = yield* Fiber.await(admission)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        // The cancelled admission held no permit and queued nothing: the batch
        // commits untouched, and flush reports exactly that.
        yield* Deferred.succeed(seams.resumeBatch, undefined)
        yield* journal.flush
        expect(yield* committedSources(sql)).toEqual([first])
        // The same producer admits afterwards, so no permit or queue slot leaked.
        const retried = yield* journal.emitLossy(implicit(second, "review"))
        expect(retried._tag).toBe("Accepted")
        yield* journal.flush
        expect(yield* committedSources(sql)).toEqual([first, second])
      })
  )

  withDatabase(
    "flush and scope close complete with a new producer's admission pending",
    (seams) =>
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        // The journal gets its own scope so it can close while the database,
        // and the pending admission, outlive it.
        const scope = yield* Scope.make()
        const journal = yield* Layer.build(journalLayer).pipe(
          Effect.map((context) => Context.get(context, Journal)),
          Scope.provide(scope)
        )
        yield* holdBatchInTransaction(seams, journal)
        const admission = yield* Effect.forkChild(Effect.flip(journal.emitLossy(implicit(second, "review"))), {
          startImmediately: true
        })
        yield* Deferred.await(seams.floorReadStarted)
        // The producer is parked at its floor read holding no permit. Flush
        // owes it nothing, because it has not been queued, and drains the
        // first producer's batch.
        const flushing = yield* Effect.forkChild(journal.flush, { startImmediately: true })
        // Scope close runs the finalizer's flush while both the batch and
        // admission are pending. Only the accepted batch is owed.
        const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void), { startImmediately: true })
        yield* Deferred.succeed(seams.resumeBatch, undefined)
        yield* Fiber.join(flushing)
        yield* Fiber.join(closing)
        expect(yield* committedSources(sql)).toEqual([first])
        // The read now returns to a closed journal. The admission re-checks the
        // status under the permit, in the same step as the offer, so it is
        // refused as closed rather than offered to a shut-down queue and
        // misreported as an overflow.
        yield* releaseFloorRead(seams)
        const failure = yield* Fiber.join(admission)
        expect(failure.code).toBe("journal_closed")
        expect(yield* committedSources(sql)).toEqual([first])
      })
  )

  withJournal(
    "an emit-then-flush wake completes while a batch is mid-transaction",
    (seams, journal, sql) =>
      Effect.gen(function*() {
        yield* releaseFloorRead(seams)
        yield* holdBatchInTransaction(seams, journal)
        // What `DeferredPersistence` does after recording a completion: emit
        // the lossy record, await `flush`, and only then schedule the resume.
        // The join returns what that flush proved durable at the moment the
        // resume would have been scheduled.
        const wake = yield* Effect.forkChild(
          journal.emitLossy(implicit(second, "deferred.completed")).pipe(
            Effect.andThen(journal.flush),
            Effect.andThen(committedSources(sql))
          ),
          { startImmediately: true }
        )
        yield* Deferred.await(seams.floorReadStarted)
        yield* Deferred.succeed(seams.resumeBatch, undefined)
        expect(yield* Fiber.join(wake)).toEqual([first, second])
      })
  )

  withJournal(
    "a stale floor is revalidated after durable allocation and quiescent run retirement",
    (seams, journal, sql) =>
      Effect.gen(function*() {
        yield* journal.emitDurableUnfenced(implicit(first, "initial"))
        yield* Deferred.succeed(seams.floorReadGate, undefined)
        const admission = yield* Effect.forkChild(journal.emitLossy(implicit(second, "later")), {
          startImmediately: true
        })
        // SQLite has already returned source floor 0 and the run floor was 1.
        // Keep both stale while a durable write takes those exact sequences.
        yield* Deferred.await(seams.floorReadFinished)
        const durable = yield* journal.emitDurableUnfenced(explicit(second, "earlier", 0))
        expect(durable).toMatchObject({ _tag: "Accepted", seq: 1, sourceSeq: 0 })
        // With no queued entries or active durable writers, flush retires the
        // run barrier. Allocation floors must survive that retirement.
        yield* journal.flush
        yield* Deferred.succeed(seams.floorResultGate, undefined)
        expect(yield* Fiber.join(admission)).toMatchObject({ _tag: "Accepted", seq: 2, sourceSeq: 1 })
        yield* journal.flush
        expect(yield* committedSources(sql)).toEqual([first, second, second])
        const page = yield* journal.entries({ runId: run, limit: 8 })
        expect(page.entries.map(({ seq, sourceSeq, eventType }) => ({ seq, sourceSeq, eventType }))).toEqual([
          { seq: 0, sourceSeq: 0, eventType: "initial" },
          { seq: 1, sourceSeq: 0, eventType: "earlier" },
          { seq: 2, sourceSeq: 1, eventType: "later" }
        ])
      })
  )

  withJournal("an explicit producer sequence admits without a read while the batch holds the transaction", (
    seams,
    journal,
    sql
  ) =>
    Effect.gen(function*() {
      yield* holdBatchInTransaction(seams, journal)
      // Not forked: the readless path must finish while the batch still owns
      // the connection, because it never touches the database.
      const receipt = yield* journal.emitLossy(explicit(second, "review", 0))
      expect(receipt._tag).toBe("Accepted")
      expect(yield* Deferred.isDone(seams.floorReadStarted)).toBe(false)
      yield* Deferred.succeed(seams.resumeBatch, undefined)
      yield* journal.flush
      expect(yield* committedSources(sql)).toEqual([first, second])
    }))
})
