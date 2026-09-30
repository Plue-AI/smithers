import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as Statement from "effect/unstable/sql/Statement"
import { vi } from "vitest"
import { Journal } from "../src/Journal.ts"
import { Input, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlJournal from "../src/SqlJournal.ts"
import * as Leases from "./fixtures/leases.ts"

const run = "auto-run" as RunId
const other = "other-run" as RunId
const input = (index: number, runId = run) =>
  new Input({
    runId,
    sourceId: "producer" as SourceId,
    sourceSeq: index as SourceSeq,
    eventType: "event",
    payload: index
  })
const database = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
const journal = (options: Partial<SqlJournal.SqlJournalOptions> = {}) =>
  Layer.provideMerge(SqlJournal.layer({ capacity: 64, batchSize: 1, overflow: "reject", ...options }), database)

const committed = (runId: RunId) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return (yield* sql<{ seq: number }>`SELECT seq FROM flows_journal_events WHERE run_id = ${runId} ORDER BY seq`)
      .map((row) => row.seq)
  })

/** Observes the private barrier map without adding a production diagnostics API. */
const observeBarriers = () => {
  let barriers: Map<unknown, unknown> | undefined
  const counters = new Set<Map<unknown, unknown>>()
  const original = Map.prototype.set
  const spy = vi.spyOn(Map.prototype, "set").mockImplementation(function(this: Map<unknown, unknown>, key, value) {
    if (value && typeof value === "object" && "compactionLock" in value && "maintenance" in value) {
      barriers = this
    }
    if (typeof key === "string" && key.startsWith("completed-") && typeof value === "number") counters.add(this)
    return original.call(this, key, value)
  })
  return {
    size: () => barriers?.size,
    counterSizes: () => [...counters].map((map) => map.size).sort((a, b) => a - b),
    restore: () => spy.mockRestore()
  }
}

