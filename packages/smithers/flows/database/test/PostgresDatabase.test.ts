import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { randomUUID } from "node:crypto"
import * as Dialect from "../src/Dialect.ts"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as Migrations from "../src/Migrations.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"
import * as PostgresDatabase from "../src/postgres/PostgresDatabase.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"

const url = process.env.SMITHERS_TEST_PG_URL
const fixture = <A, E>(body: (first: SqlClient, second: SqlClient) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const schema = `adapter_${randomUUID().replaceAll("-", "")}`
    // Build the layers in the enclosing scope so two independent pools stay open.
    const first = yield* Layer.build(PostgresDatabase.layer({ url: url!, schema }))
    const second = yield* Layer.build(PostgresDatabase.layer({ url: url!, schema }))
    const a = Context.get(first, SqlClient)
    const b = Context.get(second, SqlClient)
    yield* Effect.addFinalizer(() => TestDatabase.dropSchema(a, schema).pipe(Effect.orDie))
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

  it("rolls back commit-time constraint failures and can transact afterwards", async () => {
    await fixture((sql, peer) =>
      Effect.gen(function*() {
        yield* sql`CREATE TABLE parent (id INTEGER PRIMARY KEY)`
        yield* sql`CREATE TABLE child (id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`
        expect((yield* Effect.exit(sql.withTransaction(sql`INSERT INTO child VALUES(1)`)))._tag).toBe("Failure")
        yield* sql.withTransaction(Effect.gen(function*() {
          yield* sql`INSERT INTO parent VALUES(1)`
          yield* sql`INSERT INTO child VALUES(1)`
        }))
        expect(yield* peer`SELECT * FROM child`).toEqual([{ id: 1 }])
      })
    )
  })

  it("rolls back a cancelled advisory-lock acquisition before reusing its connection", async () => {
    await fixture((first, second) =>
      Effect.scoped(Effect.gen(function*() {
        const [identity] = yield* second<{ pid: number }>`SELECT pg_backend_pid() AS pid`
        yield* first.withTransaction(Effect.gen(function*() {
          const blocked = yield* second.withTransaction(second`SELECT 1`).pipe(Effect.forkScoped)
          yield* TestDatabase.until(
            first`SELECT 1 FROM pg_locks WHERE pid=${identity!.pid} AND NOT granted`.pipe(
              Effect.map((rows) => rows.length > 0)
            )
          )
          yield* first`SELECT pg_cancel_backend(${identity!.pid})`
          expect((yield* Fiber.await(blocked))._tag).toBe("Failure")
        }))
        expect(yield* second.withTransaction(second`SELECT 1 AS value`)).toEqual([{ value: 1 }])
      }))
    )
  })

  it("drops a test schema only after an in-flight transaction on it commits", async () => {
    await fixture((first, second) =>
      Effect.scoped(Effect.gen(function*() {
        yield* first`CREATE TABLE drop_order_a (id INTEGER)`
        yield* first`CREATE TABLE drop_order_b (id INTEGER)`
        const [row] = yield* first<{ schema: string }>`SELECT current_schema() AS schema`
        const schema = row!.schema
        const drop = yield* first.withTransaction(Effect.gen(function*() {
          yield* first`SELECT id FROM drop_order_a`
          const drop = yield* TestDatabase.dropSchema(second, schema).pipe(Effect.forkScoped)
          // The drop queues on the schema's writer lock before any table lock,
          // so this transaction can still reach a table it has not touched yet.
          yield* TestDatabase.until(
            first`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
              AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${schema}, 2099)`.pipe(
              Effect.map((rows) => rows.length > 0)
            )
          )
          expect(yield* first`SELECT id FROM drop_order_b`).toEqual([])
          return drop
        }))
        yield* Fiber.join(drop)
        expect(yield* first`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`).toEqual([])
      }))
    )
  })

  it("refuses transactions after its connection scope closes", async () => {
    await fixture((sql) =>
      Effect.gen(function*() {
        const [row] = yield* sql<{ schema: string }>`SELECT current_schema() AS schema`
        const scope = yield* Scope.make()
        const context = yield* Layer.build(PostgresDatabase.layer({ url: url!, schema: row!.schema })).pipe(
          Scope.provide(scope)
        )
        const closed = Context.get(context, SqlClient)
        yield* Scope.close(scope, Exit.void)
        expect((yield* Effect.exit(closed.withTransaction(closed`SELECT 1`)))._tag).toBe("Failure")
      })
    )
  })

  it("selects the native PostgreSQL layer from an explicit schema URL", async () => {
    await fixture((sql) =>
      Effect.gen(function*() {
        const [row] = yield* sql<{ schema: string }>`SELECT current_schema() AS schema`
        const selected = new URL(url!)
        selected.searchParams.set("schema", row!.schema)
        const schema = yield* Effect.gen(function*() {
          const opened = yield* SqlClient
          return yield* opened`SELECT current_schema() AS schema`
        }).pipe(Effect.provide(NodeDatabase.layer({ filename: selected.toString() })))
        expect(schema).toEqual([row])
        expect((yield* Effect.exit(sql`SELECT 9007199254740992::numeric AS unsafe`))._tag).toBe("Failure")
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

it("rejects schema identities PostgreSQL would truncate or treat as absent", () => {
  expect(PostgresDatabase.layer({ url: "postgres://localhost/test" })).toBeDefined()
  for (const schema of ["", "a".repeat(64), "🐘".repeat(16), "bad\0name"]) {
    expect(() => PostgresDatabase.layer({ url: "postgres://localhost/test", schema })).toThrow("schema")
  }
})
