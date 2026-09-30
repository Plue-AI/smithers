/**
 * The ownership fence under a real takeover, across two real connections to one
 * file-backed SQLite database.
 *
 * `JournalFence.test.ts` proves the strategy's guard against an in-memory
 * lease row with a single connection, where ownership never changes *while*
 * an append is in flight. That is the case the fence exists for: a zombie
 * owner already inside its write path when a successor takes the run. This
 * suite opens that window deterministically — the stale writer parks on the
 * threshold of its write transaction, the successor commits the ownership
 * change and its own entry on a second connection, and the stale writer is
 * then released into a database that has moved on.
 *
 * The lease lives in `flows_consensus_leases`, which this package's own
 * migrations create, so the takeover is written as the lease row the
 * `SqlConsensus` guard reads — the same contract `JournalFence.test.ts`
 * asserts.
 *
 * Prior art: Temporal's shard `rangeID` fencing
 * (`reference/temporal/service/history/shard/context_impl.go`,
 * `renewRangeLocked`), reduced to one guard read in the append transaction.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter, layer as writerLayer } from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Journal, JournalError, type Service } from "../src/Journal.ts"
import { Input, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/OwnerId.ts"
import * as SqlJournal from "../src/SqlJournal.ts"
import * as Leases from "./fixtures/leases.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId

const stale: OwnerId = { hostId: "host-a", pid: 42, nonce: "nonce-a" }
const successor: OwnerId = { hostId: "host-b", pid: 43, nonce: "nonce-b" }

const run = runId("fenced-takeover")

const input = (source: SourceId, sequence: number, payload: unknown): Input =>
  new Input({
    runId: run,
    sourceId: source,
    sourceSeq: sequence as SourceSeq,
    eventType: "flows.engine.run-decision",
    payload
  }, { disableChecks: true })

const options: SqlJournal.SqlJournalOptions = { capacity: 64, overflow: "reject" }

const withTempFile = <A, E>(body: (filename: string) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "flows-journal-fence-"))),
    (directory) => body(join(directory, "journal.sqlite")),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
  )

const migrated = (filename: string) =>
  Layer.provideMerge(
    Migrations.layer,
    Layer.provideMerge(writerLayer(), NodeDatabase.layer({ filename }))
  )

/**
 * Parks the FIRST write transaction this connection opens, announcing arrival,
 * and lets every later one through.
 *
 * The park is placed *before* `BEGIN`, not inside the transaction. A stale
 * writer that parks mid-transaction holds SQLite's write lock, so the successor
 * cannot commit its takeover at all and both sides stall on the lock rather
 * than on the fence. Parking here reproduces the window the fence is actually
 * for: the append is already in flight — input validated, sequence allocated
 * from the in-process floor — when ownership moves underneath it, and the fence
 * predicate is then evaluated against the committed successor.
 */
