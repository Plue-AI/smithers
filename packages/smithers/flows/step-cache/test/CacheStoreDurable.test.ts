import * as TestDatabase from "@smthrs/database/test/TestDatabase"
/**
 * The cache store against a real file-backed SQLite database, with two real
 * connections.
 *
 * `CacheStore.test.ts` drives first-writer-wins through one in-memory
 * connection, which cannot show what the contract is for: the window is a
 * *second connection* recording under the same digest at the same time. These
 * cases open two connections on one tmpdir file, align them on a latch, and
 * assert the durable outcome — the same shape `JournalDurable.test.ts` uses for
 * the journal's allocation contract.
 *
 * Child processes are not available to this package's tooling, so "two writers"
 * is two independent `NodeDatabase` connections in one process. That is the
 * boundary the SQLite locking protocol actually arbitrates; the process
 * boundary above it adds no further serialization.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CacheStore } from "../src/CacheStore.ts"
import * as CacheStoreLive from "../src/CacheStore.ts"
import * as CombinedCacheStore from "../src/CombinedCacheStore.ts"
import * as Migrations from "../src/Migrations.ts"

const entry: CacheStoreLive.CacheEntry = {
  keyDigest: "durable-digest",
  result: { output: "seeded" },
  meta: { source: "recorded" },
  createdAtMs: 10,
  recordedRunId: "run-1",
  recordedEventSeq: 7
}

const withTempFile = <A, E>(body: (filename: string) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "flows-step-cache-durable-"))),
    (directory) => body(join(directory, "cache.sqlite")),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
  )

const migrated = (filename: string) =>
  Layer.provideMerge(
    Migrations.layer,
    Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
  )

/** One independent connection to the file, as its own cache store instance. */
const connection = (filename: string) =>
  Effect.map(
    Layer.build(CacheStoreLive.layer.pipe(Layer.provide(migrated(filename)))),
    (context) => Context.get(context, CacheStore)
  )

/** Reads the raw durable rows through a throwaway connection. */
const rowsOf = (filename: string) =>
  Effect.scoped(
    Effect.provide(
      Effect.flatMap(
        Effect.service(SqlClient.SqlClient),
        (sql) =>
          sql<{
            readonly key_digest: string
            readonly result_json: string
            readonly meta_json: string
            readonly created_at_ms: number
            readonly recorded_run_id: string
            readonly recorded_event_seq: number
          }>`
            SELECT key_digest, result_json, meta_json, created_at_ms,
              recorded_run_id, recorded_event_seq
            FROM flows_step_cache ORDER BY key_digest ASC
          `
      ),
      migrated(filename)
    )
  )

