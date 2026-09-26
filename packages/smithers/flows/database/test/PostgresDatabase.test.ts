import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { randomUUID } from "node:crypto"
import * as Dialect from "../src/Dialect.ts"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as Migrations from "../src/Migrations.ts"
import * as PostgresDatabase from "../src/postgres/PostgresDatabase.ts"

const url = process.env.SMITHERS_TEST_PG_URL
const fixture = <A, E>(body: (first: SqlClient, second: SqlClient) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const schema = `adapter_${randomUUID().replaceAll("-", "")}`
    // Build the layers in the enclosing scope so two independent pools stay open.
    const first = yield* Layer.build(PostgresDatabase.layer({ url: url!, schema }))
    const second = yield* Layer.build(PostgresDatabase.layer({ url: url!, schema }))
    const a = Context.get(first, SqlClient)
    const b = Context.get(second, SqlClient)
    yield* Effect.addFinalizer(() => a`DROP SCHEMA ${a(schema)} CASCADE`.pipe(Effect.orDie))
    return yield* body(a, b)
  })))

describe.skipIf(!url)("PostgreSQL adapter (independent pools)", () => {
  it("serializes read-modify-write and concurrent first migration across pools", async () => {
    await fixture((a, b) =>
      Effect.gen(function*() {
        const set: Migrations.MigrationSet = {
          namespace: "adapter",
          idOffset: 0,
          migrations: {
            "0001_initial": Effect.gen(function*() {
              const sql = yield* SqlClient
              yield* sql`CREATE TABLE counter (value INTEGER NOT NULL)`
              yield* sql`INSERT INTO counter VALUES (0)`
            })
          }
        }
        const passes = yield* Effect.all(
          [a, b].map((sql) => Migrations.run([set]).pipe(Effect.provideService(SqlClient, sql))),
          { concurrency: 2 }
        )
        expect(passes.flat()).toEqual([[1, "adapter_initial"]])
        yield* Effect.all(
          Array.from({ length: 20 }, (_, index) => {
            const sql = index % 2 ? a : b
            return DurableWriter.make(sql).write(Effect.gen(function*() {
              const rows = yield* sql<{ value: number }>`SELECT value FROM counter`
              yield* sql`UPDATE counter SET value = ${rows[0]!.value + 1}`
            }))
          }),
          { concurrency: 20 }
        )
        expect(yield* b`SELECT value FROM counter`).toEqual([{ value: 20 }])
      })
    )
  })

  it("rolls back failed nested writes and reuses the connection after SQL errors", async () => {
    await fixture((sql, peer) =>
      Effect.gen(function*() {
        yield* sql`CREATE TABLE receipts (id INTEGER PRIMARY KEY)`
        const writer = DurableWriter.make(sql)
        yield* writer.write(Effect.gen(function*() {
          yield* sql`INSERT INTO receipts VALUES (1)`
          expect((yield* Effect.exit(writer.write(sql`INSERT INTO receipts VALUES (1)`)))._tag).toBe("Failure")
          yield* sql`INSERT INTO receipts VALUES (2)`
        }))
        expect(yield* peer`SELECT id FROM receipts ORDER BY id`).toEqual([{ id: 1 }, { id: 2 }])
        yield* Effect.exit(writer.write(Effect.gen(function*() {
          yield* sql`INSERT INTO receipts VALUES (3)`
          return yield* Effect.fail("rollback")
        })))
        expect(yield* peer`SELECT count(*) AS count FROM receipts`).toEqual([{ count: 2 }])
      })
    )
  })

  it("round-trips safe integers, fractional rejection, bytes and Unicode without rounding", async () => {
    await fixture((sql, peer) =>
      Effect.gen(function*() {
        yield* sql`CREATE TABLE exact_values (
        value ${Dialect.integer(sql)} CHECK (${Dialect.isInteger(sql, sql`value`)} AND value <= 9007199254740991),
        bytes BYTEA, text TEXT)`
        const bytes = new Uint8Array([0, 1, 127, 255])
        yield* sql`INSERT INTO exact_values VALUES (${Number.MAX_SAFE_INTEGER}, ${bytes}, ${"journal 🐘"})`
        expect(yield* peer`SELECT * FROM exact_values`).toEqual([{
          value: Number.MAX_SAFE_INTEGER,
          bytes,
          text: "journal 🐘"
        }])
        for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
          expect((yield* Effect.exit(sql`INSERT INTO exact_values (value) VALUES (${value})`))._tag).toBe("Failure")
        }
      })
    )
  })
})
