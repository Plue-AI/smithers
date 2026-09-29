/**
 * The reader/compactor race against a real file-backed SQLite database, with
 * the reader and the compactor on separate connections.
 *
 * `JournalCompaction.test.ts` runs the same race through an in-memory database
 * and an SQL proxy, where the "concurrent" compaction is really the same
 * connection reentered. The ordering `readPage` relies on — read the page, then
 * read the compaction floor, so any truncation that could have shortened the
 * page is visible in the floor — is a claim about two *transactions*, and only
 * a second connection to a real file can put a committed DELETE between them.
 *
 * The contract: a paged read is either a complete history or a typed
 * `compacted` carrying the resync point. A silently shortened or gapped page is
 * the one outcome that must be impossible, because a caller cannot tell it from
 * a genuine end of history.
 *
 * Child processes are not available to this package's tooling, so the compactor
 * is a second `NodeDatabase` connection in this process. The SQLite transaction
 * boundary it commits across is the same one a second process would cross.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter, layer as writerLayer } from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as Statement from "effect/unstable/sql/Statement"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Journal, type Service } from "../src/Journal.ts"
import { Input, type RunId, type Seq, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/OwnerId.ts"
import * as SqlJournal from "../src/SqlJournal.ts"
import * as Leases from "./fixtures/leases.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId

const run = runId("compaction-race")
const source = sourceId("producer")

const input = (sequence: number): Input =>
  new Input({
    runId: run,
    sourceId: source,
    sourceSeq: sequence as SourceSeq,
    eventType: "event",
    payload: { value: sequence }
  }, { disableChecks: true })

const options: SqlJournal.SqlJournalOptions = { capacity: 64, overflow: "reject" }

const owner: OwnerId = { hostId: "host-a", pid: 42, nonce: "nonce-a" }

/** This run's lease row, written through a throwaway connection to the same file. */
const claim = (filename: string) =>
  Effect.scoped(
    Effect.provide(
      Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) => Leases.hold(sql, run, owner)),
      migrated(filename)
    )
  )

const withTempFile = <A, E>(body: (filename: string) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "flows-journal-compaction-"))),
    (directory) => body(join(directory, "journal.sqlite")),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
  )

const migrated = (filename: string) =>
  Layer.provideMerge(
    Migrations.layer,
    Layer.provideMerge(writerLayer(), NodeDatabase.layer({ filename }))
  )

/**
 * Parks the reader between its event read and its floor read, exactly once.
 *
 * `readPage` reads the page first and the compaction floor second, and the
 * claim under test is that the ordering makes a concurrent truncation visible.
 * This gate sits in that seam: the page rows are already in hand and the floor
 * has not been consulted when the compactor commits.
 */
const parkBetweenPageAndFloor = (
  reached: Deferred.Deferred<void>,
  gate: Deferred.Deferred<void>
): Layer.Layer<DurableWriter | SqlClient.SqlClient, never, DurableWriter | SqlClient.SqlClient> => {
  let parked = false
  return Layer.merge(
    Layer.effect(
      SqlClient.SqlClient,
      Effect.map(Effect.service(SqlClient.SqlClient), (base) =>
        new Proxy(base, {
          apply(target, thisArgument, argumentsList) {
            const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
            if (parked || typeof statement.compile !== "function") {
              return statement
            }
            const [query] = statement.compile()
            if (!query.includes("AND seq >") || query.includes("seq >=")) {
              return statement
            }
            parked = true
            return statement.pipe(
              Effect.tap(() => Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(gate))))
            )
          }
        }) as SqlClient.SqlClient)
    ),
    Layer.effect(DurableWriter, Effect.service(DurableWriter))
  )
}

/** Parks only a connection's first journal write before opening its transaction. */
const gateFirstWrite = (
  reached: Deferred.Deferred<void>,
  gate: Deferred.Deferred<void>
): Layer.Layer<DurableWriter | SqlClient.SqlClient, never, DurableWriter | SqlClient.SqlClient> => {
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

const seed = (journal: Service, count: number) =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    (index) => journal.emitDurableUnfenced(input(index)),
    { discard: true }
  )

