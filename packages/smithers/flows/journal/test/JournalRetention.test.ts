import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Deferred, Effect, Layer, PubSub } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as Statement from "effect/unstable/sql/Statement"
import { Journal, JournalError } from "../src/Journal.ts"
import { Input, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId
const sourceSeq = (value: number): SourceSeq => value as SourceSeq

const run = runId("run")
const source = sourceId("producer")

const input = (sequence: number): Input =>
  new Input({
    runId: run,
    sourceId: source,
    sourceSeq: sourceSeq(sequence),
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

const keepSql: Layer.Layer<SqlClient.SqlClient, never, SqlClient.SqlClient> = Layer.effect(
  SqlClient.SqlClient,
  Effect.service(SqlClient.SqlClient)
)

/** Records every compiled statement so the startup load can be inspected. */
const recordingDatabase = (queries: Array<string>): DatabaseDecorator =>
  Layer.merge(
    Layer.effect(
      SqlClient.SqlClient,
      Effect.gen(function*() {
        const base = yield* Effect.service(SqlClient.SqlClient)
        return new Proxy(base, {
          apply(target, thisArgument, argumentsList) {
            const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
            if (typeof statement.compile === "function") {
              queries.push(statement.compile()[0].replace(/\$\d+/g, "?"))
            }
            return statement
          }
        }) as SqlClient.SqlClient
      })
    ),
    keepWriter
  )

/** Forces a scheduling boundary after each lazy allocation-floor read. */
const yieldingFloorDatabase: DatabaseDecorator = Layer.merge(
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function*() {
      const base = yield* Effect.service(SqlClient.SqlClient)
      return new Proxy(base, {
        apply(target, thisArgument, argumentsList) {
          const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
          if (
            typeof statement.compile !== "function" || !statement.compile()[0].replace(/\$\d+/g, "?").includes("MAX(")
          ) {
            return statement
          }
          return statement.pipe(Effect.tap(() => Effect.yieldNow))
        }
      }) as SqlClient.SqlClient
    })
  ),
  keepWriter
)

const journal = (
  options: SqlJournal.SqlJournalOptions,
  database?: DatabaseDecorator
) =>
  database === undefined
    ? SqlJournal.layer(options)
    : SqlJournal.layer(options).pipe(Layer.provide(database))

const eventCount = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const rows = yield* sql<{ readonly total: number }>`
    SELECT COUNT(*) AS total FROM flows_journal_events
  `
  return Number(rows[0]!.total)
})

const seed = (count: number, options: SqlJournal.SqlJournalOptions) =>
  Effect.gen(function*() {
    const service = yield* Journal
    for (let index = 0; index < count; index++) {
      yield* service.emitLossy(input(index))
    }
    yield* service.flush
  }).pipe(Effect.provide(journal(options)), Effect.scoped)

