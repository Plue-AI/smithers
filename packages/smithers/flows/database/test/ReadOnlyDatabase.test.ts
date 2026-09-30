import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import * as Dialect from "../src/Dialect.ts"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"
import * as PostgresDatabase from "../src/postgres/PostgresDatabase.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"

/** A migrated SQLite store in WAL mode with one row, closed cleanly. */
const store = () => {
  const root = mkdtempSync(join(tmpdir(), "flows-readonly-"))
  const filename = join(root, "store.db")
  const db = new DatabaseSync(filename)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("CREATE TABLE flows_migrations (id INTEGER)")
  db.exec("CREATE TABLE counter (value INTEGER NOT NULL)")
  db.exec("INSERT INTO counter VALUES (1)")
  db.close()
  return { root, filename }
}

const withClient = <A, E>(options: NodeDatabase.NodeDatabaseOptions, body: (sql: SqlClient) => Effect.Effect<A, E>) =>
  Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
    const sql = Context.get(yield* Layer.build(NodeDatabase.layer(options)), SqlClient)
    return yield* body(sql)
  })))

describe("read-only SQLite", () => {
  it("reads one snapshot while a peer holds the writer, and refuses writes", async () => {
    const { filename, root } = store()
    const peer = new DatabaseSync(filename)
    try {
      peer.exec("BEGIN IMMEDIATE")
      const exit = await withClient({ filename, readOnly: true }, (sql) =>
        Effect.gen(function*() {
          const writer = DurableWriter.make(sql)
          const read = yield* writer.write(sql<{ value: number }>`SELECT value FROM counter`)
          const write = yield* Effect.exit(writer.write(sql`INSERT INTO counter VALUES (2)`))
          return { readOnly: Dialect.isReadOnly(sql), read, written: Exit.isSuccess(write) }
        }))
      expect(exit).toEqual(Exit.succeed({ readOnly: true, read: [{ value: 1 }], written: false }))
      peer.exec("ROLLBACK")
      expect(peer.prepare("SELECT count(*) AS n FROM counter").get()).toEqual({ n: 1 })
    } finally {
      peer.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("creates no database file and no schema object", async () => {
    const { filename, root } = store()
    try {
      const missing = join(root, "missing.db")
      expect(Exit.isFailure(await withClient({ filename: missing, readOnly: true }, () => Effect.void))).toBe(true)
      expect(existsSync(missing)).toBe(false)
      const exit = await withClient(
        { filename, readOnly: true },
        (sql) => Effect.exit(sql`CREATE TABLE IF NOT EXISTS created (id INTEGER)`)
      )
      expect(Exit.isSuccess(exit) && Exit.isFailure(exit.value)).toBe(true)
      const db = new DatabaseSync(filename)
      expect(db.prepare("SELECT name FROM sqlite_master ORDER BY name").all()).toEqual([
        { name: "counter" },
        { name: "flows_migrations" }
      ])
      db.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("marks only the read-only client", async () => {
    const { filename, root } = store()
    try {
      expect(await withClient({ filename }, (sql) => Effect.succeed(Dialect.isReadOnly(sql)))).toEqual(
        Exit.succeed(false)
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

const url = process.env.SMITHERS_TEST_PG_URL

describe.skipIf(!url)("read-only PostgreSQL", () => {
  it("creates no schema, takes no writer lock, and refuses writes", async () => {
    const schema = `readonly_${randomUUID().replaceAll("-", "")}`
    const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
      const writer = Context.get(yield* Layer.build(PostgresDatabase.layer({ url: url!, schema })), SqlClient)
      yield* Effect.addFinalizer(() => TestDatabase.dropSchema(writer, schema).pipe(Effect.orDie))
      const absent = `${schema}_absent`
      const reader = Context.get(
        yield* Layer.build(PostgresDatabase.layer({ url: url!, schema: absent, readOnly: true })),
        SqlClient
      )
      const created = yield* writer<
        { name: string }
      >`SELECT nspname AS name FROM pg_namespace WHERE nspname = ${absent}`
      yield* writer`CREATE TABLE counter (value INTEGER NOT NULL)`
      yield* writer`INSERT INTO counter VALUES (1)`
      const observer = Context.get(
        yield* Layer.build(PostgresDatabase.layer({ url: url!, schema, readOnly: true })),
        SqlClient
      )
      // A peer mid-write holds the schema's writer lock for as long as it likes.
      const held = yield* writer.withTransaction(Effect.gen(function*() {
        yield* writer`INSERT INTO counter VALUES (2)`
        return yield* DurableWriter.make(observer).write(observer<{ value: number }>`SELECT value FROM counter`)
      }))
      const inside = yield* Effect.exit(DurableWriter.make(observer).write(observer`INSERT INTO counter VALUES (3)`))
      const outside = yield* Effect.exit(observer`INSERT INTO counter VALUES (4)`)
      return {
        created,
        flags: [Dialect.isReadOnly(reader), Dialect.isReadOnly(observer), Dialect.isReadOnly(writer)],
        held,
        refused: [Exit.isFailure(inside), Exit.isFailure(outside)],
        rows: yield* writer`SELECT value FROM counter ORDER BY value`
      }
    })))
    expect(exit).toEqual(Exit.succeed({
      created: [],
      flags: [true, true, false],
      held: [{ value: 1 }],
      refused: [true, true],
      rows: [{ value: 1 }, { value: 2 }]
    }))
  })
})