describe("SqlJournal reader and compactor on one file", () => {
  it.effect("retains compacted identities and producer floors after reopening the file", () =>
    withTempFile((filename) =>
      Effect.gen(function*() {
        yield* claim(filename)
        yield* Effect.scoped(Effect.gen(function*() {
          const journal = yield* connection(filename)
          yield* journal.emitDurableUnfenced(input(7))
          yield* journal.emitDurableUnfenced(new Input({ ...input(0), sourceId: sourceId("checkpoint") }))
          yield* journal.checkpoint({ runId: run, seq: 1 as Seq, state: { applied: 2 } }, owner)
          yield* journal.compact({ runId: run }, owner)
        }))
        yield* Effect.scoped(Effect.gen(function*() {
          const journal = yield* connection(filename)
          expect(yield* journal.emitDurableUnfenced(input(7))).toEqual({
            _tag: "Duplicate",
            seq: 0,
            sourceSeq: 7,
            status: "committed"
          })
          yield* journal.emitLossy(input(7))
          yield* journal.flush
          expect((yield* journal.entries({ runId: run, after: 1 as Seq, limit: 10 })).entries).toEqual([])
        }))
        // Reopen again so the explicit retry cannot seed the producer floor.
        yield* Effect.scoped(Effect.gen(function*() {
          const journal = yield* connection(filename)
          const next = yield* journal.emitDurableUnfenced(
            new Input({
              runId: run,
              sourceId: source,
              eventType: "event",
              payload: { next: true }
            })
          )
          expect(next).toEqual({ _tag: "Accepted", seq: 2, sourceSeq: 8 })
        }))
      })
    ))

  it.effect(
    "drops a queued entry when another connection advances the floor past it",
    () =>
      withTempFile((filename) =>
        Effect.scoped(
          Effect.gen(function*() {
            const reached = yield* Deferred.make<void>()
            const gate = yield* Deferred.make<void>()
            yield* claim(filename)

            const admitting = yield* connection(filename, gateFirstWrite(reached, gate))
            const queued = yield* admitting.emitLossy(input(0))
            expect(queued.seq).toBe(0)
            yield* Deferred.await(reached)

            const durable = yield* admitting.emitDurableUnfenced(input(1))
            expect(durable.seq).toBe(1)
            yield* admitting.checkpoint({ runId: run, seq: 1 as Seq, state: null }, owner)

            const compactor = yield* connection(filename)
            const compacted = yield* compactor.compact({ runId: run, upTo: 1 as Seq }, owner)
            expect(compacted).toEqual({ runId: run, checkpointSeq: 1, deleted: 0 })

            yield* Deferred.succeed(gate, undefined)
            const dropped = yield* Effect.flip(admitting.flush)
            expect(dropped.code).toBe("compacted")
            expect(dropped.checkpointSeq).toBe(1)
            expect(dropped.message).toContain("sequence 0")

            yield* Effect.scoped(
              Effect.provide(
                Effect.gen(function*() {
                  const sql = yield* Effect.service(SqlClient.SqlClient)
                  const rows = yield* sql<{ readonly seq: number }>`
                    SELECT seq FROM flows_journal_events WHERE run_id = ${run} ORDER BY seq ASC
                  `
                  expect(rows.map((row) => row.seq)).toEqual([1])
                  expect(rows.every((row) => row.seq >= 1)).toBe(true)
                }),
                migrated(filename)
              )
            )

            const behind = yield* Effect.flip(compactor.entries({ runId: run, limit: 10 }))
            expect(behind.code).toBe("compacted")
            expect(behind.checkpointSeq).toBe(1)
          })
        )
      ),
    30_000
  )

  it.effect(
    "fails a page read with compacted rather than returning a shortened history",
    () =>
      withTempFile((filename) =>
        Effect.scoped(
          Effect.gen(function*() {
            const reached = yield* Deferred.make<void>()
            const gate = yield* Deferred.make<void>()
            yield* claim(filename)

            yield* Effect.scoped(
              Effect.gen(function*() {
                const writer = yield* connection(filename)
                yield* seed(writer, 6)
                yield* writer.checkpoint({ runId: run, seq: 5 as Seq, state: { at: 5 } }, owner)
              })
            )

            const reader = yield* connection(filename, parkBetweenPageAndFloor(reached, gate))
            const compactor = yield* connection(filename)

            // The reader has the full page in hand and has not yet read the
            // floor.
            const reading = yield* Effect.forkChild(
              Effect.exit(reader.entries({ runId: run, limit: 10 })),
              { startImmediately: true }
            )
            yield* Deferred.await(reached)

            // A compactor on its own connection truncates everything below the
            // checkpoint and commits.
            const compacted = yield* compactor.compact({ runId: run }, owner)
            expect(compacted.deleted).toBe(5)
            expect(compacted.checkpointSeq).toBe(5)

            yield* Deferred.succeed(gate, undefined)
            const exit = yield* Fiber.join(reading)

            // The floor read happens after the DELETE committed, so the reader
            // is told to resync rather than handed the rows it read before the
            // truncation.
            expect(exit._tag).toBe("Failure")
            const failure = (exit._tag === "Failure" ? exit.cause.reasons[0] : undefined) as unknown as {
              readonly error: { readonly code: string; readonly checkpointSeq: number }
            }
            expect(failure.error.code).toBe("compacted")
            expect(failure.error.checkpointSeq).toBe(5)
          })
        )
      ),
    30_000
  )

  it.effect(
    "serves a complete page to a cursor at the floor while a compactor commits beneath it",
    () =>
      withTempFile((filename) =>
        Effect.scoped(
          Effect.gen(function*() {
            const reached = yield* Deferred.make<void>()
            const gate = yield* Deferred.make<void>()
            yield* claim(filename)

            yield* Effect.scoped(
              Effect.gen(function*() {
                const writer = yield* connection(filename)
                yield* seed(writer, 7)
                yield* writer.checkpoint({ runId: run, seq: 5 as Seq, state: { at: 5 } }, owner)
              })
            )

            const reader = yield* connection(filename, parkBetweenPageAndFloor(reached, gate))
            const compactor = yield* connection(filename)

            // This reader is already at sequence 4, so the truncation about to
            // commit deletes nothing it still needs.
            const reading = yield* Effect.forkChild(
              Effect.exit(reader.entries({ runId: run, after: 4 as Seq, limit: 10 })),
              { startImmediately: true }
            )
            yield* Deferred.await(reached)
            expect((yield* compactor.compact({ runId: run }, owner)).deleted).toBe(5)
            yield* Deferred.succeed(gate, undefined)

            const exit = yield* Fiber.join(reading)
            // The other permitted outcome: a complete tail, never a gapped or
            // silently truncated one.
            expect(exit._tag).toBe("Success")
            const page = exit._tag === "Success" ? exit.value : undefined
            expect(page?.entries.map((entry) => entry.seq)).toEqual([5, 6])
            expect(page?.hasMore).toBe(false)
          })
        )
      ),
    30_000
  )
})