describe("SqlJournal source-event retention", () => {
  effect("bounds the startup load instead of decoding every historical event", () =>
    Effect.gen(function*() {
      yield* seed(6, { capacity: 64, overflow: "reject" })
      const queries: Array<string> = []
      const receipts = yield* Effect.gen(function*() {
        const service = yield* Journal
        return {
          oldest: yield* service.emitLossy(input(0)),
          newest: yield* service.emitLossy(input(5))
        }
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 2 }, recordingDatabase(queries))),
        Effect.scoped
      )
      const load = queries.find((query) =>
        query.includes("FROM flows_journal_events") && !query.includes("MAX(") && !query.includes("INSERT")
      )
      expect(load).toBeDefined()
      expect(load).toContain("LIMIT")
      // The retained window answers from memory. Everything older is admitted
      // optimistically, because admission reads nothing at all, and collapses
      // onto the committed row at the insert instead.
      expect(receipts.newest._tag).toBe("Duplicate")
      expect(receipts.oldest._tag).toBe("Accepted")
      // Either way the table keeps one row per identity: the count is taken
      // after the layer's own closing flush has drained the optimistic entry.
      expect(yield* eventCount).toBe(6)
    }))

  effect("evicts committed entries once the index exceeds the bound", () =>
    Effect.gen(function*() {
      const receipts = yield* Effect.gen(function*() {
        const service = yield* Journal
        for (let index = 0; index < 5; index++) {
          yield* service.emitLossy(input(index))
        }
        yield* service.flush
        return {
          oldest: yield* service.emitLossy(input(0)),
          newest: yield* service.emitLossy(input(4))
        }
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 2 })),
        Effect.scoped
      )
      expect(receipts.newest._tag).toBe("Duplicate")
      // Evicted, so the index cannot answer it and the insert does.
      expect(receipts.oldest._tag).toBe("Accepted")
      expect(yield* eventCount).toBe(5)
    }))

  effect("never evicts an uncommitted entry, so pending dedup still holds", () =>
    Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const database: DatabaseDecorator = Layer.merge(
        Layer.effect(
          DurableWriter,
          Effect.gen(function*() {
            const inner = yield* DurableWriter
            return DurableWriter.of({
              write: (write) => Deferred.await(gate).pipe(Effect.andThen(inner.write(write)))
            })
          })
        ),
        keepSql
      )
      const receipts = yield* Effect.gen(function*() {
        const service = yield* Journal
        for (let index = 0; index < 4; index++) {
          yield* service.emitLossy(input(index))
        }
        const observed = yield* Effect.forEach([0, 1, 2, 3], (index) => service.emitLossy(input(index)))
        yield* Deferred.succeed(gate, undefined)
        yield* service.flush
        return observed
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 1 }, database)),
        Effect.scoped
      )
      expect(receipts.map((receipt) => receipt._tag)).toEqual([
        "Duplicate",
        "Duplicate",
        "Duplicate",
        "Duplicate"
      ])
    }))

  effect("rejects a non-positive source-event cache bound", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(
        Effect.scoped(
          Effect.provide(Effect.void, journal({ capacity: 8, overflow: "reject", sourceEventCache: 0 }))
        )
      )
      expect(failure).toBeInstanceOf(JournalError)
      expect((failure as JournalError).code).toBe("invalid_event")
    }))
})

describe("SqlJournal allocation-floor index bounds (B9)", () => {
  effect("aggregates no run history at construction", () =>
    Effect.gen(function*() {
      yield* seed(6, { capacity: 64, overflow: "reject" })
      const queries: Array<string> = []
      const atConstruction = yield* Effect.gen(function*() {
        yield* Journal
        return [...queries]
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 2 }, recordingDatabase(queries))),
        Effect.scoped
      )

      // The `sequences` and `sourceSequences` floors used to be seeded by two
      // unbounded `GROUP BY` aggregations — one entry per run that ever wrote
      // an event, one per (run, source) pair — so construction scanned the
      // whole table and built a map proportional to total history whatever
      // `sourceEventCache` said. The startup load is now the bounded
      // source-event window and nothing else.
      expect(atConstruction.filter((query) => query.includes("GROUP BY"))).toEqual([])
      const load = atConstruction.filter((query) => query.includes("FROM flows_journal_events"))
      expect(load).toHaveLength(1)
      expect(load[0]).toContain("LIMIT")
    }))

  effect("reads a run's allocation floor on first use, and only once", () =>
    Effect.gen(function*() {
      yield* seed(3, { capacity: 64, overflow: "reject" })
      const queries: Array<string> = []
      const receipts = yield* Effect.gen(function*() {
        const service = yield* Journal
        return {
          first: yield* service.emitLossy(input(3)),
          second: yield* service.emitLossy(input(4))
        }
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 2 }, recordingDatabase(queries))),
        Effect.scoped
      )

      // Dropping the seed cannot restart allocation at zero: the floor the
      // aggregation used to precompute is read from the same durable
      // `MAX(...) + 1` on first use.
      expect(receipts.first).toMatchObject({ seq: 3, sourceSeq: 3 })
      expect(receipts.second).toMatchObject({ seq: 4, sourceSeq: 4 })
      // And it is cached: the second emit on the same run re-reads nothing.
      expect(queries.filter((query) => query.includes("MAX(seq) + 1"))).toHaveLength(1)
    }))

  effect("serializes concurrent first-use allocation-floor reads", () =>
    Effect.gen(function*() {
      const result = yield* Effect.gen(function*() {
        const service = yield* Journal
        const receipts = yield* Effect.all(
          [service.emitLossy(input(0)), service.emitLossy(input(1))],
          { concurrency: "unbounded" }
        )
        yield* service.flush
        const page = yield* service.entries({ runId: run, limit: 10 })
        return { receipts, entries: page.entries }
      }).pipe(
        Effect.provide(
          journal(
            { capacity: 64, overflow: "reject", sourceEventCache: 2 },
            yieldingFloorDatabase
          )
        ),
        Effect.scoped
      )

      // Lazy initialization crosses an asynchronous SQL boundary. Without an
      // allocation permit, both first emits can read seq 0 before either one
      // raises the in-process floor, queue duplicate canonical sequences, and
      // lose the batch to `sequence_conflict` at flush.
      expect(result.receipts.map((receipt) => receipt.seq)).toEqual([0, 1])
      expect(result.entries.map((entry) => entry.seq)).toEqual([0, 1])
    }))
})

