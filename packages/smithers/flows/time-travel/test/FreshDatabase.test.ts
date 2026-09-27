import { describe, expect, it } from "@effect/vitest"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import { TimeTravelError } from "../src/TimeTravelError.ts"

describe("SqlTimeTravelStore prerequisites", () => {
  for (const journalMigrated of [false, true]) {
    const missing = journalMigrated ? "flows_runs" : "flows_journal_events"
    it.effect(`refuses a database missing ${missing} with a typed failure`, () =>
      Effect.gen(function*() {
        if (journalMigrated) yield* DatabaseMigrations.run([JournalMigrations.set])
        const exit = yield* Effect.exit(Effect.scoped(Layer.build(SqlTimeTravelStore.layer)))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Result.isFailure(Cause.findDefect(exit.cause))).toBe(true)
          const failure: unknown = Result.getOrUndefined(Cause.findError(exit.cause))
          expect(failure).toBeInstanceOf(TimeTravelError)
          expect(failure).toMatchObject({ code: "unknown" })
          expect((failure as TimeTravelError).message).toContain(missing)
        }
        const sql = yield* SqlClient.SqlClient
        const tables = yield* sql`SELECT name FROM ${TestDatabase.catalog(sql)} WHERE name LIKE 'flows_time_travel_%'`
        expect(tables).toEqual([])
      }).pipe(Effect.provide(TestDatabase.layer)))
  }
})

it.effect("reports a failed catalog read as a typed prerequisite error", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const unavailable = new Proxy(sql, { apply: () => sql`SELECT * FROM missing_catalog` })
    const failure = yield* Effect.flip(
      SqlTimeTravelStore.make.pipe(Effect.provideService(SqlClient.SqlClient, unavailable))
    )
    expect(failure).toBeInstanceOf(TimeTravelError)
    expect(failure.message).toContain("could not check time-travel prerequisite")
  }).pipe(Effect.provide(TestDatabase.layer)))
