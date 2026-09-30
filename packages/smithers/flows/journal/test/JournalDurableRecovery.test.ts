import * as TestDatabase from "@smthrs/database/test/TestDatabase"
/**
 * Injected-defect rollback and corruption recovery on file-backed SQLite.
 *
 * Effect.die still unwinds the transaction and connection scopes. These tests
 * prove orderly rollback and reopen; `JournalProcessDeath.test.ts` covers
 * abrupt termination before COMMIT and after acknowledgment with SIGKILL.
 *
 * Prior art: Temporal, whose readers of damaged history fail with a typed
 * `DataLoss` rather than replaying a prefix
 * (`reference/temporal/common/persistence/history_manager.go`).
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter, layer as writerLayer } from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Context, Effect, Exit, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as Statement from "effect/unstable/sql/Statement"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Journal, type JournalError, type Service } from "../src/Journal.ts"
import { Input, type RunId, type Seq, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/OwnerId.ts"
import * as SqlJournal from "../src/SqlJournal.ts"
import * as Leases from "./fixtures/leases.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId

const input = (run: RunId, source: SourceId, eventType: string, payload: unknown, sequence: number): Input =>
  new Input({
    runId: run,
    sourceId: source,
    sourceSeq: sequence as SourceSeq,
    eventType,
    payload
  }, { disableChecks: true })

const options: SqlJournal.SqlJournalOptions = { capacity: 64, overflow: "reject" }

const owner: OwnerId = { hostId: "host-a", pid: 42, nonce: "nonce-a" }

/** The run's lease row, written through a throwaway connection to the same file. */
const claim = (filename: string, run: RunId) =>
  Effect.scoped(
    Effect.provide(
      Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) => Leases.hold(sql, run, owner)),
      migrated(filename)
    )
  )

const withTempFile = <A, E>(body: (filename: string) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "flows-journal-recovery-"))),
    (directory) => body(join(directory, "journal.sqlite")),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
  )

const migrated = (filename: string) =>
  Layer.provideMerge(
    Migrations.layer,
    Layer.provideMerge(writerLayer(), NodeDatabase.layer({ filename }))
  )

class CrashInjected extends Error {
  override readonly name = "CrashInjected"
}

/**
 * Defects immediately after the durable INSERT, causing the transaction to
 * roll back through its normal scope finalizers.
 */
const crashAfterInsert = (
  shouldCrash: () => boolean
): Layer.Layer<DurableWriter | SqlClient.SqlClient, never, DurableWriter | SqlClient.SqlClient> =>
  Layer.merge(
    Layer.effect(
      SqlClient.SqlClient,
      Effect.map(Effect.service(SqlClient.SqlClient), (base) =>
        new Proxy(base, {
          apply(target, thisArgument, argumentsList) {
            const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
            if (
              typeof statement.compile !== "function" ||
              !statement.compile()[0].includes("INSERT INTO flows_journal_events")
            ) {
              return statement
            }
            return statement.pipe(
              Effect.tap(() =>
                shouldCrash() ? Effect.die(new CrashInjected("writer defect before commit")) : Effect.void
              )
            )
          }
        }) as SqlClient.SqlClient)
    ),
    Layer.effect(DurableWriter, Effect.service(DurableWriter))
  )

/** A journal on its own connection to the file, optionally crash-injected. */
const connection = (
  filename: string,
  decorator?: Layer.Layer<DurableWriter | SqlClient.SqlClient, never, DurableWriter | SqlClient.SqlClient>
) => {
  const layer = SqlJournal.layer(options)
  return Effect.map(
    Layer.build(
      (decorator === undefined ? layer : layer.pipe(Layer.provide(decorator))).pipe(Layer.provide(migrated(filename)))
    ),
    (context) => Context.get(context, Journal) as Service
  )
}

/** Reads the durable rows of a run through a throwaway connection. */
const rowsOf = (filename: string, run: RunId) =>
  Effect.scoped(
    Effect.provide(
      Effect.flatMap(
        Effect.service(SqlClient.SqlClient),
        (sql) =>
          sql<{ readonly seq: number; readonly source_seq: number; readonly event_type: string }>`
            SELECT seq, source_seq, event_type FROM flows_journal_events
            WHERE run_id = ${run} ORDER BY seq ASC
          `
      ),
      migrated(filename)
    )
  )

/** Rewrites a column of the file's durable rows, bypassing the CHECK guards. */
const corrupt = (filename: string, statement: string) =>
  Effect.scoped(
    Effect.provide(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* TestDatabase.checks(sql, false)
        yield* sql.unsafe(statement)
      }),
      migrated(filename)
    )
  )

