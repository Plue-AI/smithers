/**
 * Pins the checkpoint-and-compaction invariants:
 *
 * - a checkpoint durably captures the state that replays a run from a journal
 *   offset, in the same transactional discipline as `Journal.transact`;
 * - compaction truncates strictly below a checkpoint, atomically with the
 *   floor advance, and only when provably safe — no live in-process stream
 *   behind the boundary, the ownership fence respected;
 * - a reader behind the floor gets a typed `compacted` error carrying the
 *   resync point, never a silently shortened history;
 * - a crash injected mid-compaction leaves the store exactly as it was.
 *
 * Prior art: Temporal, whose mutable state is a durable snapshot pinned to a
 * history offset and whose readers of trimmed history fail with `DataLoss` /
 * `CurrentBranchChanged` rather than observing gaps
 * (`reference/temporal/common/persistence/history_manager.go`).
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as Statement from "effect/unstable/sql/Statement"
import { vi } from "vitest"
import { Journal, JournalError, type Service } from "../src/Journal.ts"
import { type Entry, Input, type RunId, type Seq, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/OwnerId.ts"
import * as SqlJournal from "../src/SqlJournal.ts"
import * as Leases from "./fixtures/leases.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId
const seqOf = (value: number): Seq => value as Seq

const run = runId("run")
const source = sourceId("producer")

const owner: OwnerId = { hostId: "host-a", pid: 42, nonce: "nonce-a" }

/** Claims `run` for `holder` — or reclaims it, when the run is already claimed. */
const claim = (holder: OwnerId) =>
  Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) => Leases.hold(sql, run, holder))

const input = (sequence: number): Input =>
  new Input({
    runId: run,
    sourceId: source,
    sourceSeq: sequence as SourceSeq,
    eventType: "event",
    payload: { value: sequence }
  }, { disableChecks: true })

const effect = <E>(
  name: string,
  body: () => Effect.Effect<void, E, DurableWriter | SqlClient.SqlClient>
) =>
  it.effect(name, () =>
    body().pipe(
      Effect.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer)),
      Effect.provide(TestClock.layer())
    ))

/** A database decorator: reshapes the enclosing client/writer pair in place. */
type DatabaseDecorator = Layer.Layer<
  DurableWriter | SqlClient.SqlClient,
  never,
  DurableWriter | SqlClient.SqlClient
>

const keepWriter: Layer.Layer<DurableWriter, never, DurableWriter> = Layer.effect(
  DurableWriter,
  Effect.service(DurableWriter)
)

class CrashInjected extends Error {
  override readonly name = "CrashInjected"
}

/** Dies right after any statement whose SQL contains `marker` executes. */
const crashingDatabase = (marker: string, shouldCrash: () => boolean): DatabaseDecorator =>
  Layer.merge(
    Layer.effect(
      SqlClient.SqlClient,
      Effect.gen(function*() {
        const base = yield* Effect.service(SqlClient.SqlClient)
        return new Proxy(base, {
          apply(target, thisArgument, argumentsList) {
            const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
            if (typeof statement.compile !== "function" || !statement.compile()[0].includes(marker)) {
              return statement
            }
            return statement.pipe(
              Effect.tap(() =>
                shouldCrash() ? Effect.die(new CrashInjected(`crash injected after ${marker}`)) : Effect.void
              )
            )
          }
        }) as SqlClient.SqlClient
      })
    ),
    keepWriter
  )

/** Replaces the rows of any statement whose compiled SQL satisfies `matches`. */
const stubbedRows = (
  matches: (sqlText: string) => boolean,
  rows: () => ReadonlyArray<unknown> | undefined
): DatabaseDecorator =>
  Layer.merge(
    Layer.effect(
      SqlClient.SqlClient,
      Effect.gen(function*() {
        const base = yield* Effect.service(SqlClient.SqlClient)
        return new Proxy(base, {
          apply(target, thisArgument, argumentsList) {
            const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
            if (typeof statement.compile !== "function" || !matches(statement.compile()[0])) {
              return statement
            }
            return statement.pipe(Effect.map((real) => rows() ?? real))
          }
        }) as SqlClient.SqlClient
      })
    ),
    keepWriter
  )

/**
 * Records every compaction-policy seeding COUNT and holds it until `overlap`
 * rows have committed.
 *
 * The hold opens the scheduling window the lost-count race needs: without a
 * per-run permit both settlements pass the "is the counter seeded" check before
 * either one answers it. It also fixes what the COUNT sees. Two concurrent
 * durable emits commit in whatever order the database serves them, so on a
 * server database the first seeding COUNT could otherwise run before or after
 * the other commit.
 */
const overlappingCounts = (seeds: Array<string>, overlap: number): DatabaseDecorator =>
  Layer.merge(
    Layer.effect(
      SqlClient.SqlClient,
      Effect.gen(function*() {
        const base = yield* Effect.service(SqlClient.SqlClient)
        return new Proxy(base, {
          apply(target, thisArgument, argumentsList) {
            const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
            if (typeof statement.compile !== "function") return statement
            const sqlText = statement.compile()[0]
            if (!sqlText.includes("COUNT(*) AS total")) return statement
            const committed = base<{ readonly rows: number | string }>`
              SELECT COUNT(*) AS "rows" FROM flows_journal_events
            `.pipe(Effect.map(([row]) => Number(row?.rows ?? 0) >= overlap))
            return Effect.sync(() => {
              seeds.push(sqlText)
            }).pipe(Effect.andThen(TestDatabase.until(committed)), Effect.andThen(statement))
          }
        }) as SqlClient.SqlClient
      })
    ),
    keepWriter
  )

/** Parks every durable page read behind `gate`, announcing arrival once. */
const gatedPageReads = (
  gate: Deferred.Deferred<void>,
  reached: Deferred.Deferred<void>
): DatabaseDecorator =>
  Layer.merge(
    Layer.effect(
      SqlClient.SqlClient,
      Effect.gen(function*() {
        const base = yield* Effect.service(SqlClient.SqlClient)
        return new Proxy(base, {
          apply(target, thisArgument, argumentsList) {
            const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
            if (
              typeof statement.compile !== "function" ||
              !statement.compile()[0].includes("AND seq >") ||
              statement.compile()[0].includes("seq >=")
            ) {
              return statement
            }
            return Deferred.succeed(reached, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(statement)
            )
          }
        }) as SqlClient.SqlClient
      })
    ),
    keepWriter
  )

/** Counts durable page SELECTs while preserving the real SQLite statement. */
const countingPageReads = (count: () => void): DatabaseDecorator =>
  Layer.merge(
    Layer.effect(
      SqlClient.SqlClient,
      Effect.gen(function*() {
        const base = yield* Effect.service(SqlClient.SqlClient)
        return new Proxy(base, {
          apply(target, thisArgument, argumentsList) {
            const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
            if (
              typeof statement.compile === "function" &&
              statement.compile()[0].includes("AND seq >") &&
              !statement.compile()[0].includes("seq >=")
            ) {
              count()
            }
            return statement
          }
        }) as SqlClient.SqlClient
      })
    ),
    keepWriter
  )