describe("SqlJournal canonical idempotency fingerprints", () => {
  const ordered = (sequence: number, reverse: boolean): Input =>
    new Input({
      runId: run,
      sourceId: source,
      sourceSeq: sourceSeq(sequence),
      eventType: "canonical",
      payload: reverse
        ? { z: 1, nested: { y: 2, x: 3 }, a: 4 }
        : { a: 4, nested: { x: 3, y: 2 }, z: 1 },
      meta: reverse ? { second: 2, first: 1 } : { first: 1, second: 2 }
    }, { disableChecks: true })

  effect("deduplicates reordered payloads and metadata on both channels", () =>
    Effect.gen(function*() {
      yield* Effect.gen(function*() {
        const service = yield* Journal
        const durable = yield* service.emitDurableUnfenced(ordered(100, true))
        expect(yield* service.emitDurableUnfenced(ordered(100, false))).toEqual({
          _tag: "Duplicate",
          seq: durable.seq,
          sourceSeq: 100,
          status: "committed"
        })

        const lossy = yield* service.emitLossy(ordered(101, true))
        yield* service.flush
        expect(yield* service.emitLossy(ordered(101, false))).toEqual({
          _tag: "Duplicate",
          seq: lossy.seq,
          sourceSeq: 101,
          status: "committed"
        })

        const distinct = yield* Effect.flip(
          service.emitDurableUnfenced(
            new Input({
              runId: run,
              sourceId: source,
              sourceSeq: sourceSeq(100),
              eventType: "canonical",
              payload: { a: 5, nested: { x: 3, y: 2 }, z: 1 },
              meta: { first: 1, second: 2 }
            }, { disableChecks: true })
          )
        )
        expect(distinct.code).toBe("idempotency_conflict")
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 8 })),
        Effect.scoped
      )
    }))

  effect("keeps reordered retries canonical after a fresh journal layer", () =>
    Effect.gen(function*() {
      const original = yield* Effect.gen(function*() {
        const service = yield* Journal
        const durable = yield* service.emitDurableUnfenced(ordered(200, true))
        const lossy = yield* service.emitLossy(ordered(201, true))
        yield* service.flush
        return { durable, lossy }
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 8 })),
        Effect.scoped
      )

      yield* Effect.gen(function*() {
        const service = yield* Journal
        expect(yield* service.emitDurableUnfenced(ordered(200, false))).toEqual({
          _tag: "Duplicate",
          seq: original.durable.seq,
          sourceSeq: 200,
          status: "committed"
        })
        expect(yield* service.emitLossy(ordered(201, false))).toEqual({
          _tag: "Duplicate",
          seq: original.lossy.seq,
          sourceSeq: 201,
          status: "committed"
        })
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 8 })),
        Effect.scoped
      )
    }))
})