describe("CacheStore across real connections", () => {
  it.effect(
    "admits exactly one durable winner when two connections put different results at once",
    () =>
      withTempFile((filename) =>
        Effect.scoped(
          Effect.gen(function*() {
            // Migrate once so both writers open an already-provisioned file.
            yield* Effect.scoped(Effect.provide(Effect.void, migrated(filename)))
            const left = yield* connection(filename)
            const right = yield* connection(filename)
            const start = yield* Deferred.make<void>()
            const put = (store: CacheStoreLive.Service, output: string) =>
              Deferred.await(start).pipe(
                Effect.andThen(store.put({ ...entry, result: { output }, recordedRunId: `run-${output}` }))
              )
            const leftFiber = yield* Effect.forkChild(put(left, "left"), { startImmediately: true })
            const rightFiber = yield* Effect.forkChild(put(right, "right"), { startImmediately: true })
            // Both writers are parked on the latch; releasing it is the only
            // ordering this test imposes.
            yield* Deferred.succeed(start, undefined)
            const outcomes = [yield* Fiber.join(leftFiber), yield* Fiber.join(rightFiber)]

            // First-writer-wins: whichever connection reached SQLite first
            // inserted, and the loser is told its result differs rather than
            // overwriting the row.
            expect(outcomes.map((outcome) => outcome._tag).sort()).toEqual(["Conflict", "Inserted"])

            const rows = yield* rowsOf(filename)
            expect(rows).toHaveLength(1)
            const row = rows[0]!
            // The surviving row is one writer's entry end to end — never a mix
            // of one writer's result with the other's provenance.
            const winner = JSON.parse(row.result_json) as { readonly output: string }
            expect(["left", "right"]).toContain(winner.output)
            expect(row.recorded_run_id).toBe(`run-${winner.output}`)
            expect(row.key_digest).toBe(entry.keyDigest)
            expect(row.created_at_ms).toBe(entry.createdAtMs)
            expect(row.recorded_event_seq).toBe(entry.recordedEventSeq)
            expect(JSON.parse(row.meta_json)).toEqual(entry.meta)
          })
        )
      ),
    30_000
  )

  it.effect(
    "serves whole entries and keeps the winner while a reader, a writer, and a stale evict race",
    () =>
      withTempFile((filename) =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* Effect.scoped(Effect.provide(Effect.void, migrated(filename)))
            const owner = yield* connection(filename)
            const foreign = yield* connection(filename)
            yield* owner.put(entry)

            const start = yield* Deferred.make<void>()
            const gated = <A, E>(effect: Effect.Effect<A, E>) => Deferred.await(start).pipe(Effect.andThen(effect))
            // Ten readers, one conflicting writer, and one fenced evict naming
            // provenance the row no longer carries — all released together.
            const readers = yield* Effect.forkChild(
              gated(
                Effect.forEach(
                  Array.from({ length: 10 }, (_, index) => index),
                  () => foreign.get(entry.keyDigest)
                )
              ),
              { startImmediately: true }
            )
            const writer = yield* Effect.forkChild(
              gated(foreign.put({ ...entry, result: { output: "contender" } })),
              { startImmediately: true }
            )
            const staleEvict = yield* Effect.forkChild(
              gated(
                foreign.evict(entry.keyDigest, {
                  ifRecordedBy: { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq + 1 }
                })
              ),
              { startImmediately: true }
            )
            yield* Deferred.succeed(start, undefined)
            const observed = yield* Fiber.join(readers)
            const contended = yield* Fiber.join(writer)
            const evicted = yield* Fiber.join(staleEvict)

            // Every read decoded, and every read that saw a row saw the whole
            // seeded entry — no torn row, no `decode_failed`.
            expect(observed).toHaveLength(10)
            for (const found of observed) {
              expect(Option.getOrThrow(found)).toEqual(entry)
            }
            // The contending write never replaced the winner.
            expect(contended).toEqual({ _tag: "Conflict" })
            // A fence naming provenance the row does not carry deletes nothing.
            expect(evicted).toBe(false)
            const survivor = yield* owner.get(entry.keyDigest)
            expect(Option.getOrThrow(survivor)).toEqual(entry)
            expect(yield* rowsOf(filename)).toHaveLength(1)
          })
        )
      ),
    30_000
  )

  it.effect(
    "rejects a poisoned durable row on reopen before any write-back reaches it",
    () =>
      withTempFile((filename) =>
        Effect.gen(function*() {
          yield* Effect.scoped(
            Effect.gen(function*() {
              const store = yield* connection(filename)
              yield* store.put(entry)
            })
          )
          // Poison the durable row the way an interrupted write or a foreign
          // writer would: valid SQLite, invalid JSON in a column the store
          // decodes. The CHECK constraint is bypassed exactly as the row would
          // arrive from outside this schema's enforcement.
          yield* Effect.scoped(
            Effect.provide(
              Effect.gen(function*() {
                const sql = yield* Effect.service(SqlClient.SqlClient)
                yield* TestDatabase.checks(sql, false)
                yield* sql`UPDATE flows_step_cache SET result_json = 'not-json'`
              }),
              migrated(filename)
            )
          )

          // A cold process reopens the file. The poisoned row must be a typed
          // failure, not a decoded value and not a defect.
          yield* Effect.scoped(
            Effect.gen(function*() {
              const store = yield* connection(filename)
              const failure = yield* Effect.flip(store.get(entry.keyDigest))
              expect(failure.code).toBe("decode_failed")
            })
          )

          // Composed as the local tier, the poison stops the lookup before the
          // shared tier is consulted: a poisoned local row must never become a
          // remote round trip whose answer is then written back over it.
          const remoteReads: Array<string> = []
          yield* Effect.scoped(
            Effect.gen(function*() {
              const local = yield* connection(filename)
              const remote: CacheStoreLive.Service = {
                get: (keyDigest) =>
                  Effect.sync(() => {
                    remoteReads.push(keyDigest)
                    return Option.some({ ...entry, result: { output: "from-remote" } })
                  }),
                put: () => Effect.succeed({ _tag: "Inserted" }),
                evict: () => Effect.succeed(false),
                sweepExpired: () => Effect.succeed(0)
              }
              const combined = CombinedCacheStore.make({ local, remote })
              const failure = yield* Effect.flip(combined.get(entry.keyDigest))
              expect(failure.code).toBe("decode_failed")
            })
          )
          expect(remoteReads).toEqual([])
          // The poisoned row is still exactly one row: nothing wrote back over
          // it and nothing silently dropped it.
          expect(yield* rowsOf(filename)).toHaveLength(1)
        })
      ),
    30_000
  )
})