describe("SqlJournal append recovery on a real file", () => {
  it.effect(
    "leaves no phantom entry, identity, or sequence after an injected defect rolls back",
    () =>
      withTempFile((filename) =>
        Effect.gen(function*() {
          const run = runId("crashed")
          const source = sourceId("driver")
          const doomed = input(run, source, "third", { value: 2 }, 2)
          let crashing = false

          const exit = yield* Effect.exit(
            Effect.scoped(
              Effect.gen(function*() {
                const journal = yield* connection(filename, crashAfterInsert(() => crashing))
                yield* journal.emitDurableUnfenced(input(run, source, "first", { value: 0 }, 0))
                yield* journal.emitDurableUnfenced(input(run, source, "second", { value: 1 }, 1))
                crashing = true
                yield* journal.emitDurableUnfenced(doomed)
              })
            )
          )

          // A defect must remain a defect, never a successful receipt.
          expect(Exit.isFailure(exit) ? exit.cause.reasons.map((reason) => reason._tag) : "Success").toEqual(["Die"])

          // A cold connection re-reads the file. The doomed INSERT rolled back
          // with its transaction, so seq 2 was never committed.
          expect((yield* rowsOf(filename, run)).map((row) => row.seq)).toEqual([0, 1])

          yield* Effect.scoped(
            Effect.gen(function*() {
              const journal = yield* connection(filename)
              // No phantom identity: the producer's retry of the exact input
              // the dead writer issued is a fresh admission, never a
              // `Duplicate` receipt for a row that does not exist.
              const receipt = yield* journal.emitDurableUnfenced(doomed)
              expect(receipt._tag).toBe("Accepted")
              // The next sequence continues from the durable floor, not from
              // the number the dead writer had already claimed in memory.
              expect(receipt.seq).toBe(2)
              expect(receipt.sourceSeq).toBe(2)
            })
          )

          const rows = yield* rowsOf(filename, run)
          expect(rows.map((row) => row.seq)).toEqual([0, 1, 2])
          expect(rows.map((row) => row.source_seq)).toEqual([0, 1, 2])
          expect(rows.map((row) => row.event_type)).toEqual(["first", "second", "third"])
        })
      ),
    30_000
  )

  it.effect(
    "refuses to open on a corrupted durable event row instead of replaying a prefix",
    () =>
      withTempFile((filename) =>
        Effect.gen(function*() {
          const run = runId("corrupt-event")
          const source = sourceId("driver")
          yield* Effect.scoped(
            Effect.gen(function*() {
              const journal = yield* connection(filename)
              yield* journal.emitDurableUnfenced(input(run, source, "first", { value: 0 }, 0))
              yield* journal.emitDurableUnfenced(input(run, source, "second", { value: 1 }, 1))
            })
          )

          yield* corrupt(
            filename,
            `UPDATE flows_journal_events SET payload_json = 'not-json' WHERE seq = 1`
          )

          // Opening the journal decodes the recent durable window, so the
          // damaged row is caught before any caller can observe a partial
          // history: the layer itself fails, typed.
          const exit = yield* Effect.exit(Effect.scoped(connection(filename)))
          const failure = (Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined) as unknown as {
            readonly error: JournalError
          } | undefined
          expect(failure?.error.code).toBe("decode_failed")

          // Nothing was replayed, repaired, or deleted on the way out.
          expect((yield* rowsOf(filename, run)).map((row) => row.seq)).toEqual([0, 1])
        })
      ),
    30_000
  )

  it.effect(
    "reports decode_failed for a corrupted checkpoint while the entry history stays intact",
    () =>
      withTempFile((filename) =>
        Effect.gen(function*() {
          const run = runId("corrupt-checkpoint")
          const source = sourceId("driver")
          yield* claim(filename, run)
          yield* Effect.scoped(
            Effect.gen(function*() {
              const journal = yield* connection(filename)
              yield* journal.emitDurableUnfenced(input(run, source, "first", { value: 0 }, 0))
              yield* journal.emitDurableUnfenced(input(run, source, "second", { value: 1 }, 1))
              yield* journal.checkpoint({ runId: run, seq: 1 as Seq, state: { at: 1 } }, owner)
            })
          )

          yield* corrupt(
            filename,
            `UPDATE flows_journal_checkpoints SET state_json = 'not-json'`
          )

          yield* Effect.scoped(
            Effect.gen(function*() {
              const journal = yield* connection(filename)
              const failure = yield* Effect.flip(journal.latestCheckpoint(run))
              expect(failure.code).toBe("decode_failed")
              // A resume point that cannot be decoded must not silently degrade
              // into a partial replay: the entries are still complete and are
              // still the only history the caller is offered.
              const page = yield* journal.entries({ runId: run, limit: 10 })
              expect(page.entries.map((entry) => entry.seq)).toEqual([0, 1])
              expect(page.hasMore).toBe(false)
            })
          )
        })
      ),
    30_000
  )
})
