import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as Dialect from "../src/Dialect.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"

const run = <A, E>(body: Effect.Effect<A, E, SqlClient>) => body.pipe(Effect.provide(TestDatabase.layer))

describe("shared SQL dialect", () => {
  it.effect("preserves JSON, integer checks, identities, indexes and bound values", () =>
    run(Effect.gen(function*() {
      const sql = yield* SqlClient
      yield* sql`CREATE TABLE sample (${Dialect.rowId(sql)} id ${Dialect.identity(sql)}, value ${
        Dialect.integer(sql)
      } CHECK (${Dialect.isInteger(sql, sql`value`)} AND value >= 0), payload TEXT CHECK (${
        Dialect.jsonValid(sql, sql`payload`)
      }))`
      yield* sql`CREATE INDEX sample_value ON sample(value)`
      yield* sql`INSERT INTO sample(value,payload) VALUES(1,'{"items":[{"name":"one"}]}')`
      expect(yield* sql`SELECT ${Dialect.jsonText(sql, sql`payload`, "$.items[0].name")} AS name FROM sample`).toEqual([
        { name: "one" }
      ])
      expect(yield* Dialect.query(sql, "SELECT value FROM sample WHERE value = ?", [1])).toEqual([{ value: 1 }])
      expect(
        yield* sql`SELECT ${Dialect.greatest(sql)}(value, 2) AS value FROM sample ${
          Dialect.indexHint(sql, "sample_value")
        }`
      ).toEqual([{ value: 2 }])
      expect((yield* Dialect.tables(sql)).some((row) => row.name === "sample")).toBe(true)
      expect((yield* Dialect.columns(sql, "sample")).map((row) => row.name)).toContain("payload")
      expect((yield* TestDatabase.explain(sql, sql`SELECT value FROM sample WHERE value=1`)).length).toBeGreaterThan(0)
      expect((yield* sql`SELECT name FROM ${TestDatabase.catalog(sql)} WHERE type='index'`).map((row) => row.name))
        .toContain("sample_value")
      expect((yield* Effect.exit(sql`INSERT INTO sample(value,payload) VALUES(-1,'{}')`))._tag).toBe("Failure")
      yield* TestDatabase.checks(sql, false)
      yield* sql`INSERT INTO sample(value,payload) VALUES(-1,'{}')`
      yield* TestDatabase.checks(sql, true)
      yield* TestDatabase.checks(sql, true)
      expect((yield* Effect.exit(sql`INSERT INTO sample(value,payload) VALUES(-2,'{}')`))._tag).toBe("Failure")
      yield* sql`CREATE TABLE child (parent BIGINT REFERENCES sample(id))`
      yield* TestDatabase.foreignKeys(sql, false)
      yield* sql`INSERT INTO child VALUES(999)`
      yield* TestDatabase.foreignKeys(sql, true)
      yield* TestDatabase.foreignKeys(sql, true)
      expect((yield* Effect.exit(sql`INSERT INTO child VALUES(1000)`))._tag).toBe("Failure")
    })))

  it.effect("executes and removes conditional, rejecting, ignoring and delete triggers", () =>
    run(Effect.gen(function*() {
      const sql = yield* SqlClient
      yield* sql`CREATE TABLE sample (value INTEGER)`
      yield* sql`CREATE TABLE audit (value INTEGER)`
      yield* Dialect.trigger(sql, {
        name: "positive",
        table: "sample",
        event: "BEFORE INSERT",
        when: "NEW.value < 0",
        reject: "negative"
      })
      expect((yield* Effect.exit(sql`INSERT INTO sample VALUES(-1)`))._tag).toBe("Failure")
      yield* sql`INSERT INTO sample VALUES(1)`
      yield* Dialect.trigger(sql, { name: "ignored", table: "sample", event: "BEFORE INSERT", ignore: true })
      yield* sql`INSERT INTO sample VALUES(2)`
      expect(yield* sql`SELECT * FROM sample`).toEqual([{ value: 1 }])
      yield* TestDatabase.dropTrigger(sql, "ignored")
      yield* Dialect.trigger(sql, {
        name: "deleted",
        table: "sample",
        event: "AFTER DELETE",
        body: "INSERT INTO audit VALUES(OLD.value);"
      })
      yield* sql`DELETE FROM sample`
      expect(yield* sql`SELECT * FROM audit`).toEqual([{ value: 1 }])
      yield* Dialect.dropTrigger(sql, "positive", "sample")
      yield* Dialect.dropTrigger(sql, "deleted", "sample")
      yield* sql`INSERT INTO sample VALUES(-1)`
      yield* TestDatabase.until(sql`SELECT * FROM sample`.pipe(Effect.map((rows) => rows.length === 1)))
      let ready = false
      setTimeout(() => {
        ready = true
      }, 5)
      yield* TestDatabase.until(Effect.sync(() => ready))
    })))
})

it("bounds an asynchronous condition that never settles", async () => {
  await expect(Effect.runPromise(TestDatabase.until(Effect.succeed(false)))).rejects.toThrow("did not settle")
})
