import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Deferred, Effect, Fiber } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { expect, it } from "vitest"
import { transaction } from "../src/internal/ExecutionSnapshotRead.ts"

// A snapshot read validates rows against a position it read first. On
// PostgreSQL, READ COMMITTED gives each statement its own snapshot, so a writer
// committing between the two reads made a consistent store look corrupt (#2175).
it.skipIf(!process.env.SMITHERS_TEST_PG_URL)(
  "a read transaction sees one snapshot while a writer commits",
  () =>
    Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE snapshot_probe (n INTEGER NOT NULL)`
        yield* sql`INSERT INTO snapshot_probe (n) VALUES (1)`
        const firstRead = yield* Deferred.make<void>()
        const written = yield* Deferred.make<void>()
        const writer = yield* Effect.forkChild(Effect.gen(function*() {
          yield* Deferred.await(firstRead)
          yield* sql`INSERT INTO snapshot_probe (n) VALUES (2)`
          yield* Deferred.succeed(written, undefined)
        }))
        const counts = yield* transaction(
          sql,
          Effect.gen(function*() {
            const before = yield* sql<{ readonly count: number }>`SELECT COUNT(*)::int AS count FROM snapshot_probe`
            yield* Deferred.succeed(firstRead, undefined)
            yield* Deferred.await(written)
            const after = yield* sql<{ readonly count: number }>`SELECT COUNT(*)::int AS count FROM snapshot_probe`
            return [before[0]!.count, after[0]!.count]
          })
        )
        yield* Fiber.join(writer)
        expect(counts).toEqual([1, 1])
        expect(yield* sql<{ readonly count: number }>`SELECT COUNT(*)::int AS count FROM snapshot_probe`)
          .toEqual([{ count: 2 }])
      }).pipe(Effect.provide(TestDatabase.layer), Effect.scoped)
    )
)