/** Parks only the first journal write, leaving later writes able to commit. */
const gateFirstWrite = (
  reached: Deferred.Deferred<void>,
  gate: Deferred.Deferred<void>
): DatabaseDecorator => {
  let first = true
  return Layer.merge(
    Layer.effect(
      DurableWriter,
      Effect.gen(function*() {
        const writer = yield* DurableWriter
        return DurableWriter.of({
          write: (write) => {
            if (!first) return writer.write(write)
            first = false
            return Deferred.succeed(reached, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(writer.write(write))
            ) as never
          }
        })
      })
    ),
    Layer.effect(SqlClient.SqlClient, Effect.service(SqlClient.SqlClient))
  )
}

/**
 * Parks compaction at its checkpoint read inside SQL, with the gate closed,
 * and forces a scheduling boundary after every canonical-sequence floor read.
 *
 * `node:sqlite` is synchronous, so without that boundary one durable write
 * runs from admission to COMMIT without ever yielding, and two writers racing
 * for one run can never actually overlap in a test.
 */
const gateCompactionWithYieldingFloors = (
  reached: Deferred.Deferred<void>,
  gate: Deferred.Deferred<void>
): DatabaseDecorator => {
  return Layer.merge(
    Layer.effect(DurableWriter, Effect.service(DurableWriter)),
    Layer.effect(
      SqlClient.SqlClient,
      Effect.gen(function*() {
        const base = yield* Effect.service(SqlClient.SqlClient)
        return new Proxy(base, {
          apply(target, thisArgument, argumentsList) {
            const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
            if (typeof statement.compile !== "function") return statement
            const [query] = statement.compile()
            if (query.includes("SELECT run_id, seq, state_json")) {
              return Deferred.succeed(reached, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.andThen(statement)
              )
            }
            if (!query.includes("MAX(seq) + 1")) return statement
            return statement.pipe(Effect.tap(() => Effect.yieldNow))
          }
        }) as SqlClient.SqlClient
      })
    )
  )
}

const journal = (
  options?: Partial<SqlJournal.SqlJournalOptions>,
  database?: DatabaseDecorator
) => {
  const layer = SqlJournal.layer({ capacity: 64, overflow: "reject", ...options })
  return database === undefined ? layer : layer.pipe(Layer.provide(database))
}

const eventCount = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const rows = yield* sql<{ readonly total: number }>`
    SELECT COUNT(*) AS total FROM flows_journal_events WHERE run_id = ${run}
  `
  return Number(rows[0]!.total)
})

const emitMany = (service: Service, from: number, count: number) =>
  Effect.gen(function*() {
    for (let index = from; index < from + count; index++) {
      yield* service.emitDurableUnfenced(input(index))
    }
  })

/**
 * The replay a consumer performs: the latest checkpoint's state, then the
 * durable tail strictly after it — paged small so the floor guard is
 * exercised on cursors, not just on the first read.
 */
const replayView = (service: Service) =>
  Effect.gen(function*() {
    const latest = yield* service.latestCheckpoint(run)
    const entries: Array<Entry> = []
    let cursor = Option.isSome(latest) ? (latest.value.seq as number) : undefined
    while (true) {
      const page = yield* service.entries({
        runId: run,
        ...(cursor === undefined ? {} : { after: seqOf(cursor) }),
        limit: 3
      })
      entries.push(...page.entries)
      const last = page.entries.at(-1)
      if (last !== undefined) {
        cursor = last.seq
      }
      if (!page.hasMore) {
        break
      }
    }
    return {
      state: Option.isSome(latest) ? latest.value.state : undefined,
      tail: entries.map((entry) => ({ seq: entry.seq, payload: entry.payload }))
    }
  })

describe("compacted producer identities", () => {
  effect("a fingerprint failure rolls back compaction without losing replay evidence", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* claim(owner)
      yield* emitMany(service, 0, 3)
      yield* service.checkpoint({ runId: run, seq: seqOf(2), state: { applied: 3 } }, owner)
      const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("digest unavailable"))
      const failure = yield* service.compact({ runId: run }, owner).pipe(
        Effect.flip,
        Effect.ensuring(Effect.sync(() => digest.mockRestore()))
      )
      expect(failure.code).toBe("sink_failed")
      expect(failure.message).toBe("could not fingerprint journal content")
      expect((yield* service.entries({ runId: run, limit: 10 })).entries.map((entry) => entry.seq)).toEqual([0, 1, 2])
      expect(Option.getOrThrow(yield* service.latestCheckpoint(run)).compactedAtMs).toBe(null)
      expect((yield* service.compact({ runId: run }, owner)).deleted).toBe(2)
    }).pipe(Effect.provide(journal()), Effect.scoped))

  effect(
    "deduplicates compacted events after cache eviction and preserves producer floors",
    () =>
      Effect.gen(function*() {
        const service = yield* Journal
        yield* claim(owner)
        const original = yield* service.emitDurableUnfenced(input(7))
        yield* service.emitDurableUnfenced(new Input({ ...input(0), sourceId: sourceId("checkpoint") }))
        yield* service.checkpoint({ runId: run, seq: seqOf(1), state: { applied: 2 } }, owner)
        yield* service.compact({ runId: run }, owner)

        yield* service.emitLossy(input(7))
        yield* service.flush
        expect(yield* eventCount).toBe(1)
        for (const retry of [service.emitDurableUnfenced(input(7)), service.emitDurable(input(7), owner)]) {
          expect(yield* retry).toEqual({ _tag: "Duplicate", seq: original.seq, sourceSeq: 7, status: "committed" })
        }
        yield* service.emitLossy(input(7))
        yield* service.flush
        expect(yield* eventCount).toBe(1)
        expect(yield* replayView(service)).toEqual({ state: { applied: 2 }, tail: [] })

        for (
          const changed of [
            new Input({ ...input(7), payload: { changed: true } }),
            new Input({ ...input(7), meta: { changed: true } }),
            new Input({ ...input(7), eventType: "changed" })
          ]
        ) {
          const conflict = yield* service.emitDurableUnfenced(changed).pipe(Effect.flip)
          expect(conflict.code).toBe("idempotency_conflict")
        }
        expect(
          yield* service.emitDurableUnfenced(
            new Input({
              ...input(7),
              payload: { changed: true },
              dedupe: "identity"
            })
          )
        ).toEqual({ _tag: "Duplicate", seq: original.seq, sourceSeq: 7, status: "committed" })
        const stale = yield* service.emitDurable(input(7), { ...owner, nonce: "stale" }).pipe(Effect.flip)
        expect(stale.code).toBe("fence_lost")
        const next = yield* service.emitDurableUnfenced(
          new Input({
            runId: run,
            sourceId: source,
            eventType: "event",
            payload: { next: true }
          })
        )
        expect(next.sourceSeq).toBe(8)
        yield* service.checkpoint({ runId: run, seq: next.seq, state: { applied: 3 } }, owner)
        yield* service.compact({ runId: run }, owner)
        expect(yield* service.emitDurableUnfenced(input(7))).toEqual({
          _tag: "Duplicate",
          seq: original.seq,
          sourceSeq: 7,
          status: "committed"
        })
        expect(yield* replayView(service)).toEqual({ state: { applied: 3 }, tail: [] })
      }).pipe(Effect.provide(journal({ sourceEventCache: 1 })), Effect.scoped)
  )
})