describe("automatic compaction maintenance", () => {
  for (const nested of [false, true]) {
    for (const compaction of [false, true]) {
      it.effect(`finishes cancellation cleanup after a durable write (transaction=${nested}, compaction=${compaction})`, () =>
        Effect.gen(function*() {
          let finished = false
          let captures = 0
          yield* Effect.gen(function*() {
            const service = yield* Journal
            const started = yield* Deferred.make<void>()
            const write = service.emitDurableUnfenced(input(0))
            const fiber = yield* Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring((nested ? service.transact(write) : write).pipe(
                Effect.orDie,
                Effect.andThen(Effect.sync(() => {
                  finished = true
                }))
              )),
              Effect.forkChild({ startImmediately: true })
            )
            yield* Deferred.await(started)
            yield* Fiber.interrupt(fiber)
            expect(yield* committed(run)).toEqual([0])
            expect(finished).toBe(true)
            expect(captures).toBe(compaction ? 1 : 0)
          }).pipe(
            Effect.provide(journal(
              compaction ?
                {
                  compaction: {
                    entryThreshold: 1,
                    capture: () =>
                      Effect.sync(() => {
                        captures++
                        return null
                      })
                  }
                } :
                {}
            )),
            Effect.scoped
          )
        }))
    }
  }

  it.effect("keeps post-transaction capture interruptible for an ordinary caller", () =>
    Effect.gen(function*() {
      const reached = yield* Deferred.make<void>()
      yield* Effect.gen(function*() {
        const service = yield* Journal
        const writing = yield* service.transact(service.emitDurableUnfenced(input(0))).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(reached)
        yield* Fiber.interrupt(writing)
        const exit = yield* Fiber.await(writing)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(yield* committed(run)).toEqual([0])
        expect(Option.isNone(yield* service.latestCheckpoint(run))).toBe(true)
      }).pipe(
        Effect.provide(journal({
          compaction: {
            entryThreshold: 1,
            capture: () => Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never))
          }
        })),
        Effect.scoped
      )
    }))

  it.effect("drains a twenty-entry burst across a threshold with one-entry batches", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      for (let index = 0; index < 20; index++) yield* service.emitLossy(input(index))
      yield* service.flush
      expect(Option.getOrThrow(yield* service.latestCheckpoint(run)).compactedAtMs).not.toBeNull()
      expect((yield* committed(run)).at(-1)).toBe(19)
    }).pipe(
      Effect.provide(journal({ compaction: { entryThreshold: 3, capture: () => Effect.succeed(null) } })),
      Effect.scoped
    ))

  it.effect("drains a second batch admitted while capture is gated and flush awaits maintenance", () =>
    Effect.gen(function*() {
      const reached = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.gen(function*() {
        const service = yield* Journal
        yield* service.emitLossy(input(0))
        yield* Deferred.await(reached)
        yield* service.emitLossy(input(1))
        const flushing = yield* service.flush.pipe(Effect.forkChild({ startImmediately: true }))
        for (let index = 0; index < 20; index++) yield* Effect.yieldNow
        expect(flushing.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(flushing)
        expect(yield* committed(run)).toEqual([0, 1])
        expect(Option.getOrThrow(yield* service.latestCheckpoint(run)).compactedAtMs).not.toBeNull()
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.provide(journal({
          compaction: {
            entryThreshold: 1,
            capture: () =>
              Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(null))
          }
        })),
        Effect.scoped
      )
    }))

  it.effect("commits another run's lossy batches while capture is gated", () =>
    Effect.gen(function*() {
      const reached = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.gen(function*() {
        const service = yield* Journal
        for (let index = 0; index < 3; index++) yield* service.emitLossy(input(index))
        yield* Deferred.await(reached)
        yield* service.emitLossy(input(0, other))
        yield* service.emitLossy(input(1, other))
        for (let index = 0; index < 100; index++) {
          if ((yield* committed(other)).length === 2) break
          yield* Effect.yieldNow
        }
        expect(yield* committed(other)).toEqual([0, 1])
        yield* Deferred.succeed(release, undefined)
        yield* service.flush
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.provide(journal({
          compaction: {
            entryThreshold: 3,
            capture: (runId) =>
              runId === run
                ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(null))
                : Effect.succeed(null)
          }
        })),
        Effect.scoped
      )
    }))

  it.effect("retires idle barriers at flush after many distinct runs and safely re-admits a run", () =>
    Effect.gen(function*() {
      const observed = observeBarriers()
      yield* Effect.gen(function*() {
        const service = yield* Journal
        for (let index = 0; index < 100; index++) {
          yield* service.emitDurableUnfenced(input(0, `completed-${index}` as RunId))
        }
        expect(observed.size()).toBe(100)
        yield* service.flush
        expect(observed.size()).toBe(0)
        // Policy counters retire; sequence floors deliberately survive.
        expect(observed.counterSizes()).toEqual([0, 0, 100])
        expect((yield* service.emitDurableUnfenced(input(1, "completed-0" as RunId))).seq).toBe(1)
        yield* service.flush
        expect(observed.size()).toBe(0)
      }).pipe(
        Effect.provide(journal({ compaction: { entryThreshold: 3, capture: () => Effect.succeed(null) } })),
        Effect.scoped,
        Effect.ensuring(Effect.sync(observed.restore))
      )
    }))

  it.effect("does not retire a barrier with a compaction holder and an admission waiter", () =>
    Effect.gen(function*() {
      const observed = observeBarriers()
      const reached = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let armed = false
      const gatedSql = Layer.effect(
        SqlClient.SqlClient,
        Effect.gen(function*() {
          const base = yield* SqlClient.SqlClient
          return new Proxy(base, {
            apply(target, thisArgument, argumentsList) {
              const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
              return armed && statement.compile()[0].includes("FROM flows_journal_checkpoints")
                ? Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(statement)
                )
                : statement
            }
          }) as SqlClient.SqlClient
        })
      )
      yield* Effect.gen(function*() {
        const service = yield* Journal
        const sql = yield* SqlClient.SqlClient
        const owner = { hostId: "compactor", pid: 1, nonce: "owner" }
        yield* Leases.hold(sql, run, owner)
        const receipt = yield* service.emitDurableUnfenced(input(0))
        yield* service.checkpoint({ runId: run, seq: receipt.seq, state: null }, owner)
        // Floor reads now run outside admission, so parking one cannot prove
        // that a compaction owner survives retirement. Compaction holds
        // its gate closed across this checkpoint query inside its transaction.
        armed = true
        const holder = yield* service.compact({ runId: run }, owner).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(reached)
        const waiter = yield* service.emitLossy(input(1)).pipe(Effect.forkChild({ startImmediately: true }))
        yield* service.flush
        expect(observed.size()).toBe(1)
        expect(holder.pollUnsafe()).toBeUndefined()
        expect(waiter.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(waiter)
        yield* Fiber.interrupt(holder)
        armed = false
        yield* service.flush
        expect(observed.size()).toBe(0)
        // Both cancellations released their references and the compaction
        // gate, so the same run admits and persists again.
        expect(yield* service.emitLossy(input(1))).toMatchObject({ _tag: "Accepted", seq: 1 })
        yield* service.flush
        expect(yield* committed(run)).toEqual([0, 1])
      }).pipe(
        Effect.provide(Layer.provideMerge(
          SqlJournal.layer({ capacity: 64, overflow: "reject" }),
          Layer.provideMerge(gatedSql, database)
        )),
        Effect.scoped,
        Effect.ensuring(Effect.sync(observed.restore))
      )
    }))

  it.effect("keeps a live reader's barrier until the reader closes", () =>
    Effect.gen(function*() {
      const observed = observeBarriers()
      yield* Effect.gen(function*() {
        const service = yield* Journal
        yield* service.emitDurableUnfenced(input(0))
        const reading = yield* Deferred.make<void>()
        const follower = yield* service.stream({ runId: run }).pipe(
          Stream.runForEach(() => Deferred.succeed(reading, undefined)),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(reading)
        yield* service.flush
        expect(observed.size()).toBe(1)
        yield* Fiber.interrupt(follower)
        yield* service.flush
        expect(observed.size()).toBe(0)
      }).pipe(Effect.provide(journal()), Effect.scoped, Effect.ensuring(Effect.sync(observed.restore)))
    }))

  it.effect("preserves consumed sequence floors across rollback and idle retirement", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      const implicit = new Input({ runId: run, sourceId: "producer" as SourceId, eventType: "event", payload: null })
      yield* Effect.exit(
        service.transact(service.emitDurableUnfenced(implicit).pipe(Effect.andThen(Effect.fail("rollback"))))
      )
      yield* service.flush
      const receipt = yield* service.emitDurableUnfenced(implicit)
      expect(receipt.seq).toBe(1)
      expect(receipt.sourceSeq).toBe(1)
    }).pipe(Effect.provide(journal()), Effect.scoped))

  it.effect("scope closure waits for registered maintenance before interrupting its scope", () =>
    Effect.gen(function*() {
      const reached = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const captured = yield* Deferred.make<void>()
      const closing = yield* Effect.gen(function*() {
        const service = yield* Journal
        yield* service.emitLossy(input(0))
        yield* Deferred.await(reached)
      }).pipe(
        Effect.provide(journal({
          compaction: {
            entryThreshold: 1,
            capture: () =>
              Deferred.succeed(reached, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Deferred.succeed(captured, undefined)),
                Effect.as(null)
              )
          }
        })),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(reached)
      for (let index = 0; index < 20; index++) yield* Effect.yieldNow
      expect(closing.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(closing)
      expect(yield* Deferred.isDone(captured)).toBe(true)
    }))
})
