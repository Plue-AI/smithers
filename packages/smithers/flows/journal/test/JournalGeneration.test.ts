import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { Journal } from "../src/Journal.ts"
import type { RunId } from "../src/JournalEvent.ts"
import * as JournalGeneration from "../src/JournalGeneration.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const database = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
const layer = SqlJournal.layer({ capacity: 8, overflow: "reject" })
const runId = "generation-run" as RunId

describe("SQL journal generations", () => {
  it.effect("reads durable generations after rebuilding the journal layer", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const read = Effect.scoped(
        Effect.gen(function*() {
          const journal = yield* Journal
          return yield* journal.generation!(runId)
        }).pipe(Effect.provide(layer))
      )
      expect(yield* read).toEqual({ generation: 0, afterSeq: -1 })
      yield* sql`INSERT INTO flows_journal_generations (run_id, generation, after_seq) VALUES (${runId}, 2, 50)`
      expect(yield* read).toEqual({ generation: 2, afterSeq: 50 })
    }).pipe(Effect.provide(database)))

  /**
   * The journal layer and time travel's migration both install this table, and
   * a host builds them side by side. On PostgreSQL two sessions creating one
   * table race in the catalog even with IF NOT EXISTS: the loser failed with a
   * unique violation on `pg_type_typname_nsp_index`, and the layer or the
   * migration pass failed with it.
   */
  it.effect("installs the generation table once when sessions initialize it together", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      for (let round = 0; round < 8; round++) {
        yield* sql.withTransaction(
          sql`DROP TABLE IF EXISTS flows_journal_generations ${
            sql.literal(sql.onDialectOrElse({
              pg: () => "CASCADE",
              orElse: () => ""
            }))
          }`
        )
        yield* Effect.all(Array.from({ length: 8 }, () => JournalGeneration.initialize), { concurrency: "unbounded" })
        expect(yield* sql`SELECT run_id FROM flows_journal_generations`).toEqual([])
      }
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("reports a storage failure while reading a generation", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const journal = yield* Journal
        yield* sql`DROP TABLE flows_journal_generations ${
          sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
        }`
        expect(yield* Effect.flip(journal.generation!(runId))).toMatchObject({ code: "read_failed" })
      }).pipe(Effect.provide(Layer.provideMerge(layer, database)))
    ))

  it.effect("reports a storage failure while installing the generation table", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const failure = yield* Effect.flip(sql.withTransaction(Effect.gen(function*() {
        yield* sql.onDialectOrElse({
          pg: () => sql`SET TRANSACTION READ ONLY`,
          orElse: () => sql`PRAGMA query_only = ON`
        })
        return yield* Effect.scoped(Effect.service(Journal).pipe(Effect.provide(layer)))
      })))
      expect(failure).toMatchObject({ code: "read_failed" })
    }).pipe(Effect.provide(database)))
})
