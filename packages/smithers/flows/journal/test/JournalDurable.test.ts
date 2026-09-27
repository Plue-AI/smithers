import { describe, expect, it } from "@effect/vitest"
import { DatabaseError, DurableWriter, layer as writerLayer } from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Context, Effect, Fiber, Layer, Option, PubSub, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Journal, JournalError, makeNoop, type Service } from "../src/Journal.ts"
import { Input, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId
const sourceSeq = (value: number): SourceSeq => value as SourceSeq

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

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const options: SqlJournal.SqlJournalOptions = { capacity: 8, overflow: "reject" }

const journalLayer = (overrides: Partial<SqlJournal.SqlJournalOptions> = {}) =>
  SqlJournal.layer({ ...options, ...overrides }).pipe(Layer.provideMerge(migratedDatabase))

const withJournal = <A, E>(
  body: Effect.Effect<A, E, Journal | DurableWriter | SqlClient.SqlClient>,
  overrides: Partial<SqlJournal.SqlJournalOptions> = {}
) => Effect.scoped(body.pipe(Effect.provide(journalLayer(overrides))))

const seqsOf = (sql: SqlClient.SqlClient, run: RunId) =>
  sql<{ readonly seq: number }>`
    SELECT seq FROM flows_journal_events WHERE run_id = ${run} ORDER BY seq ASC
  `

/** Re-provides the current client/writer pair as a layer for a second journal instance. */
const sharedContext = Effect.map(
  Effect.all([Effect.service(SqlClient.SqlClient), Effect.service(DurableWriter)]),
  ([sql, writer]) =>
    Layer.merge(
      Layer.succeed(SqlClient.SqlClient)(sql),
      Layer.succeed(DurableWriter)(writer)
    )
)

describe("SqlJournal durable emission", () => {
  effect("emitDurable returns a committed sequence", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const receipt = yield* journal.emitDurableUnfenced(input(runId("run"), sourceId("s"), "created", { a: 1 }))
        expect(receipt._tag).toBe("Accepted")
        const rows = yield* seqsOf(sql, runId("run"))
        expect(rows.map((row) => row.seq)).toEqual([receipt.seq])
      })
    ))

  effect("emitDurable allocates gapless sequences across independent writers", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const shared = yield* sharedContext
        const build = Effect.map(
          Layer.build(SqlJournal.layer(options).pipe(Layer.provide(shared))),
          (context) => Context.get(context, Journal) as Service
        )
        const left = yield* build
        const right = yield* build
        const run = runId("shared")
        yield* left.emitDurableUnfenced(input(run, sourceId("left"), "l0", 0))
        yield* right.emitDurableUnfenced(input(run, sourceId("right"), "r0", 0))
        yield* left.emitDurableUnfenced(input(run, sourceId("left"), "l1", 1))
        yield* right.emitDurableUnfenced(input(run, sourceId("right"), "r1", 1))
        const rows = yield* seqsOf(sql, run)
        expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3])
      }).pipe(Effect.provide(migratedDatabase))
    ))

  effect("a live follower observes a commit made by another journal instance", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const shared = yield* sharedContext
        const build = Effect.map(
          Layer.build(SqlJournal.layer(options).pipe(Layer.provide(shared))),
          (context) => Context.get(context, Journal) as Service
        )
        const follower = yield* build
        const writer = yield* build
        const run = runId("cross-process-follow")
        const next = yield* follower.stream({ runId: run }).pipe(
          Stream.runHead,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        yield* writer.emitDurableUnfenced(input(run, sourceId("peer"), "committed-elsewhere", 1))
        yield* TestClock.adjust("1 second")
        const entry = Option.getOrThrow(yield* Fiber.join(next))
        expect(entry.eventType).toBe("committed-elsewhere")
      }).pipe(Effect.provide(migratedDatabase))
    ))

  effect("emitDurable is idempotent for an exact producer retry", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const first = yield* journal.emitDurableUnfenced(
          input(runId("run"), sourceId("s"), "created", { a: 1 }, sourceSeq(0))
        )
        const second = yield* journal.emitDurableUnfenced(
          input(runId("run"), sourceId("s"), "created", { a: 1 }, sourceSeq(0))
        )
        expect(second).toEqual({ _tag: "Duplicate", seq: first.seq, sourceSeq: 0, status: "committed" })
      })
    ))

  effect("emitDurable rejects a reused producer sequence with different content", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* journal.emitDurableUnfenced(input(runId("run"), sourceId("s"), "created", { a: 1 }, sourceSeq(0)))
        const failure = yield* Effect.flip(
          journal.emitDurableUnfenced(input(runId("run"), sourceId("s"), "created", { a: 2 }, sourceSeq(0)))
        )
        expect(failure).toBeInstanceOf(JournalError)
        expect((failure as JournalError).code).toBe("idempotency_conflict")
      })
    ))

  effect("durable entries are readable and continue the in-memory clock", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* journal.emitDurableUnfenced(input(runId("run"), sourceId("s"), "created", 1))
        const queued = yield* journal.emitLossy(input(runId("run"), sourceId("s"), "queued", 2))
        expect(queued.seq).toBe(1)
        yield* journal.flush
        const page = yield* journal.entries({ runId: runId("run"), limit: 10 })
        expect(page.entries.map((entry) => entry.seq)).toEqual([0, 1])
      })
    ))

  effect("emitDurable validates its input", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const failure = yield* Effect.flip(journal.emitDurableUnfenced(input(runId(""), sourceId("s"), "x", 1)))
        expect((failure as JournalError).code).toBe("invalid_event")
      })
    ))

  effect("emitDurable rejects a producer sequence at the allocation ceiling", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const failure = yield* Effect.flip(
          journal.emitDurableUnfenced(
            input(runId("run"), sourceId("s"), "x", 1, sourceSeq(Number.MAX_SAFE_INTEGER))
          )
        )
        expect((failure as JournalError).code).toBe("invalid_event")
      })
    ))

  effect("emitDurable rejects a canonical sequence at the allocation ceiling", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`
          INSERT INTO flows_journal_events (
            run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
            event_type, payload_json, meta_json
          ) VALUES (
            'run', ${Number.MAX_SAFE_INTEGER - 1}, 'ceiling', 'other', 0, 0, 'x', '1', 'null'
          )
        `
        const failure = yield* Effect.flip(journal.emitDurableUnfenced(input(runId("run"), sourceId("s"), "x", 1)))
        expect((failure as JournalError).code).toBe("invalid_event")
      })
    ))

  effect("emitDurable reports a failed sink", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`DROP TABLE flows_journal_events ${
          sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
        }`
        const failure = yield* Effect.flip(journal.emitDurableUnfenced(input(runId("run"), sourceId("s"), "x", 1)))
        expect((failure as JournalError).code).toBe("sink_failed")
      })
    ))

  effect("emitDurable publishes nothing when the transaction fails at commit", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const shared = yield* sharedContext
        // Models a COMMIT-time failure: the body (including the INSERT) runs to
        // completion, then the transaction aborts and rolls the row back.
        const commitFails = Layer.merge(
          Layer.succeed(SqlClient.SqlClient)(sql),
          Layer.succeed(DurableWriter)(
            DurableWriter.of({
              write: (effect) =>
                writer.write(
                  Effect.flatMap(effect, () =>
                    Effect.fail(
                      // A permanent COMMIT rejection, not a transient lock:
                      // normalized busy errors correctly retry under TestClock.
                      new DatabaseError({ code: "constraint" })
                    ))
                ) as never
            })
          )
        )
        const journal = yield* Effect.map(
          Layer.build(SqlJournal.layer(options).pipe(Layer.provide(commitFails))),
          (context) => Context.get(context, Journal) as Service
        )
        const subscription = yield* journal.changes
        const run = runId("commit-failure")
        yield* Effect.flip(journal.emitDurableUnfenced(input(run, sourceId("s"), "created", 1)))
        expect(yield* PubSub.remaining(subscription)).toBe(0)
        const rows = yield* seqsOf(sql, run)
        expect(rows).toEqual([])
        // The rolled-back sequence must not become an in-memory allocation
        // floor: the next successful write still starts at 0.
        const healthy = yield* Effect.map(
          Layer.build(SqlJournal.layer(options).pipe(Layer.provide(shared))),
          (context) => Context.get(context, Journal) as Service
        )
        expect((yield* healthy.emitDurableUnfenced(input(run, sourceId("s"), "created", 1))).seq).toBe(0)
      }).pipe(Effect.provide(migratedDatabase))
    ))

  effect("emitDurable rejects a closed journal", () =>
    Effect.gen(function*() {
      const journal = yield* Effect.scoped(
        Effect.map(
          Layer.build(journalLayer()),
          (context) => Context.get(context, Journal) as Service
        )
      )
      const failure = yield* Effect.flip(journal.emitDurableUnfenced(input(runId("run"), sourceId("s"), "x", 1)))
      expect((failure as JournalError).code).toBe("journal_closed")
    }))

  effect("the noop journal reports emitDurable as unavailable", () =>
    Effect.gen(function*() {
      const journal = makeNoop()
      const failure = yield* Effect.flip(
        journal.emitDurable(input(runId("run"), sourceId("s"), "x", 1), { hostId: "test", pid: 1, nonce: "test" })
      )
      expect((failure as JournalError).code).toBe("journal_closed")
    }))
})