describe("Journal.checkpoint", () => {
  effect("captures replay state at a committed sequence and reads it back", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* claim(owner)
      yield* emitMany(service, 0, 6)
      const written = yield* service.checkpoint({ runId: run, seq: seqOf(3), state: { applied: 4 } }, owner)
      expect(written.seq).toBe(3)
      expect(written.compactedAtMs).toBeNull()
      const latest = yield* service.latestCheckpoint(run)
      expect(Option.isSome(latest)).toBe(true)
      expect(Option.getOrThrow(latest).state).toEqual({ applied: 4 })
      expect(Option.getOrThrow(latest).compactedAtMs).toBeNull()
    }).pipe(Effect.provide(journal()), Effect.scoped))

  effect("rejects a checkpoint at a sequence that names no committed entry", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* claim(owner)
      yield* emitMany(service, 0, 2)
      const failure = yield* Effect.flip(service.checkpoint({ runId: run, seq: seqOf(9), state: null }, owner))
      expect(failure).toBeInstanceOf(JournalError)
      expect(failure.code).toBe("checkpoint_invalid")
    }).pipe(Effect.provide(journal()), Effect.scoped))

  effect("re-checkpointing an uncompacted sequence replaces the state", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* claim(owner)
      yield* emitMany(service, 0, 4)
      yield* service.checkpoint({ runId: run, seq: seqOf(2), state: { attempt: 1 } }, owner)
      yield* service.checkpoint({ runId: run, seq: seqOf(2), state: { attempt: 2 } }, owner)
      const latest = yield* service.latestCheckpoint(run)
      expect(Option.getOrThrow(latest).state).toEqual({ attempt: 2 })
    }).pipe(Effect.provide(journal()), Effect.scoped))

  effect("returns the exact persisted JSON round trip without aliasing caller state", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* claim(owner)
      yield* emitMany(service, 0, 2)
      const original = {
        when: new Date("2026-08-31T12:34:56.000Z"),
        omitted: undefined,
        notANumber: Number.NaN
      }
      const written = yield* service.checkpoint({ runId: run, seq: seqOf(1), state: original }, owner)
      const latest = Option.getOrThrow(yield* service.latestCheckpoint(run))

      expect(written.state).toEqual(latest.state)
      expect(written.state).toEqual({
        when: "2026-08-31T12:34:56.000Z",
        notANumber: null
      })

      original.when.setUTCFullYear(2030)
      original.notANumber = 7
      expect(written.state).toEqual({
        when: "2026-08-31T12:34:56.000Z",
        notANumber: null
      })
    }).pipe(Effect.provide(journal()), Effect.scoped))

  effect("rolls back with the transaction that wrote it", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* claim(owner)
      yield* emitMany(service, 0, 3)
      const exit = yield* service.transact(
        service.checkpoint({ runId: run, seq: seqOf(1), state: { half: true } }, owner).pipe(
          Effect.andThen(Effect.fail(new Error("rejected after the checkpoint write")))
        )
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      // The write shares `transact`'s discipline: rolled back with the body.
      expect(Option.isNone(yield* service.latestCheckpoint(run))).toBe(true)
    }).pipe(Effect.provide(journal()), Effect.scoped))
})