const parkFirstWrite = (
  reached: Deferred.Deferred<void>,
  gate: Deferred.Deferred<void>
): Layer.Layer<DurableWriter | SqlClient.SqlClient, never, DurableWriter | SqlClient.SqlClient> => {
  let parked = false
  return Layer.merge(
    Layer.effect(
      DurableWriter,
      Effect.map(Effect.service(DurableWriter), (writer) =>
        DurableWriter.of({
          write: (<A, E, R>(effect: Effect.Effect<A, E, R>) => {
            if (parked) return writer.write(effect)
            parked = true
            return Deferred.succeed(reached, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(writer.write(effect))
            )
          }) as DurableWriter["Service"]["write"]
        }))
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

/** Runs raw SQL on its own connection to the file. */
const onOwnConnection = <A, E>(
  filename: string,
  body: Effect.Effect<A, E, SqlClient.SqlClient>
) => Effect.scoped(Effect.provide(body, migrated(filename)))

const rowsOf = (filename: string) =>
  onOwnConnection(
    filename,
    Effect.flatMap(
      Effect.service(SqlClient.SqlClient),
      (sql) =>
        sql<{ readonly seq: number; readonly source_id: string; readonly event_type: string }>`
          SELECT seq, source_id, event_type FROM flows_journal_events
          WHERE run_id = ${run} ORDER BY seq ASC
        `
    )
  )

describe("SqlJournal durable fencing across connections", () => {
  it.effect(
    "fails a stale append with fence_lost while the successor's entry survives",
    () =>
      withTempFile((filename) =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* onOwnConnection(
              filename,
              Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) => Leases.hold(sql, run, stale))
            )

            const reached = yield* Deferred.make<void>()
            const gate = yield* Deferred.make<void>()
            const zombie = yield* connection(filename, parkFirstWrite(reached, gate))
            const winner = yield* connection(filename)

            // The stale owner enters its fenced append — input validated,
            // sequence allocated — and parks on the threshold of its write
            // transaction, still holding the run per its lease.
            const appending = yield* Effect.forkChild(
              Effect.flip(zombie.emitDurable(input(sourceId("zombie"), 0, { decision: "stale" }), stale)),
              { startImmediately: true }
            )
            yield* Deferred.await(reached)

            // A successor takes the run on its own connection and appends. Both
            // commit while the stale writer is parked mid-append.
            yield* onOwnConnection(
              filename,
              Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) => Leases.hold(sql, run, successor))
            )
            const survivor = yield* winner.emitDurable(
              input(sourceId("successor"), 0, { decision: "took-over" }),
              successor
            )
            expect(survivor._tag).toBe("Accepted")

            yield* Deferred.succeed(gate, undefined)
            const failure = yield* Fiber.join(appending)

            // The zombie is told it lost the run rather than writing behind the
            // live owner.
            expect(failure).toBeInstanceOf(JournalError)
            expect((failure as JournalError).code).toBe("fence_lost")

            // Retrying the same append does not launder the lost fence into a
            // `Duplicate` or an `Accepted`: the run is still not the zombie's.
            const retry = yield* Effect.flip(
              zombie.emitDurable(input(sourceId("zombie"), 0, { decision: "stale" }), stale)
            )
            expect((retry as JournalError).code).toBe("fence_lost")

            // Exactly the successor's entry is durable.
            const rows = yield* rowsOf(filename)
            expect(rows.map((row) => row.source_id)).toEqual(["successor"])
            expect(rows.map((row) => row.seq)).toEqual([survivor.seq])
          })
        )
      ),
    30_000
  )

  // The fence outranks dedup: `insertOne` answers the duplicate lookup for a
  // fenced append only after the fenced INSERT produced no row and the owner
  // has been re-confirmed in the same serialized transaction, so a dedup hit
  // can never tell a zombie owner its event is committed.
  it.effect(
    "refuses a stale append whose source identity already names a committed entry",
    () =>
      withTempFile((filename) =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* onOwnConnection(
              filename,
              Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) => Leases.hold(sql, run, successor))
            )
            const zombie = yield* connection(filename)

            // The successor commits an entry, then the stale owner re-emits the
            // *same source identity*: identical `(runId, sourceId, sourceSeq)`,
            // which is the durable dedup key (`UNIQUE (run_id, source_id,
            // source_seq)`). Dedup must be evaluated only after the fenced
            // insert has produced no row, so a zombie cannot launder its lost
            // fence into an `Idempotent`/`Duplicate` receipt by resubmitting
            // work the live owner already committed.
            const shared = sourceId("shared")
            const winner = yield* connection(filename)
            yield* winner.emitDurable(input(shared, 0, { decision: "took-over" }), successor)

            const failure = yield* Effect.flip(
              zombie.emitDurable(input(shared, 0, { decision: "took-over" }), stale)
            )
            expect((failure as JournalError).code).toBe("fence_lost")

            // Exactly the successor's single entry; the zombie's resubmission
            // neither appended nor was answered from the dedup index.
            const rows = yield* rowsOf(filename)
            expect(rows.map((row) => row.source_id)).toEqual(["shared"])
            expect(rows).toHaveLength(1)
          })
        )
      ),
    30_000
  )
})