/**
 * An explicit producer identity the bounded index has evicted is admitted
 * optimistically: admission reads nothing, and the unique index
 * `(run_id, source_id, source_seq)` settles it at the insert.
 */
describe("SqlJournal dedup behind an evicted index entry", () => {
  effect(
    "admits an evicted identity without reading, and collapses it at the insert",
    () =>
      Effect.gen(function*() {
        yield* seed(5, { capacity: 64, overflow: "reject" })
        const queries: Array<string> = []
        const outcome = yield* Effect.gen(function*() {
          const service = yield* Journal
          const subscription = yield* service.changes
          queries.length = 0
          const receipt = yield* service.emitLossy(input(0))
          const firstAdmission = [...queries]
          queries.length = 0
          const second = yield* service.emitLossy(input(1))
          const secondAdmission = [...queries]
          yield* service.flush
          return {
            receipt,
            second,
            firstAdmission,
            secondAdmission,
            published: yield* PubSub.remaining(subscription),
            queries: [...queries]
          }
        }).pipe(
          Effect.provide(journal(
            { capacity: 64, overflow: "reject", sourceEventCache: 2 },
            recordingDatabase(queries)
          )),
          Effect.scoped
        )

        // The whole point: no dedup lookup between the caller's emit and the
        // queue. The one statement a first admission for a run still issues is
        // the canonical floor read, which is cached from then on, so the
        // second admission reads nothing at all. A producer flushing from
        // inside somebody else's open write transaction cannot deadlock
        // against statements that are never issued.
        expect(outcome.firstAdmission.map((query) => query.trim())).toEqual([
          "SELECT MAX(seq) + 1 AS next FROM flows_journal_events WHERE run_id = ?"
        ])
        expect(outcome.secondAdmission).toEqual([])
        expect(outcome.receipt).toMatchObject({ _tag: "Accepted", sourceSeq: 0 })
        expect(outcome.second).toMatchObject({ _tag: "Accepted", sourceSeq: 1 })
        // The insert is the admission decision, and the identity lookup runs
        // only on the rows it refused.
        expect(outcome.queries.filter((query) => query.includes("INSERT INTO flows_journal_events")))
          .toHaveLength(2)
        expect(outcome.queries.filter((query) => query.includes("WHERE event_id"))).toHaveLength(2)
        // A collapsed entry is not a new entry: nothing is published and the
        // table still holds the five originals.
        expect(outcome.published).toBe(0)
        expect(yield* eventCount).toBe(5)
      })
  )

  effect("reports a changed retry behind an evicted entry through the flush", () =>
    Effect.gen(function*() {
      yield* seed(5, { capacity: 64, overflow: "reject" })
      const outcome = yield* Effect.gen(function*() {
        const service = yield* Journal
        const subscription = yield* service.changes
        const receipt = yield* service.emitLossy(
          new Input({
            runId: run,
            sourceId: source,
            sourceSeq: sourceSeq(0),
            eventType: "event",
            payload: { value: "changed" }
          }, { disableChecks: true })
        )
        const failure = yield* Effect.flip(service.flush)
        return { receipt, failure, published: yield* PubSub.remaining(subscription) }
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 2 })),
        Effect.scoped
      )

      // Admission cannot classify what it does not read, so a reused identity
      // carrying different bytes is refused by the insert and reported to
      // whoever waits on the flush. The committed row is untouched either way,
      // which is the property that matters: a duplicate is dropped, never the
      // original.
      expect(outcome.receipt).toMatchObject({ _tag: "Accepted", sourceSeq: 0 })
      expect(outcome.failure).toBeInstanceOf(JournalError)
      expect((outcome.failure as JournalError).code).toBe("idempotency_conflict")
      expect(outcome.published).toBe(0)
      expect(yield* eventCount).toBe(5)
    }))

  effect("keeps a producer that owns its identity out of the conflict path", () =>
    Effect.gen(function*() {
      const identified = (sequence: number, value: unknown): Input =>
        new Input({
          runId: run,
          sourceId: source,
          sourceSeq: sourceSeq(sequence),
          dedupe: "identity",
          eventType: "event",
          payload: { value }
        }, { disableChecks: true })
      const receipts = yield* Effect.gen(function*() {
        const service = yield* Journal
        const first = yield* service.emitLossy(identified(0, "recorded"))
        yield* service.flush
        // Evict entry 0 from the bounded index, so the re-emission below is
        // settled by the constraint rather than by memory.
        yield* service.emitLossy(identified(1, 1))
        yield* service.emitLossy(identified(2, 2))
        yield* service.flush
        const evicted = yield* service.emitLossy(identified(0, "replayed"))
        yield* service.flush
        // And once more from the index, which is holding entry 0 again.
        const cached = yield* service.emitLossy(identified(0, "replayed twice"))
        yield* service.flush
        return { first, evicted, cached }
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 2 })),
        Effect.scoped
      )

      expect(receipts.first._tag).toBe("Accepted")
      expect(receipts.evicted._tag).toBe("Accepted")
      expect(receipts.cached).toMatchObject({ _tag: "Duplicate", seq: 0, sourceSeq: 0 })
      // Three rows, and the first observation of identity 0 is the one that
      // stands: re-emitting an event whose sequence is derived from the event
      // never rewrites and never doubles the record of it.
      expect(yield* eventCount).toBe(3)
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const rows = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM flows_journal_events WHERE source_seq = 0
      `
      expect(rows.map((row) => row.payload_json)).toEqual(["{\"value\":\"recorded\"}"])
    }))

  effect(
    "keeps cache hits and implicit producer sequences off every admission read",
    () =>
      Effect.gen(function*() {
        const queries: Array<string> = []
        yield* Effect.gen(function*() {
          const service = yield* Journal
          yield* service.emitLossy(input(0))
          yield* service.flush

          queries.length = 0
          expect((yield* service.emitLossy(input(0)))._tag).toBe("Duplicate")
          expect(queries).toEqual([])

          queries.length = 0
          yield* service.emitLossy(
            new Input({
              runId: run,
              sourceId: source,
              eventType: "implicit",
              payload: { value: 1 }
            }, { disableChecks: true })
          )
          expect(queries.some((query) => query.includes("WHERE event_id"))).toBe(false)
          yield* service.flush
        }).pipe(
          Effect.provide(journal(
            { capacity: 64, overflow: "reject", sourceEventCache: 2 },
            recordingDatabase(queries)
          )),
          Effect.scoped
        )
      })
  )

  effect(
    "loses the batch, not the admission, when the sink cannot insert",
    () =>
      Effect.gen(function*() {
        yield* Effect.gen(function*() {
          const service = yield* Journal
          yield* service.emitLossy(input(0))
          yield* service.flush

          const sql = yield* Effect.service(SqlClient.SqlClient)
          yield* sql`DROP TABLE flows_journal_events ${
            sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
          }`

          // Admission still succeeds: it touches no table. The dead sink is
          // reported where the write actually happens.
          expect((yield* service.emitLossy(input(1)))._tag).toBe("Accepted")
          const failure = yield* Effect.flip(service.flush)
          expect(failure.code).toBe("sink_failed")
          expect(failure.message).toBe("journal sink failed")
        }).pipe(
          Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 1 })),
          Effect.scoped
        )
      })
  )
})