/**
 * These cases need a real file and a real Clock: the deferred-transaction
 * allocation documented in `docs/pages/concepts/journal.md` relies on the
 * SQLite busy/snapshot retry in `@smthrs/database`, whose backoff sleeps.
 */
describe("SqlJournal durable emission across connections", () => {
  const withTempFile = <A, E>(body: (filename: string) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "flows-journal-durable-"))),
      (directory) => body(join(directory, "journal.sqlite")),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
    )

  const migrated = (filename: string) =>
    Layer.provideMerge(
      Migrations.layer,
      Layer.provideMerge(writerLayer(), NodeDatabase.layer({ filename }))
    )

  const connection = (filename: string) =>
    Effect.map(
      Layer.build(SqlJournal.layer({ ...options, capacity: 64 }).pipe(Layer.provide(migrated(filename)))),
      (context) => Context.get(context, Journal) as Service
    )

  // Two real connections both hit BEGIN contention on the same SQLite file,
  // and Effect's SqlClient.makeWithTransaction issues ROLLBACK even when
  // BEGIN itself failed, raising "cannot rollback - no transaction is active"
  // (Effect-TS/effect#7235, fixed by Effect-TS/effect#7236 and first released
  // in effect@4.0.0-rc.109 — this workspace pins rc.108, so it is still live).
  // `withWriteRetry` classifies that defect as transient write contention and
  // retries it, so this holds as a real assertion.
  // Actual cross-connection contention sleeps between retries. A frozen test
  // clock with no adjuster hangs as soon as the first busy error is observed.
  it.live(
    "emitDurable never collides when two connections write one run concurrently",
    () =>
      withTempFile((filename) =>
        Effect.scoped(
          Effect.gen(function*() {
            // Migrate once so both writers open an already-provisioned file.
            yield* Effect.scoped(Effect.provide(Effect.void, migrated(filename)))
            const left = yield* connection(filename)
            const right = yield* connection(filename)
            const run = runId("shared")
            const writes = 8
            const emit = (journal: Service, source: string) =>
              Effect.forEach(
                Array.from({ length: writes }, (_, index) => index),
                (index) => journal.emitDurableUnfenced(input(run, sourceId(source), `${source}${index}`, index)),
                { discard: true }
              )
            yield* Effect.all([emit(left, "left"), emit(right, "right")], { concurrency: 2, discard: true })
            yield* Effect.scoped(
              Effect.provide(
                Effect.gen(function*() {
                  const sql = yield* Effect.service(SqlClient.SqlClient)
                  const rows = yield* seqsOf(sql, run)
                  expect(rows.map((row) => row.seq)).toEqual(
                    Array.from({ length: writes * 2 }, (_, index) => index)
                  )
                }),
                migrated(filename)
              )
            )
          })
        )
      ),
    30_000
  )

  it.effect(
    "emitDurable resumes from the durable floor after a restart",
    () =>
      withTempFile((filename) =>
        Effect.gen(function*() {
          const run = runId("restarted")
          yield* Effect.scoped(
            Effect.gen(function*() {
              const journal = yield* connection(filename)
              yield* journal.emitDurableUnfenced(input(run, sourceId("s"), "first", 0))
              yield* journal.emitDurableUnfenced(input(run, sourceId("s"), "second", 1))
            })
          )
          // A cold process: the in-memory clock starts at zero and the SQL
          // floor must win, otherwise the (run_id, seq) primary key collides.
          yield* Effect.scoped(
            Effect.gen(function*() {
              const journal = yield* connection(filename)
              const receipt = yield* journal.emitDurableUnfenced(input(run, sourceId("s"), "third", 2))
              expect(receipt.seq).toBe(2)
              expect(receipt.sourceSeq).toBe(2)
            })
          )
        })
      ),
    30_000
  )
})
