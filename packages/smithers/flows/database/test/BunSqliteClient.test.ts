import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Exit, Layer, Stream } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vi } from "vitest"

// Measures the vendored Bun client in the Node coverage lane. Only `bun:sqlite`
// is replaced, by a shim that keeps Bun's statement contract over node:sqlite:
// `.all()` returns `[]` for a column-less statement and `.values()` returns
// `null` (checked against Bun 1.3). Real Bun runs the same client in
// agent/memory NativeBunAffectedRows.test.ts.
const opened = vi.hoisted(() => [] as Array<unknown>)
vi.mock("bun:sqlite", async () => {
  const { DatabaseSync } = await import("node:sqlite")
  return {
    Database: class {
      private readonly database: InstanceType<typeof DatabaseSync>
      constructor(filename: string, options: { readonly readonly: boolean }) {
        opened.push(options)
        this.database = new DatabaseSync(filename, { readOnly: options.readonly })
      }
      run(sql: string) {
        this.database.exec(sql)
      }
      query(sql: string) {
        const statement = this.database.prepare(sql)
        const columnNames = statement.columns().map((column) => column.name)
        return {
          columnNames,
          safeIntegers: (enabled: boolean) => statement.setReadBigInts(enabled),
          all: (...params: Array<any>) => {
            statement.setReturnArrays(false)
            return statement.all(...params)
          },
          values: (...params: Array<any>) => {
            if (columnNames.length === 0) {
              statement.run(...params)
              return null
            }
            statement.setReturnArrays(true)
            return statement.all(...params)
          },
          run: (...params: Array<any>) => statement.run(...params)
        }
      }
      close() {
        this.database.close()
      }
    }
  }
})

import type { SqliteClientConfig } from "@effect/sql-sqlite-bun/SqliteClient"
import * as BunSqliteClient from "../src/internal/BunSqliteClient.ts"

const withClient = <A, E>(
  config: SqliteClientConfig,
  program: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>
) =>
  Effect.runPromiseExit(
    Effect.scoped(Effect.flatMap(SqlClient.SqlClient, program)).pipe(
      Effect.provide(BunSqliteClient.layer(config) as Layer.Layer<SqlClient.SqlClient>)
    )
  )

const withRoot = async (run: (root: string) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), "flows-bun-client-"))
  try {
    await run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("Bun SQLite client", () => {
  it("returns affected rows from raw writes and rows from raw reads", async () => {
    opened.length = 0
    const exit = await withClient({ filename: ":memory:" }, (sql) =>
      Effect.gen(function*() {
        yield* sql`CREATE TABLE t (id INTEGER PRIMARY KEY, first_name TEXT)`
        const insert = yield* sql`INSERT INTO t (id, first_name) VALUES (1, 'a'), (2, 'b')`.raw
        const deleteMatch = yield* sql`DELETE FROM t WHERE id = 1`.raw
        const deleteMiss = yield* sql`DELETE FROM t WHERE id = 1`.raw
        const returning = yield* sql`INSERT INTO t (id, first_name) VALUES (3, 'c') RETURNING id`.raw
        const transaction = yield* sql.withTransaction(sql`DELETE FROM t WHERE id = 3`.raw)
        const rows = yield* sql`SELECT id, first_name FROM t`
        const values = yield* sql`SELECT id FROM t`.values
        const writeValues = yield* sql`UPDATE t SET first_name = 'z'`.values
        const unprepared = yield* sql`SELECT count(*) AS n FROM t`.unprepared
        const wide = yield* Effect.provideService(sql`SELECT 9007199254740993 AS n`, SqlClient.SafeIntegers, true)
        return { insert, deleteMatch, deleteMiss, returning, transaction, rows, values, writeValues, unprepared, wide }
      }))
    expect(exit).toEqual(Exit.succeed({
      insert: { changes: 2, lastInsertRowid: 2 },
      deleteMatch: { changes: 1, lastInsertRowid: 2 },
      deleteMiss: { changes: 0, lastInsertRowid: 2 },
      returning: [{ id: 3 }],
      transaction: { changes: 1, lastInsertRowid: 3 },
      rows: [{ id: 2, first_name: "b" }],
      values: [[2]],
      writeValues: [],
      unprepared: [{ n: 1 }],
      wide: [{ n: 9007199254740993n }]
    }))
    expect(opened).toEqual([{ readonly: false, readwrite: true, create: true }])
  })

  it("fails statements as SqlError and rejects streaming", async () => {
    const failed = await withClient({ filename: ":memory:" }, (sql) => sql`SELECT * FROM missing`)
    expect(Exit.isFailure(failed) && String(failed.cause)).toMatch(/SqlError/)
    const streamed = await withClient({ filename: ":memory:" }, (sql) => Stream.runCollect(sql`SELECT 1`.stream))
    expect(Exit.isFailure(streamed) && String(streamed.cause)).toMatch(/executeStream not implemented/)
  })

  it("applies configured options: transforms, span attributes, busy timeout, WAL, readonly", () =>
    withRoot(async (root) => {
      const filename = join(root, "db.sqlite")
      opened.length = 0
      const written = await withClient({
        filename,
        readwrite: true,
        create: true,
        busyTimeout: Duration.millis(250),
        spanAttributes: { service: "test" },
        transformResultNames: (name) => name.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())
      }, (sql) =>
        Effect.gen(function*() {
          yield* sql`CREATE TABLE t (first_name TEXT)`
          yield* sql`INSERT INTO t VALUES ('a')`
          return {
            rows: yield* sql`SELECT first_name FROM t`,
            journal: yield* sql`PRAGMA journal_mode`,
            timeout: yield* sql`PRAGMA busy_timeout`
          }
        }))
      expect(written).toEqual(Exit.succeed({
        rows: [{ firstName: "a" }],
        journal: [{ journalMode: "wal" }],
        timeout: [{ timeout: 250 }]
      }))

      const unjournaled = await withClient(
        { filename: join(root, "plain.sqlite"), disableWAL: true },
        (sql) => sql`PRAGMA journal_mode`
      )
      expect(unjournaled).toEqual(Exit.succeed([{ journal_mode: "delete" }]))

      const readonly = await withClient({ filename, readonly: true }, (sql) =>
        Effect.gen(function*() {
          const rows = yield* sql.withTransaction(sql`SELECT first_name FROM t`)
          const write = yield* Effect.exit(sql`INSERT INTO t VALUES ('b')`)
          return { rows, writeFailed: Exit.isFailure(write) }
        }))
      expect(readonly).toEqual(Exit.succeed({ rows: [{ first_name: "a" }], writeFailed: true }))
      expect(opened).toEqual([
        { readonly: false, readwrite: true, create: true },
        { readonly: false, readwrite: true, create: true },
        { readonly: true, readwrite: false, create: false }
      ])
    }))
})