describe("Journal.compact", () => {
  effect("replay from the checkpoint is identical before and after compaction", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* claim(owner)
      yield* emitMany(service, 0, 8)
      const full = yield* service.entries({ runId: run, limit: 100 })
      const prefix = full.entries.filter((entry) => entry.seq <= 4).map((entry) => entry.payload)
      yield* service.checkpoint({ runId: run, seq: seqOf(4), state: { prefix } }, owner)

      const before = yield* replayView(service)
      const compacted = yield* service.compact({ runId: run }, owner)
      const after = yield* replayView(service)

      expect(compacted).toEqual({ runId: run, checkpointSeq: 4, deleted: 4 })
      expect(after).toEqual(before)
      // The reconstruction covers the whole history: checkpointed prefix plus
      // the tail equals what a full replay produced before compaction.
      expect([
        ...(after.state as { prefix: Array<unknown> }).prefix,
        ...after.tail.map((entry) => entry.payload)
      ]).toEqual(full.entries.map((entry) => entry.payload))
      expect(yield* eventCount).toBe(4)

      // The journal keeps appending across the boundary, monotonically.
      const next = yield* service.emitDurableUnfenced(input(8))
      expect(next.seq).toBe(8)
    }).pipe(Effect.provide(journal()), Effect.scoped))

  effect("refuses to compact a run that has no checkpoint", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* claim(owner)
      yield* emitMany(service, 0, 3)
      const failure = yield* Effect.flip(service.compact({ runId: run }, owner))
      expect(failure.code).toBe("checkpoint_invalid")
      expect(yield* eventCount).toBe(3)
    }).pipe(Effect.provide(journal()), Effect.scoped))

  effect("is idempotent: a retried compaction deletes nothing further", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* claim(owner)
      yield* emitMany(service, 0, 5)
      yield* service.checkpoint({ runId: run, seq: seqOf(4), state: null }, owner)
      const first = yield* service.compact({ runId: run }, owner)
      const second = yield* service.compact({ runId: run }, owner)
      expect(first.deleted).toBe(4)
      expect(second).toEqual({ runId: run, checkpointSeq: 4, deleted: 0 })
    }).pipe(Effect.provide(journal()), Effect.scoped))

  effect("rejects a new checkpoint at or below the compaction floor", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* claim(owner)
      yield* emitMany(service, 0, 6)
      yield* service.checkpoint({ runId: run, seq: seqOf(4), state: null }, owner)
      yield* service.compact({ runId: run }, owner)
      const failure = yield* Effect.flip(
        service.checkpoint({ runId: run, seq: seqOf(4), state: { rewrite: true } }, owner)
      )
      expect(failure.code).toBe("checkpoint_invalid")
      expect(failure.checkpointSeq).toBe(4)
      // Above the floor stays checkpointable.
      const above = yield* service.checkpoint({ runId: run, seq: seqOf(5), state: null }, owner)
      expect(above.seq).toBe(5)
    }).pipe(Effect.provide(journal()), Effect.scoped))

  effect("a compaction inside a rolled-back transact restores every entry", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* claim(owner)
      yield* emitMany(service, 0, 6)
      yield* service.checkpoint({ runId: run, seq: seqOf(5), state: null }, owner)
      const exit = yield* service.transact(
        service.compact({ runId: run }, owner).pipe(
          Effect.andThen(Effect.fail(new Error("rejected after the truncation")))
        )
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* eventCount).toBe(6)
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT * FROM flows_journal_dedup WHERE run_id = ${run}`).toEqual([])
      const page = yield* service.entries({ runId: run, limit: 100 })
      expect(page.entries.map((entry) => entry.seq)).toEqual([0, 1, 2, 3, 4, 5])
    }).pipe(Effect.provide(journal()), Effect.scoped))

  effect("allocation never reuses a truncated sequence, even from a fresh process", () =>
    Effect.gen(function*() {
      yield* Effect.gen(function*() {
        const service = yield* Journal
        yield* claim(owner)
        yield* emitMany(service, 0, 6)
        yield* service.checkpoint({ runId: run, seq: seqOf(5), state: null }, owner)
        const compacted = yield* service.compact({ runId: run }, owner)
        expect(compacted.deleted).toBe(5)
      }).pipe(Effect.provide(journal()), Effect.scoped)

      // A fresh journal instance over the same database rebuilds its floors
      // from `MAX(seq)`: the surviving checkpointed entry keeps it above the
      // truncated range, so no deleted sequence is ever re-minted.
      yield* Effect.gen(function*() {
        const service = yield* Journal
        const durable = yield* service.emitDurableUnfenced(input(6))
        expect(durable.seq).toBe(6)
        const lossy = yield* service.emitLossy(input(7))
        expect(lossy.seq).toBe(7)
        yield* service.flush
      }).pipe(Effect.provide(journal()), Effect.scoped)

      expect(yield* eventCount).toBe(3)
    }))

  effect("waits for an admitted lossy entry before advancing the compaction floor", () =>
    Effect.gen(function*() {
      const reached = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      yield* Effect.gen(function*() {
        const service = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* claim(owner)

        const queued = yield* service.emitLossy(input(0))
        expect(queued.seq).toBe(0)
        yield* Deferred.await(reached)

        const durable = yield* service.emitDurableUnfenced(input(1))
        expect(durable.seq).toBe(1)
        yield* service.checkpoint({ runId: run, seq: seqOf(1), state: null }, owner)

        const compacting = yield* service.compact({ runId: run, upTo: seqOf(1) }, owner).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        for (let attempt = 0; attempt < 8; attempt++) {
          yield* Effect.yieldNow
        }
        expect(compacting.pollUnsafe()).toBeUndefined()

        // Admission stays open during the drain. This reservation joins the
        // work compaction owes, without waiting for the parked batch's SQL.
        const lateAdmission = yield* service.emitLossy(input(2))
        expect(lateAdmission).toEqual({ _tag: "Accepted", seq: 2, sourceSeq: 2 })
        expect(compacting.pollUnsafe()).toBeUndefined()

        yield* Deferred.succeed(gate, undefined)
        const compacted = yield* Fiber.join(compacting)
        // The overtaken reservation commits at 2, above this checkpoint, so
        // compaction must retain it for replay after the checkpoint.
        expect(compacted).toEqual({ runId: run, checkpointSeq: 1, deleted: 0 })
        yield* service.flush

        const rows = yield* sql<{ readonly seq: number; readonly source_seq: number }>`
          SELECT seq, source_seq FROM flows_journal_events WHERE run_id = ${run} ORDER BY seq ASC
        `
        const floor = Option.getOrThrow(yield* service.latestCheckpoint(run)).seq
        expect(rows.map((row) => row.seq)).toEqual([1, 2, 3])
        expect(rows.map((row) => row.source_seq)).toEqual([1, 0, 2])
        expect(rows.every((row) => row.seq >= floor)).toBe(true)

        const behind = yield* Effect.flip(service.entries({ runId: run, limit: 10 }))
        expect(behind.code).toBe("compacted")
        expect(behind.checkpointSeq).toBe(1)
        for (const eventType of ["event", "absent"]) {
          const filtered = yield* service.entries({ runId: run, eventTypes: [eventType], limit: 10 }).pipe(Effect.flip)
          expect(filtered.code).toBe("compacted")
          expect(filtered.checkpointSeq).toBe(1)
        }
      }).pipe(
        Effect.ensuring(Deferred.succeed(gate, undefined)),
        Effect.provide(journal({}, gateFirstWrite(reached, gate))),
        Effect.scoped
      )
    }))

  effect(
    "holds concurrent durable writes behind the barrier and releases them when it ends",
    () =>
      Effect.gen(function*() {
        const reached = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        yield* Effect.gen(function*() {
          const service = yield* Journal
          const sql = yield* Effect.service(SqlClient.SqlClient)
          yield* claim(owner)

          expect((yield* service.emitDurableUnfenced(input(0))).seq).toBe(0)

          const compacting = yield* Effect.flip(service.compact({ runId: run }, owner)).pipe(
            Effect.forkChild({ startImmediately: true })
          )
          // SQL is owned and the admission gate is closed at this exact read.
          yield* Deferred.await(reached)
          expect(compacting.pollUnsafe()).toBeUndefined()

          // Two durable writes on the SAME run: both are refused entry while the
          // barrier owns it, and when it releases they run one at a time behind
          // the allocation permit.
          const first = yield* service.emitDurableUnfenced(input(1)).pipe(
            Effect.forkChild({ startImmediately: true })
          )
          const second = yield* service.emitDurableUnfenced(input(2)).pipe(
            Effect.forkChild({ startImmediately: true })
          )
          for (let attempt = 0; attempt < 8; attempt++) {
            yield* Effect.yieldNow
          }
          expect(first.pollUnsafe()).toBeUndefined()
          expect(second.pollUnsafe()).toBeUndefined()

          yield* Deferred.succeed(gate, undefined)
          // The run has no checkpoint, so the compaction refuses. The barrier
          // must release the run anyway, or a refused compaction would wedge
          // every later write.
          const refused = yield* Fiber.join(compacting)
          expect(refused.code).toBe("checkpoint_invalid")

          const seqs = [(yield* Fiber.join(first)).seq, (yield* Fiber.join(second)).seq]
          expect([...seqs].sort()).toEqual([1, 2])
          yield* service.flush

          const rows = yield* sql<{ readonly seq: number }>`
          SELECT seq FROM flows_journal_events WHERE run_id = ${run} ORDER BY seq ASC
        `
          expect(rows.map((row) => row.seq)).toEqual([0, 1, 2])
        }).pipe(
          Effect.ensuring(Deferred.succeed(gate, undefined)),
          Effect.provide(journal({}, gateCompactionWithYieldingFloors(reached, gate))),
          Effect.scoped
        )
      })
  )
})

describe("a crash injected mid-compaction", () => {
  effect("leaves every entry and no floor, and a retry completes cleanly", () =>
    Effect.gen(function*() {
      let crash = true
      const result = yield* Effect.gen(function*() {
        const service = yield* Journal
        yield* claim(owner)
        yield* emitMany(service, 0, 6)
        yield* service.checkpoint({ runId: run, seq: seqOf(5), state: { upTo: 5 } }, owner)
        const before = yield* replayView(service)

        // The injected defect fires after the floor-advance UPDATE — the last
        // statement of the compaction transaction — so every delete already
        // ran and only the transaction's atomicity can undo them.
        const crashed = yield* service.compact({ runId: run }, owner).pipe(Effect.exit)
        const countAfterCrash = yield* eventCount
        const viewAfterCrash = yield* replayView(service)
        const floorAfterCrash = yield* service.latestCheckpoint(run)

        crash = false
        const retried = yield* service.compact({ runId: run }, owner)
        return {
          before,
          crashed,
          countAfterCrash,
          viewAfterCrash,
          floorAfterCrash,
          retried,
          viewAfterRetry: yield* replayView(service),
          countAfterRetry: yield* eventCount
        }
      }).pipe(
        Effect.provide(journal({}, crashingDatabase("UPDATE flows_journal_checkpoints", () => crash))),
        Effect.scoped
      )

      expect(Exit.isFailure(result.crashed)).toBe(true)
      expect(
        Exit.isFailure(result.crashed) && Cause.squash(result.crashed.cause) instanceof CrashInjected
      ).toBe(true)
      // Consistency after the crash: nothing deleted, no floor advanced.
      expect(result.countAfterCrash).toBe(6)
      expect(result.viewAfterCrash).toEqual(result.before)
      expect(Option.getOrThrow(result.floorAfterCrash).compactedAtMs).toBeNull()
      // The retry is the same compaction, completed.
      expect(result.retried).toEqual({ runId: run, checkpointSeq: 5, deleted: 5 })
      expect(result.viewAfterRetry).toEqual(result.before)
      expect(result.countAfterRetry).toBe(1)
    }))
})

describe("followers across compaction", () => {
  effect("emits one historical page at a time and cancels without reading ahead", () =>
    Effect.gen(function*() {
      let pageReads = 0
      const firstSeen = yield* Deferred.make<void>()
      const holdFirst = yield* Deferred.make<void>()

      yield* Effect.gen(function*() {
        const service = yield* Journal
        yield* claim(owner)
        yield* emitMany(service, 0, 500)
        yield* service.checkpoint({ runId: run, seq: seqOf(20), state: null }, owner)

        const follower = yield* Stream.runForEach(service.stream({ runId: run }), (entry) =>
          entry.seq === 0
            ? Deferred.succeed(firstSeen, undefined).pipe(
              Effect.andThen(Deferred.await(holdFirst))
            )
            : Effect.void).pipe(Effect.forkChild({ startImmediately: true }))

        yield* Deferred.await(firstSeen)
        expect(pageReads).toBe(1)

        // A ten-entry page advances the registered cursor only through seq 9,
        // so compaction at 20 must still see this live reader as behind.
        const refused = yield* Effect.flip(service.compact({ runId: run, upTo: seqOf(20) }, owner))
        expect(refused.code).toBe("reader_behind")

        yield* Fiber.interrupt(follower)
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        expect(pageReads).toBe(1)
      }).pipe(
        Effect.ensuring(Deferred.succeed(holdFirst, undefined)),
        Effect.provide(journal(
          { batchSize: 10 },
          countingPageReads(() => {
            pageReads += 1
          })
        )),
        Effect.scoped
      )
    }))

  effect("surfaces compaction discovered after an emitted historical page", () =>
    Effect.gen(function*() {
      let floorReads = 0
      const observed: Array<number> = []
      yield* Effect.gen(function*() {
        const service = yield* Journal
        yield* emitMany(service, 0, 5)
        const failure = yield* Effect.flip(
          service.stream({ runId: run }).pipe(
            Stream.tap((entry) => Effect.sync(() => observed.push(entry.seq))),
            Stream.runCollect
          )
        )
        expect(failure.code).toBe("compacted")
        expect(failure.checkpointSeq).toBe(3)
      }).pipe(
        Effect.provide(journal(
          { batchSize: 1 },
          stubbedRows(
            (text) => text.includes("MAX(seq) AS floor"),
            () => [{ floor: floorReads++ === 0 ? null : 3 }]
          )
        )),
        Effect.scoped
      )
      expect(observed).toEqual([0])
    }))

  effect("a page read whose cursor starts below the floor fails with the resync point", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* claim(owner)
      yield* emitMany(service, 0, 6)
      yield* service.checkpoint({ runId: run, seq: seqOf(5), state: null }, owner)
      yield* service.compact({ runId: run }, owner)

      const fromScratch = yield* Effect.flip(service.entries({ runId: run, limit: 10 }))
      expect(fromScratch.code).toBe("compacted")
      expect(fromScratch.checkpointSeq).toBe(5)

      const behind = yield* Effect.flip(service.entries({ runId: run, after: seqOf(2), limit: 10 }))
      expect(behind.code).toBe("compacted")

      // At the boundary and above, the history is complete.
      const atBoundary = yield* service.entries({ runId: run, after: seqOf(4), limit: 10 })
      expect(atBoundary.entries.map((entry) => entry.seq)).toEqual([5])
      const atFloor = yield* service.entries({ runId: run, after: seqOf(5), limit: 10 })
      expect(atFloor.entries).toEqual([])
    }).pipe(Effect.provide(journal()), Effect.scoped))

  effect("a stream subscribed below the floor fails with compacted instead of gapping", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* claim(owner)
      yield* emitMany(service, 0, 6)
      yield* service.checkpoint({ runId: run, seq: seqOf(5), state: null }, owner)
      yield* service.compact({ runId: run }, owner)

      const failure = yield* Effect.flip(
        Stream.runHead(service.stream({ runId: run, afterSequence: seqOf(1) }))
      )
      expect(failure.code).toBe("compacted")
      expect(failure.checkpointSeq).toBe(5)

      // Resync: replay the checkpoint state, then follow from its sequence.
      const resynced = yield* service.latestCheckpoint(run)
      const follow = yield* service.entries({
        runId: run,
        after: Option.getOrThrow(resynced).seq,
        limit: 10
      })
      expect(follow.entries).toEqual([])
    }).pipe(Effect.provide(journal()), Effect.scoped))

  effect(
    "a live stream behind the boundary blocks compaction, then keeps following across it",
    () =>
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const reached = yield* Deferred.make<void>()
        const observed: Array<number> = []
        const drained = yield* Deferred.make<void>()

        yield* Effect.gen(function*() {
          const service = yield* Journal
          yield* claim(owner)
          yield* emitMany(service, 0, 6)
          yield* service.checkpoint({ runId: run, seq: seqOf(5), state: null }, owner)

          // The follower registers, then parks on the gated page read with its
          // cursor still at -1: durably behind the checkpoint.
          const follower = yield* Stream.runForEach(service.stream({ runId: run }), (entry) =>
            Effect.sync(() => {
              observed.push(entry.seq)
              if (observed.length === 6) {
                Deferred.doneUnsafe(drained, Effect.void)
              }
            })).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(reached)

          const refused = yield* Effect.flip(service.compact({ runId: run }, owner))
          expect(refused.code).toBe("reader_behind")
          expect(refused.checkpointSeq).toBe(5)
          expect(yield* eventCount).toBe(6)

          // Release the follower; once it has read to the boundary the same
          // compaction is safe, and the still-live stream follows across it.
          yield* Deferred.succeed(gate, undefined)
          yield* Deferred.await(drained)
          const compacted = yield* service.compact({ runId: run }, owner)
          expect(compacted.deleted).toBe(5)

          yield* service.emitDurableUnfenced(input(6))
          yield* Effect.repeat(Effect.yieldNow, { until: () => observed.length >= 7 })
          yield* Fiber.interrupt(follower)
        }).pipe(
          Effect.provide(journal({}, gatedPageReads(gate, reached))),
          Effect.scoped
        )

        expect(observed).toEqual([0, 1, 2, 3, 4, 5, 6])
      })
  )
})

describe("fencing across compaction", () => {
  effect("a fenced checkpoint and compaction commit while the owner holds the run", () =>
    Effect.gen(function*() {
      yield* claim(owner)
      const service = yield* Journal
      yield* emitMany(service, 0, 4)
      const written = yield* service.checkpoint({ runId: run, seq: seqOf(3), state: null }, owner)
      expect(written.seq).toBe(3)
      const compacted = yield* service.compact({ runId: run }, owner)
      expect(compacted.deleted).toBe(3)
    }).pipe(Effect.provide(journal()), Effect.scoped))

  effect("a reclaimed owner can neither checkpoint nor compact, and deletes nothing", () =>
    Effect.gen(function*() {
      yield* claim(owner)
      const service = yield* Journal
      yield* emitMany(service, 0, 4)
      yield* service.checkpoint({ runId: run, seq: seqOf(3), state: null }, owner)

      // The run is reclaimed: the old owner's fence is gone.
      yield* claim({ hostId: "host-b", pid: 7, nonce: "nonce-b" })
      const checkpointLost = yield* Effect.flip(
        service.checkpoint({ runId: run, seq: seqOf(3), state: { zombie: true } }, owner)
      )
      expect(checkpointLost.code).toBe("fence_lost")
      const compactLost = yield* Effect.flip(service.compact({ runId: run }, owner))
      expect(compactLost.code).toBe("fence_lost")
      expect(yield* eventCount).toBe(4)
      const latest = yield* service.latestCheckpoint(run)
      expect(Option.getOrThrow(latest).state).toBeNull()
    }).pipe(Effect.provide(journal()), Effect.scoped))
})

describe("refused arguments and failing hosts", () => {
  effect("refuses a compaction policy whose threshold is not a positive safe integer", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.gen(function*() {
        yield* Journal
      }).pipe(
        Effect.provide(journal({
          compaction: { entryThreshold: 0, capture: () => Effect.succeed(null) }
        })),
        Effect.scoped,
        Effect.flip
      )
      expect(failure).toBeInstanceOf(JournalError)
      expect((failure as JournalError).code).toBe("invalid_event")
    }))

  effect(
    "refuses checkpoint, latestCheckpoint, and compact arguments naming no run or sequence",
    () =>
      Effect.gen(function*() {
        const service = yield* Journal
        const emptyRun = yield* Effect.flip(service.checkpoint({ runId: runId(""), seq: seqOf(0), state: null }, owner))
        expect(emptyRun.code).toBe("invalid_event")
        const negativeSeq = yield* Effect.flip(service.checkpoint({ runId: run, seq: seqOf(-1), state: null }, owner))
        expect(negativeSeq.code).toBe("invalid_event")
        const fractionalSeq = yield* Effect.flip(
          service.checkpoint({ runId: run, seq: seqOf(1.5), state: null }, owner)
        )
        expect(fractionalSeq.code).toBe("invalid_event")
        const latestEmpty = yield* Effect.flip(service.latestCheckpoint(runId("")))
        expect(latestEmpty.code).toBe("invalid_event")
        const compactEmpty = yield* Effect.flip(service.compact({ runId: runId("") }, owner))
        expect(compactEmpty.code).toBe("invalid_event")
      }).pipe(Effect.provide(journal()), Effect.scoped)
  )

  effect("names the requested sequence when the checkpoint to compact to is missing", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* claim(owner)
      yield* emitMany(service, 0, 3)
      const failure = yield* Effect.flip(service.compact({ runId: run, upTo: seqOf(2) }, owner))
      expect(failure.code).toBe("checkpoint_invalid")
      expect(failure.message).toContain("at sequence 2")
    }).pipe(Effect.provide(journal()), Effect.scoped))

  effect("a checkpoint row that no longer parses fails with decode_failed", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* claim(owner)
      yield* emitMany(service, 0, 3)
      yield* service.checkpoint({ runId: run, seq: seqOf(2), state: { ok: true } }, owner)
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* TestDatabase.checks(sql, false)
      yield* sql`UPDATE flows_journal_checkpoints SET state_json = ${"not json"} WHERE run_id = ${run}`
      yield* TestDatabase.checks(sql, true)
      const failure = yield* Effect.flip(service.latestCheckpoint(run))
      expect(failure.code).toBe("decode_failed")
    }).pipe(Effect.provide(journal()), Effect.scoped))

  effect("reads and writes against a vanished checkpoint table surface typed errors", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* claim(owner)
      yield* emitMany(service, 0, 2)
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* sql`DROP TABLE flows_journal_checkpoints ${
        sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
      }`
      // The floor read behind a page read, the latest-checkpoint read, and
      // the checkpoint write each map the host failure instead of leaking it.
      const page = yield* Effect.flip(service.entries({ runId: run, limit: 10 }))
      expect(page.code).toBe("read_failed")
      const latest = yield* Effect.flip(service.latestCheckpoint(run))
      expect(latest.code).toBe("read_failed")
      const written = yield* Effect.flip(service.checkpoint({ runId: run, seq: seqOf(1), state: null }, owner))
      expect(written.code).toBe("sink_failed")
    }).pipe(Effect.provide(journal()), Effect.scoped))

  effect("a compaction over a vanished events table fails as sink_failed", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* claim(owner)
      yield* emitMany(service, 0, 3)
      yield* service.checkpoint({ runId: run, seq: seqOf(2), state: null }, owner)
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* sql`DROP TABLE flows_journal_events ${
        sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
      }`
      const failure = yield* Effect.flip(service.compact({ runId: run }, owner))
      expect(failure.code).toBe("sink_failed")
    }).pipe(Effect.provide(journal()), Effect.scoped))
})

describe("the compaction policy hook", () => {
  effect("is off by default: nothing is checkpointed or deleted", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* emitMany(service, 0, 12)
      expect(yield* eventCount).toBe(12)
      expect(Option.isNone(yield* service.latestCheckpoint(run))).toBe(true)
    }).pipe(Effect.provide(journal()), Effect.scoped))

  effect("does not hold another run's admission behind a slow durable capture", () =>
    Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const reachedCapture = yield* Deferred.make<void>()
      yield* Effect.gen(function*() {
        const service = yield* Journal
        const crossing = yield* service.emitDurableUnfenced(input(0)).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(reachedCapture)

        const unrelatedRun = runId("unrelated-capture")
        const unrelated = yield* service.emitLossy(
          new Input({
            runId: unrelatedRun,
            sourceId: source,
            sourceSeq: 0 as SourceSeq,
            eventType: "event",
            payload: { value: 0 }
          }, { disableChecks: true })
        ).pipe(Effect.forkChild({ startImmediately: true }))
        // The unrelated run's floors are cold, so its admission reads SQL
        // first. That read is real I/O on a server database, which no count of
        // scheduler turns waits for; the capture stays gated throughout.
        yield* TestDatabase.until(Effect.sync(() => unrelated.pollUnsafe() !== undefined))
        expect(unrelated.pollUnsafe()?._tag).toBe("Success")
        expect(crossing.pollUnsafe()).toBeUndefined()

        yield* Deferred.succeed(gate, undefined)
        expect((yield* Fiber.join(crossing)).seq).toBe(0)
        expect((yield* Fiber.join(unrelated)).seq).toBe(0)
        yield* service.flush
      }).pipe(
        Effect.ensuring(Deferred.succeed(gate, undefined)),
        Effect.provide(journal({
          compaction: {
            entryThreshold: 1,
            capture: (activeRun) =>
              activeRun === run
                ? Deferred.succeed(reachedCapture, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.as(null)
                )
                : Effect.succeed(null)
          }
        })),
        Effect.scoped
      )
    }))

  effect("times out a hanging capture and damps it without wedging the emit", () =>
    Effect.gen(function*() {
      const reachedCapture = yield* Deferred.make<void>()
      yield* Effect.gen(function*() {
        const service = yield* Journal
        const crossing = yield* service.emitDurableUnfenced(input(0)).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(reachedCapture)
        expect(crossing.pollUnsafe()).toBeUndefined()

        yield* TestClock.adjust("30 seconds")
        for (let attempt = 0; attempt < 8; attempt++) {
          yield* Effect.yieldNow
        }
        expect(crossing.pollUnsafe()?._tag).toBe("Success")
        expect((yield* Fiber.join(crossing)).seq).toBe(0)
        expect(Option.isNone(yield* service.latestCheckpoint(run))).toBe(true)
        expect(yield* eventCount).toBe(1)
      }).pipe(
        Effect.provide(journal({
          compaction: {
            entryThreshold: 1,
            capture: () => Deferred.succeed(reachedCapture, undefined).pipe(Effect.andThen(Effect.never))
          }
        })),
        Effect.scoped
      )
    }))

  effect("checkpoints and compacts at the entry-count threshold, repeatedly", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      yield* emitMany(service, 0, 5)
      const first = yield* service.latestCheckpoint(run)
      expect(Option.getOrThrow(first).seq).toBe(4)
      expect(Option.getOrThrow(first).state).toEqual({ capturedAt: 4 })
      expect(Option.getOrThrow(first).compactedAtMs).not.toBeNull()
      expect(yield* eventCount).toBe(1)

      yield* emitMany(service, 5, 4)
      const second = yield* service.latestCheckpoint(run)
      expect(Option.getOrThrow(second).seq).toBe(8)
      expect(yield* eventCount).toBe(1)
    }).pipe(
      Effect.provide(journal({
        compaction: {
          entryThreshold: 5,
          capture: (_, upTo) => Effect.succeed({ capturedAt: upTo })
        }
      })),
      Effect.scoped
    ))

  effect("seeds the threshold from durable history, so a restart still compacts", () =>
    Effect.gen(function*() {
      yield* Effect.gen(function*() {
        const service = yield* Journal
        yield* emitMany(service, 0, 6)
      }).pipe(Effect.provide(journal()), Effect.scoped)

      yield* Effect.gen(function*() {
        const service = yield* Journal
        yield* service.emitDurableUnfenced(input(6))
        const latest = yield* service.latestCheckpoint(run)
        expect(Option.getOrThrow(latest).seq).toBe(6)
      }).pipe(
        Effect.provide(journal({
          compaction: { entryThreshold: 5, capture: () => Effect.succeed(null) }
        })),
        Effect.scoped
      )

      expect(yield* eventCount).toBe(1)
    }))

  effect("counts the lossy channel's committed batches toward the threshold", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      for (let index = 0; index < 3; index++) {
        yield* service.emitLossy(input(index))
      }
      yield* service.flush
      const latest = yield* service.latestCheckpoint(run)
      expect(Option.getOrThrow(latest).seq).toBe(2)
      expect(yield* eventCount).toBe(1)
    }).pipe(
      Effect.provide(journal({
        compaction: { entryThreshold: 3, capture: () => Effect.succeed(null) }
      })),
      Effect.scoped
    ))

  effect("an idempotent duplicate emit counts nothing toward the threshold", () =>
    Effect.gen(function*() {
      const service = yield* Journal
      const first = yield* service.emitDurableUnfenced(input(0))
      const duplicate = yield* service.emitDurableUnfenced(input(0))
      expect(duplicate.seq).toBe(first.seq)
      // Two emits, one committed entry: the duplicate reports zero committed
      // rows, so the threshold of 2 is never crossed.
      expect(Option.isNone(yield* service.latestCheckpoint(run))).toBe(true)
      expect(yield* eventCount).toBe(1)
    }).pipe(
      Effect.provide(journal({
        compaction: { entryThreshold: 2, capture: () => Effect.succeed(null) }
      })),
      Effect.scoped
    ))

  effect("a settlement while a compaction is in flight skips re-entry and still lands", () =>
    Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const reachedCapture = yield* Deferred.make<void>()
      yield* Effect.gen(function*() {
        const service = yield* Journal
        yield* service.emitLossy(input(0))
        yield* Deferred.await(reachedCapture)
        const next = yield* service.emitDurableUnfenced(input(2)).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const receipt = yield* Fiber.join(next)
        expect(receipt.seq).toBe(1)
        expect(Option.isNone(yield* service.latestCheckpoint(run))).toBe(true)
        yield* Deferred.succeed(gate, undefined)
        yield* service.flush
        const latest = yield* service.latestCheckpoint(run)
        expect(Option.getOrThrow(latest).seq).toBe(0)
        expect(yield* eventCount).toBe(2)
      }).pipe(
        Effect.provide(journal({
          compaction: {
            entryThreshold: 1,
            capture: () =>
              Deferred.succeed(reachedCapture, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.as(null)
              )
          }
        })),
        Effect.scoped
      )
    }))

  effect("serializes the policy counter across concurrent settlements", () =>
    Effect.gen(function*() {
      // `noteCommitted` seeds its per-run counter from a durable COUNT, and the
      // COUNT is an awaited read. Without a per-run permit two settlements that
      // overlapped both observed an unseeded counter, both issued the COUNT, and
      // the later reply overwrote the newer count with a stale one: measured with
      // `entryThreshold: 10`, ten committed events produced zero capture calls
      // and no checkpoint. The discriminating assertion is the number of seeding
      // COUNTs: exactly one per run, however many settlements race.
      const seeds: Array<string> = []
      const captured: Array<number> = []
      yield* Effect.gen(function*() {
        const service = yield* Journal
        const first = yield* service.emitDurableUnfenced(input(0)).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const second = yield* service.emitDurableUnfenced(input(1)).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        expect(seeds).toHaveLength(1)

        // And the counter still reaches the threshold, which the lost count
        // suppressed entirely. The overlapping pair is counted twice, because
        // the seeding COUNT already saw both rows and the second settlement
        // then added its own, so the attempt lands one commit EARLY rather than
        // never: over-counting is the safe direction, and `policyCompact`
        // re-seeds from a fresh COUNT so it does not accumulate.
        yield* emitMany(service, 2, 8)
        expect(captured).toEqual([8])
        expect(Option.getOrThrow(yield* service.latestCheckpoint(run)).seq).toBe(8)
      }).pipe(
        Effect.provide(journal(
          {
            compaction: {
              entryThreshold: 10,
              capture: (_, upTo) =>
                Effect.sync(() => {
                  captured.push(upTo)
                  return null
                })
            }
          },
          overlappingCounts(seeds, 2)
        )),
        Effect.scoped
      )
    }))

  effect("interrupting a caller parked in capture propagates the interruption", () =>
    Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const reachedCapture = yield* Deferred.make<void>()
      yield* Effect.gen(function*() {
        const service = yield* Journal
        const crossing = yield* service.emitDurableUnfenced(input(0)).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(reachedCapture)
        yield* Fiber.interrupt(crossing)
        // The interruption is not damped into a retry: no checkpoint was
        // captured, and the committed entry survives untouched.
        expect(Option.isNone(yield* service.latestCheckpoint(run))).toBe(true)
        expect(yield* eventCount).toBe(1)
      }).pipe(
        Effect.provide(journal({
          compaction: {
            entryThreshold: 1,
            capture: () =>
              Deferred.succeed(reachedCapture, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.as(null)
              )
          }
        })),
        Effect.scoped
      )
    }))

  effect("an interrupt-only policy attempt propagates without damping", () =>
    Effect.gen(function*() {
      yield* Effect.gen(function*() {
        const service = yield* Journal
        const exit = yield* Effect.exit(service.emitDurableUnfenced(input(0)))
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(Option.isNone(yield* service.latestCheckpoint(run))).toBe(true)
        expect(yield* eventCount).toBe(1)
      }).pipe(
        Effect.provide(journal({
          compaction: {
            entryThreshold: 1,
            capture: () => Effect.interrupt
          }
        })),
        Effect.scoped
      )
    }))

  effect("a policy attempt over a run whose durable tail vanished stands down", () =>
    Effect.gen(function*() {
      let calls = 0
      const captured: Array<unknown> = []
      yield* Effect.gen(function*() {
        const service = yield* Journal
        // A concurrent process compacted-and-truncated between this process's
        // commit and its tail read: MAX(seq) comes back NULL (first attempt)
        // or the row itself is gone (second attempt). Both stand down.
        yield* service.emitDurableUnfenced(input(0))
        yield* service.emitDurableUnfenced(input(1))
        expect(captured).toEqual([])
        expect(Option.isNone(yield* service.latestCheckpoint(run))).toBe(true)
      }).pipe(
        Effect.provide(journal(
          {
            compaction: {
              entryThreshold: 1,
              capture: (_, upTo) =>
                Effect.sync(() => {
                  captured.push(upTo)
                  return null
                })
            }
          },
          stubbedRows(
            (text) => text.includes("MAX(seq) AS last"),
            () => {
              calls += 1
              return calls === 1 ? [{ last: null }] : []
            }
          )
        )),
        Effect.scoped
      )
      expect(calls).toBe(2)
    }))

  effect("a threshold count that yields no row seeds to zero and still compacts", () =>
    Effect.gen(function*() {
      yield* Effect.gen(function*() {
        const service = yield* Journal
        // The seed count comes back rowless, so the first commit seeds zero
        // and the second commit crosses the threshold.
        yield* service.emitDurableUnfenced(input(0))
        expect(Option.isNone(yield* service.latestCheckpoint(run))).toBe(true)
        yield* service.emitDurableUnfenced(input(1))
        const latest = yield* service.latestCheckpoint(run)
        expect(Option.getOrThrow(latest).seq).toBe(1)
        expect(Option.getOrThrow(latest).compactedAtMs).not.toBeNull()
      }).pipe(
        Effect.provide(journal(
          {
            compaction: { entryThreshold: 1, capture: () => Effect.succeed(null) }
          },
          stubbedRows(
            (text) => text.includes("COUNT(*) AS total FROM flows_journal_events"),
            () => []
          )
        )),
        Effect.scoped
      )
    }))

  effect("a failing threshold seed is logged and never fails the emit", () =>
    Effect.gen(function*() {
      yield* Effect.gen(function*() {
        const service = yield* Journal
        const durable = yield* service.emitDurableUnfenced(input(0))
        expect(durable.seq).toBe(0)
        // The bookkeeping defect is logged and swallowed: nothing was
        // checkpointed, and the emit itself settled durably.
        expect(Option.isNone(yield* service.latestCheckpoint(run))).toBe(true)
      }).pipe(
        Effect.provide(journal(
          { compaction: { entryThreshold: 1, capture: () => Effect.succeed(null) } },
          crashingDatabase("COUNT(*) AS total FROM flows_journal_events", () => true)
        )),
        Effect.scoped
      )
      expect(yield* eventCount).toBe(1)
    }))

  effect("a failed capture never fails the emit, and the policy retries later", () =>
    Effect.gen(function*() {
      let attempts = 0
      yield* Effect.gen(function*() {
        const service = yield* Journal
        // Attempt 1 fails; the damped counter restarts, so the next attempt
        // happens only after `entryThreshold` further commits.
        yield* emitMany(service, 0, 2)
        expect(attempts).toBe(1)
        expect(yield* eventCount).toBe(2)
        expect(Option.isNone(yield* service.latestCheckpoint(run))).toBe(true)

        yield* emitMany(service, 2, 2)
        expect(attempts).toBe(2)
        const latest = yield* service.latestCheckpoint(run)
        expect(Option.getOrThrow(latest).seq).toBe(3)
        expect(yield* eventCount).toBe(1)
      }).pipe(
        Effect.provide(journal({
          compaction: {
            entryThreshold: 2,
            capture: () =>
              Effect.suspend(() => {
                attempts += 1
                return attempts === 1
                  ? Effect.fail(new Error("capture unavailable"))
                  : Effect.succeed(null)
              })
          }
        })),
        Effect.scoped
      )
    }))
})
