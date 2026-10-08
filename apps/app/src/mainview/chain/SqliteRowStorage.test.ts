import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { PERSISTED_COLLECTION_BUDGET_BYTES, PERSISTED_LOAD_CHUNK_ROWS, PERSISTED_LOAD_PAGE_BYTES } from "./PersistenceBudget"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DurableStorageConflictError } from "./DurableCollection"
import {
  FutureSqliteSchemaError,
  OversizedSqliteCollectionError,
  METADATA_TABLE_NAME,
  openSqliteRowStorage,
  QUARANTINE_TABLE_NAME,
  ROW_TABLE_NAME,
  type SqliteRowDatabase
} from "./SqliteRowStorage"

const WidgetSchema = z.object({ id: z.string(), label: z.string() })
const NoteSchema = z.object({ id: z.string(), body: z.string() })
const collections = [
  { id: "widgets", schema: WidgetSchema },
  { id: "notes", schema: NoteSchema }
]

const database = (path = ":memory:"): { readonly sqlite: Database; readonly host: SqliteRowDatabase } => {
  const sqlite = new Database(path)
  const host: SqliteRowDatabase = {
    execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []) => {
      const statement = sqlite.query(sql)
      if (/^\s*(?:SELECT|PRAGMA)/i.test(sql)) {
        return statement.all(...params as []) as ReadonlyArray<TRow>
      }
      statement.run(...params as [])
      return []
    },
    close: () => sqlite.close()
  }
  return { sqlite, host }
}

const wire = (rows: Record<string, { readonly versionKey: string; readonly data: unknown }>): string =>
  JSON.stringify(rows)

describe("normalized SQLite row storage", () => {
  for (const count of [1, 64, 65, 130]) test(`commits ${count} rows with bounded complete reads and upserts`, async () => {
    const db = database()
    const calls: Array<{ sql: string; params: ReadonlyArray<unknown> }> = []
    try {
      const storage = await openSqliteRowStorage({ execute: async (sql, params = []) => {
        calls.push({ sql, params })
        return db.host.execute(sql, params)
      } }, { collections, schemaVersion: 9 })
      calls.length = 0
      storage.beginBatch()
      for (let index = 0; index < count; index++) storage.applyRows("notes", [{
        key: `s:n${index}`, versionKey: "v1", data: { id: `n${index}`, body: `body ${index}` }
      }])
      storage.commitBatch()
      await storage.flush()
      expect(calls[0]!.sql).toBe("BEGIN IMMEDIATE")
      expect(calls.at(-1)!.sql).toBe("COMMIT")
      expect(calls.filter(call => call.sql.startsWith("SELECT"))).toHaveLength(Math.ceil(count / 64))
      expect(calls.filter(call => call.sql.startsWith("INSERT"))).toHaveLength(Math.ceil(count / 64))
      expect(calls.every(call => call.params.length <= 256)).toBe(true)
      const rows = db.sqlite.query(`SELECT row_key, version_key, value FROM ${ROW_TABLE_NAME}`).all() as Array<{ row_key: string; version_key: string; value: string }>
      expect(rows).toHaveLength(count)
      for (let index = 0; index < count; index++) expect(rows.find(row => row.row_key === `s:n${index}`)).toEqual({
        row_key: `s:n${index}`, version_key: "v1", value: JSON.stringify({ id: `n${index}`, body: `body ${index}` })
      })
    } finally { db.sqlite.close() }
  })

  test("a conflict in a later read chunk prevents every row and metadata write", async () => {
    const db = database()
    try {
      const storage = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
      db.sqlite.run(`INSERT INTO ${ROW_TABLE_NAME} VALUES (?, ?, ?, ?)`, ["notes", "s:n64", "outside", JSON.stringify({ id: "n64", body: "outside" })])
      const before = db.sqlite.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()
      storage.beginBatch()
      storage.storage.setItem("custom-metadata", "must not commit")
      for (let index = 0; index < 65; index++) storage.applyRows("notes", [{
        key: `s:n${index}`, versionKey: "v1", data: { id: `n${index}`, body: "stale" }
      }])
      storage.commitBatch()
      await expect(storage.flush()).rejects.toBeInstanceOf(DurableStorageConflictError)
      expect(db.sqlite.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()).toEqual(before)
      expect(db.sqlite.query(`SELECT value FROM ${METADATA_TABLE_NAME} WHERE key = ?`).get("custom-metadata")).toBeNull()
    } finally { db.sqlite.close() }
  })

  test("batched repeated upserts and a delete retain their input order", async () => {
    const db = database()
    try {
      const storage = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
      storage.beginBatch()
      storage.applyRows("notes", [
        { key: "s:a", versionKey: "v1", data: { id: "a", body: "first" } },
        { key: "s:a", expectedVersionKey: "v1", versionKey: "v2", data: { id: "a", body: "second" } },
        { key: "s:a", expectedVersionKey: "v2", versionKey: undefined, data: undefined },
        { key: "s:a", versionKey: "v3", data: { id: "a", body: "last" } }
      ])
      storage.commitBatch()
      await storage.flush()
      expect(db.sqlite.query(`SELECT row_key, version_key, value FROM ${ROW_TABLE_NAME}`).all()).toEqual([
        { row_key: "s:a", version_key: "v3", value: JSON.stringify({ id: "a", body: "last" }) }
      ])
    } finally { db.sqlite.close() }
  })

  test("repairs old truncated Code toast keys before boot dismisses their full ids", async () => {
    const db = database()
    const spec = [{ id: "app-toasts", schema: z.object({ id: z.string(), title: z.string() }) }]
    await openSqliteRowStorage(db.host, { collections: spec, schemaVersion: 9 })
    const id = "toast-files.read:owner/repo\u0000flows/a.ts"
    const data = { id, title: "Reading flows/a.ts" }
    // wa-sqlite bind_text uses a NUL-terminated C string: this is the row it wrote.
    db.sqlite.run(`INSERT INTO ${ROW_TABLE_NAME} VALUES (?, ?, ?, ?)`,
      ["app-toasts", "s:" + id.split("\u0000")[0], "old", JSON.stringify(data)])
    const reopened = await openSqliteRowStorage(db.host, { collections: spec, schemaVersion: 9 })
    const { createCollectionPersistence } = await import("./DurableCollection")
    const persistence = createCollectionPersistence({ storage: reopened.storage, rows: reopened, batch: reopened, flush: reopened.flush })
    expect(persistence.register("app-toasts")).toEqual([data])
    await persistence.persist({ mutations: [{ collection: { id: "app-toasts" }, key: id, type: "delete", original: data, modified: undefined }] })
    expect(db.sqlite.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()).toEqual([])
    await reopened.close()
  })

  /*
   * The defect this bounds: a profile with 890415370 bytes of OPFS SQLite
   * could not boot at all, because loading meant serializing a collection into
   * one string past V8's ~512 MiB ceiling — "prepare runtime and persisted
   * state: Invalid string length" (smithers.sh build 8e55636b, 2026-09-15).
   */
  test("a store past its budget loads the recent rows, reports the skipped ones, and deletes none", async () => {
    const db = database()
    const seeded = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    for (let index = 0; index < 40; index += 1) {
      seeded.applyRows("notes", [{
        key: `s:note-${String(index).padStart(3, "0")}`,
        versionKey: `v${index}`,
        data: { id: `note-${String(index).padStart(3, "0")}`, body: "b".repeat(200) }
      }])
    }
    await seeded.flush()

    const stored = db.sqlite.query(
      `SELECT row_key, value FROM ${ROW_TABLE_NAME} ORDER BY rowid DESC`
    ).all() as Array<{ row_key: string; value: string }>
    expect(stored.length).toBe(40)
    const size = (row: { row_key: string; value: string }): number => row.row_key.length + row.value.length
    // Exactly the three newest rows fit; the fourth crosses the line.
    const budgetBytes = size(stored[0]!) + size(stored[1]!) + size(stored[2]!)

    const bounded = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9, budgetBytes })
    expect(bounded.loadReport.loaded).toBe(3)
    expect(bounded.loadReport.skipped).toBe(37)
    expect(bounded.loadReport.budgetBytes).toBe(budgetBytes)
    expect(bounded.loadReport.collections).toEqual([
      { collectionId: "notes", loaded: 3, skipped: 37, loadedBytes: budgetBytes, skippedBytes: expect.any(Number) }
    ])
    // The recent part, newest first, and nothing older.
    expect([...bounded.readRows("notes").keys()].sort()).toEqual(["s:note-037", "s:note-038", "s:note-039"])
    // The whole-collection string view now fits, because it holds only those.
    expect(Object.keys(JSON.parse(bounded.storage.getItem("smithers-mvp.notes")!)).sort())
      .toEqual(["s:note-037", "s:note-038", "s:note-039"])
    // Skipped rows stay on disk, unparsed and undeleted: recovery still reaches them.
    expect(db.sqlite.query(`SELECT COUNT(*) AS n FROM ${ROW_TABLE_NAME}`).get()).toEqual({ n: 40 })
    expect(db.sqlite.query(`SELECT COUNT(*) AS n FROM ${QUARANTINE_TABLE_NAME}`).get()).toEqual({ n: 0 })
    await bounded.close()
  })

  /*
   * The budget has to bound what the page READS, not only what it keeps.
   *
   * The first bounded loader selected every row's `value` and then discarded
   * the ones over budget, so opening a 567,535,882-byte OPFS profile still
   * marshalled the whole store out of the wa-sqlite worker before admitting one
   * budget of it. That launch spent itself inside the load: smithers.sh build
   * 5136850c (2026-09-15 16:50Z) logged
   *
   *   Smithers: the persisted store is larger than one launch loads; older rows
   *   stayed on disk. {budgetBytes: 67108864, loaded: 260, skipped: 455,
   *   collections: Array(1)}
   *
   * and then rendered nothing but the 384-character entrance wordmark — both
   * Suspense fallbacks still mounted, no composer, no cards, no error panel,
   * because nothing had thrown. A fresh profile booted normally.
   */
  test("a bounded open reads only the rows it admits, not the whole store", async () => {
    const db = database()
    let valueBytesRead = 0
    const metered: SqliteRowDatabase = {
      execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []) => {
        const rows = await db.host.execute<TRow>(sql, params)
        for (const row of rows) {
          const value = (row as { readonly value?: unknown }).value
          if (typeof value === "string") valueBytesRead += new TextEncoder().encode(value).byteLength
        }
        return rows
      }
    }
    const seeded = await openSqliteRowStorage(metered, { collections, schemaVersion: 9 })
    for (let index = 0; index < 100; index += 1) {
      seeded.applyRows("notes", [{
        key: `s:note-${String(index).padStart(3, "0")}`,
        versionKey: `v${index}`,
        data: { id: `note-${String(index).padStart(3, "0")}`, body: "b".repeat(100_000) }
      }])
    }
    await seeded.flush()
    const stored = Number(
      (db.sqlite.query(`SELECT SUM(LENGTH(value)) AS bytes FROM ${ROW_TABLE_NAME}`).get() as { bytes: number }).bytes
    )
    expect(stored).toBeGreaterThan(10_000_000)

    valueBytesRead = 0
    const budgetBytes = 1_000_000
    const bounded = await openSqliteRowStorage(metered, { collections, schemaVersion: 9, budgetBytes })
    expect(bounded.loadReport.skipped).toBe(91)
    // One budget, not ten. The planning pass reads sizes; only admitted rows
    // hand over their value; unadmitted bodies never cross the worker boundary.
    expect(valueBytesRead).toBeLessThanOrEqual(budgetBytes)
    expect(bounded.readRows("notes").size).toBe(9)
    await bounded.close()
    await seeded.close()
    db.sqlite.close()
  })

  test("value pages obey UTF-8 bytes and row count without one query per admitted row", async () => {
    const db = database()
    try {
      const seeded = await openSqliteRowStorage(db.host, { collections, schemaVersion: 13 })
      seeded.beginBatch()
      for (let index = 0; index < 16; index += 1) seeded.applyRows("notes", [{
        key: `s:note-${index}`, versionKey: "v1", data: { id: `note-${index}`, body: "😀".repeat(150_000) }
      }])
      for (let index = 0; index < 600; index += 1) seeded.applyRows("widgets", [{
        key: `s:widget-${index}`, versionKey: "v1", data: { id: `widget-${index}`, label: "small" }
      }])
      seeded.commitBatch()
      await seeded.flush()
      const pages: Array<{ count: number; bytes: number }> = []
      const reopened = await openSqliteRowStorage({ execute: async <T>(sql: string, params?: ReadonlyArray<unknown>) => {
        const rows = await db.host.execute<T>(sql, params)
        if (sql.includes("WHERE rowid IN")) {
          const values = rows as ReadonlyArray<{ row_key: string; value: string }>
          pages.push({ count: values.length, bytes: values.reduce((bytes, row) =>
            bytes + new TextEncoder().encode(row.row_key).byteLength + new TextEncoder().encode(row.value).byteLength, 0) })
        }
        return rows
      } }, { collections, schemaVersion: 13 })
      expect(reopened.loadReport.loaded).toBe(616)
      expect(pages.length).toBeGreaterThan(2)
      expect(pages.length).toBeLessThan(10)
      expect(Math.max(...pages.map(page => page.count))).toBe(PERSISTED_LOAD_CHUNK_ROWS)
      for (const page of pages) {
        expect(page.count).toBeLessThanOrEqual(PERSISTED_LOAD_CHUNK_ROWS)
        expect(page.bytes).toBeLessThanOrEqual(PERSISTED_LOAD_PAGE_BYTES)
      }
      expect((reopened.readRows("notes").get("s:note-0")?.data as { body: string }).body).toBe("😀".repeat(150_000))
    } finally { db.sqlite.close() }
  })

  test("complete metadata admission refuses before even an earlier admitted value is fetched", async () => {
    const db = database()
    try {
      const complete = [{ id: "notes", schema: NoteSchema, partialLoad: "refuse" as const }]
      const seeded = await openSqliteRowStorage(db.host, { collections: complete, schemaVersion: 13 })
      // Newest row fits; older row forces refusal before the second pass begins.
      seeded.applyRows("notes", [{ key: "s:old", versionKey: "v1", data: { id: "old", body: "😀".repeat(200) } },
        { key: "s:new", versionKey: "v1", data: { id: "new", body: "fits" } }])
      await seeded.flush()
      const before = db.sqlite.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()
      let pages = 0
      await expect(openSqliteRowStorage({ execute: async (sql, params) => {
        if (sql.includes("WHERE rowid IN")) pages += 1
        return db.host.execute(sql, params)
      } }, { collections: complete, schemaVersion: 13, budgetBytes: 500 })).rejects.toBeInstanceOf(OversizedSqliteCollectionError)
      expect(pages).toBe(0)
      expect(db.sqlite.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()).toEqual(before)
    } finally { db.sqlite.close() }
  })

  test("a missing admitted value refuses instead of inventing a partial collection", async () => {
    const db = database()
    try {
      const seeded = await openSqliteRowStorage(db.host, { collections, schemaVersion: 13 })
      seeded.applyRows("notes", [{ key: "s:a", versionKey: "v1", data: { id: "a", body: "kept" } }])
      await seeded.flush()
      await expect(openSqliteRowStorage({ execute: async <T>(sql: string, params?: ReadonlyArray<unknown>) => {
        const rows = await db.host.execute<T>(sql, params)
        return sql.includes("WHERE rowid IN") ? [] : rows
      } }, { collections, schemaVersion: 13 })).rejects.toThrow("normalized row metadata is unreadable")
      expect((db.sqlite.query(`SELECT COUNT(*) AS count FROM ${ROW_TABLE_NAME}`).get() as { count: number }).count).toBe(1)
    } finally { db.sqlite.close() }
  })

  test("a single row larger than one read page is read whole and alone", async () => {
    const db = database()
    try {
      const seeded = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
      const body = "b".repeat(PERSISTED_LOAD_PAGE_BYTES + 1_000)
      seeded.applyRows("notes", [{ key: "s:huge", versionKey: "v1", data: { id: "huge", body } },
        { key: "s:small", versionKey: "v1", data: { id: "small", body: "small" } }])
      await seeded.flush()
      const pages: ReadonlyArray<unknown>[] = []
      const reopened = await openSqliteRowStorage({ execute: async <T>(sql: string, params?: ReadonlyArray<unknown>) => {
        const rows = await db.host.execute<T>(sql, params)
        if (sql.includes("WHERE rowid IN")) pages.push(rows)
        return rows
      } }, { collections, schemaVersion: 9 })
      expect(reopened.loadReport.skipped).toBe(0)
      expect(pages.map(page => page.length)).toEqual([1, 1])
      expect((reopened.readRows("notes").get("s:huge")?.data as { body: string }).body).toBe(body)
    } finally { db.sqlite.close() }
  })

  test("a whole store inside its budget loads completely and reports nothing skipped", async () => {
    const db = database()
    const storage = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    storage.applyRows("widgets", [{ key: "s:a", versionKey: "v1", data: { id: "a", label: "A" } }])
    await storage.flush()
    const reopened = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    expect(reopened.loadReport).toEqual({ loaded: 1, skipped: 0, budgetBytes: PERSISTED_COLLECTION_BUDGET_BYTES, collections: [] })
    expect([...reopened.readRows("widgets").keys()]).toEqual(["s:a"])
    await reopened.close()
  })

  test("the chunked read spans more rows than one chunk holds", async () => {
    const db = database()
    const storage = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    const total = PERSISTED_LOAD_CHUNK_ROWS + 7
    storage.beginBatch()
    for (let index = 0; index < total; index += 1) {
      storage.applyRows("widgets", [{ key: `s:w-${index}`, versionKey: "v1", data: { id: `w-${index}`, label: "L" } }])
    }
    storage.commitBatch()
    await storage.flush()
    const reopened = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    expect(reopened.loadReport.loaded).toBe(total)
    expect(reopened.readRows("widgets").size).toBe(total)
    await reopened.close()
  })

  test("an oversized authoritative collection refuses before fetching its value and preserves every source byte", async () => {
    const db = database()
    try {
      const complete = [{ id: "notes", schema: NoteSchema, partialLoad: "refuse" as const }]
      const seeded = await openSqliteRowStorage(db.host, { collections: complete, schemaVersion: 13 })
      seeded.applyRows("notes", [
        { key: "s:private", versionKey: "v1", data: { id: "private", body: "😀".repeat(100) } },
        { key: "s:older", versionKey: "v1", data: { id: "older", body: "😀".repeat(100) } }
      ])
      await seeded.flush()
      const before = db.sqlite.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()
      const reads: string[] = []
      await expect(openSqliteRowStorage({ execute: async (sql, params) => {
        reads.push(sql)
        return db.host.execute(sql, params)
      } }, { collections: complete, schemaVersion: 13, budgetBytes: 100 })).rejects.toBeInstanceOf(OversizedSqliteCollectionError)
      expect(reads.some(sql => /SELECT[\s\S]*[, ]value FROM/.test(sql) && sql.includes("WHERE rowid"))).toBe(false)
      expect(reads.at(-1)).toBe("ROLLBACK")
      expect(db.sqlite.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()).toEqual(before)
      expect(db.sqlite.query(`SELECT * FROM ${QUARANTINE_TABLE_NAME}`).all()).toEqual([])
    } finally { db.sqlite.close() }
  })

  test("a collection whose one row is its whole state loads it whatever the budget", async () => {
    const db = database()
    try {
      const complete = [{ id: "notes", schema: NoteSchema, partialLoad: "refuse" as const }]
      const seeded = await openSqliteRowStorage(db.host, { collections: complete, schemaVersion: 13 })
      seeded.applyRows("notes", [{ key: "s:whole", versionKey: "v1", data: { id: "whole", body: "😀".repeat(100) } }])
      await seeded.flush()
      const reopened = await openSqliteRowStorage(db.host, { collections: complete, schemaVersion: 13, budgetBytes: 100 })
      expect(reopened.readRows("notes").get("s:whole")?.data).toEqual({ id: "whole", body: "😀".repeat(100) })
      expect(reopened.loadReport).toMatchObject({ loaded: 1, skipped: 0 })
      await reopened.close()
    } finally { db.sqlite.close() }
  })

  test("the first metadata page cannot silently omit a maximum-safe rowid", async () => {
    const db = database()
    try {
      await openSqliteRowStorage(db.host, { collections, schemaVersion: 13 })
      db.sqlite.query(`INSERT INTO ${ROW_TABLE_NAME} (rowid, collection_id, row_key, version_key, value) VALUES (?, 'notes', 's:last', 'v1', ?)`).run(
        Number.MAX_SAFE_INTEGER, JSON.stringify({ id: "last", body: "Complete snapshot" }))
      const reopened = await openSqliteRowStorage(db.host, { collections, schemaVersion: 13 })
      expect(reopened.readRows("notes").get("s:last")?.data).toEqual({ id: "last", body: "Complete snapshot" })
    } finally { db.sqlite.close() }
  })

  test("chunked loading keeps exact stored bytes for normalization-aware compare-and-swap", async () => {
    const db = database()
    try {
      const seeded = await openSqliteRowStorage(db.host, { collections, schemaVersion: 13 })
      seeded.applyRows("notes", [{ key: "s:a", versionKey: "v1", data: { id: "a", body: "before" } }])
      await seeded.flush()
      db.sqlite.query(`UPDATE ${ROW_TABLE_NAME} SET value = ? WHERE collection_id = 'notes'`).run('{ "id": "a", "body": "before" }')
      const reopened = await openSqliteRowStorage(db.host, { collections, schemaVersion: 13 })
      reopened.applyRows("notes", [{ key: "s:a", expectedVersionKey: "v1", versionKey: "v2", data: { id: "a", body: "after" } }])
      await reopened.flush()
      expect(JSON.parse((db.sqlite.query(`SELECT value FROM ${ROW_TABLE_NAME}`).get() as { value: string }).value).body).toBe("after")
    } finally { db.sqlite.close() }
  })

  test("undeclared collection metadata carries the same stale-writer protection", async () => {
    const db = database()
    try {
      const winner = await openSqliteRowStorage(db.host, { collections: [], schemaVersion: 9 })
      winner.applyRows("private-heads", [{ key: "s:current", versionKey: "v1", data: { cursor: 1 } }])
      await winner.flush()
      const stale = await openSqliteRowStorage(db.host, { collections: [], schemaVersion: 9 })
      expect(stale.storage.getItem("smithers-mvp.private-heads")).toContain('"cursor":1')
      winner.applyRows("private-heads", [{ key: "s:current", expectedVersionKey: "v1", versionKey: "v2", data: { cursor: 2 } }])
      await winner.flush()
      stale.applyRows("private-heads", [{ key: "s:current", expectedVersionKey: "v1", versionKey: "v3", data: { cursor: 2 } }])
      await expect(stale.flush()).rejects.toBeInstanceOf(DurableStorageConflictError)
      expect(db.sqlite.query(`SELECT value FROM ${METADATA_TABLE_NAME} WHERE key = ?`).get("smithers-mvp.private-heads"))
        .toEqual({ value: wire({ "s:current": { versionKey: "v2", data: { cursor: 2 } } }) })
    } finally { db.sqlite.close() }
  })

  test("independent stale writers cannot overwrite a row or commit any sibling writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-row-cas-"))
    const first = database(join(root, "state.sqlite"))
    const second = database(join(root, "state.sqlite"))
    try {
      const winner = await openSqliteRowStorage(first.host, { collections, schemaVersion: 9 })
      winner.storage.setItem("smithers-mvp.widgets", wire({ "s:a": { versionKey: "v1", data: { id: "a", label: "before" } } }))
      await winner.flush()
      const observed: string[] = []
      const stale = await openSqliteRowStorage({ execute: async (sql, params) => {
        observed.push(sql)
        return second.host.execute(sql, params)
      } }, { collections, schemaVersion: 9 })
      winner.applyRows("widgets", [{ key: "s:a", expectedVersionKey: "v1", versionKey: "v2", data: { id: "a", label: "winner" } }])
      await winner.flush()
      observed.length = 0
      stale.beginBatch()
      stale.applyRows("notes", [{ key: "s:n", versionKey: "n1", data: { id: "n", body: "must not write" } }])
      stale.applyRows("widgets", [{ key: "s:a", expectedVersionKey: "v1", versionKey: "v3", data: { id: "a", label: "stale" } }])
      stale.commitBatch()
      // This queued operation depends on the same rejected writer snapshot.
      stale.applyRows("notes", [{ key: "s:queued", versionKey: "n2", data: { id: "queued", body: "dependent" } }])
      await expect(stale.flush()).rejects.toBeInstanceOf(DurableStorageConflictError)
      expect(observed[0]).toBe("BEGIN IMMEDIATE")
      expect(observed.at(-1)).toBe("ROLLBACK")
      expect(observed.some((sql) => /^\s*(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false)
      expect(first.sqlite.query(`SELECT collection_id, version_key, value FROM ${ROW_TABLE_NAME}`).all()).toEqual([
        { collection_id: "widgets", version_key: "v2", value: JSON.stringify({ id: "a", label: "winner" }) }
      ])
    } finally {
      first.sqlite.close()
      second.sqlite.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test("compatibility batches refuse concurrent inserts and updates that retained the old version", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-row-cas-"))
    const first = database(join(root, "state.sqlite"))
    const second = database(join(root, "state.sqlite"))
    try {
      const winner = await openSqliteRowStorage(first.host, { collections, schemaVersion: 9 })
      const stale = await openSqliteRowStorage(second.host, { collections, schemaVersion: 9 })
      const key = "smithers-mvp.widgets"
      winner.storage.setItem(key, wire({ "s:a": { versionKey: "v1", data: { id: "a", label: "winner" } } }))
      await winner.flush()
      stale.storage.setItem(key, wire({ "s:a": { versionKey: "v1", data: { id: "a", label: "duplicate insert" } } }))
      await expect(stale.flush()).rejects.toBeInstanceOf(DurableStorageConflictError)
      const old = await openSqliteRowStorage(second.host, { collections, schemaVersion: 9 })
      // A codec repair may keep the version while rewriting the value.
      first.sqlite.query(`UPDATE ${ROW_TABLE_NAME} SET value = ? WHERE row_key = ?`).run(JSON.stringify({ id: "a", label: "normalized" }), "s:a")
      old.storage.removeItem(key)
      await expect(old.flush()).rejects.toBeInstanceOf(DurableStorageConflictError)
      expect(first.sqlite.query(`SELECT version_key, value FROM ${ROW_TABLE_NAME}`).get()).toEqual({
        version_key: "v1", value: JSON.stringify({ id: "a", label: "normalized" })
      })
    } finally {
      first.sqlite.close()
      second.sqlite.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a rolled-back write prevents queued deltas from committing against its missing rows", async () => {
    const db = database()
    const storage = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    db.sqlite.run(`CREATE TRIGGER refuse_a BEFORE INSERT ON ${ROW_TABLE_NAME}
      WHEN NEW.row_key = 's:a' BEGIN SELECT RAISE(ABORT, 'refused'); END`)
    const a = { versionKey: "v1", data: { id: "a", label: "A" } }
    const b = { versionKey: "v1", data: { id: "b", label: "B" } }
    storage.storage.setItem("smithers-mvp.widgets", wire({ "s:a": a }))
    storage.storage.setItem("smithers-mvp.widgets", wire({ "s:a": a, "s:b": b }))
    await expect(storage.flush()).rejects.toThrow("refused")
    expect(db.sqlite.query(`SELECT row_key FROM ${ROW_TABLE_NAME}`).all()).toEqual([])
    await expect(storage.close()).rejects.toThrow("refused")
  })
  test("persists entities as rows and commits a multi-collection batch atomically", async () => {
    const db = database()
    const storage = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    storage.beginBatch()
    storage.storage.setItem("smithers-mvp.widgets", wire({
      "s:a": { versionKey: "v1", data: { id: "a", label: "A" } },
      "s:b": { versionKey: "v1", data: { id: "b", label: "B" } }
    }))
    storage.storage.setItem("smithers-mvp.notes", wire({
      "s:n": { versionKey: "v1", data: { id: "n", body: "note" } }
    }))
    storage.commitBatch()
    await storage.flush()

    const rows = db.sqlite.query(
      `SELECT collection_id, row_key, value FROM ${ROW_TABLE_NAME} ORDER BY collection_id, row_key`
    ).all() as Array<{ collection_id: string; row_key: string; value: string }>
    expect(rows.map((row) => [row.collection_id, row.row_key])).toEqual([
      ["notes", "s:n"],
      ["widgets", "s:a"],
      ["widgets", "s:b"]
    ])
    expect(JSON.parse(rows[1]!.value)).toEqual({ id: "a", label: "A" })

    storage.beginBatch()
    storage.storage.setItem("smithers-mvp.widgets", wire({
      "s:a": { versionKey: "v2", data: { id: "a", label: "updated" } }
    }))
    storage.storage.removeItem("smithers-mvp.notes")
    storage.commitBatch()
    await storage.flush()
    expect(db.sqlite.query(`SELECT collection_id, row_key FROM ${ROW_TABLE_NAME}`).all()).toEqual([
      { collection_id: "widgets", row_key: "s:a" }
    ])
    await storage.close()
  })

  test("a failed statement rolls every collection in the batch back", async () => {
    const db = database()
    const storage = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    storage.storage.setItem("smithers-mvp.widgets", wire({
      "s:a": { versionKey: "v1", data: { id: "a", label: "before" } }
    }))
    await storage.flush()
    db.sqlite.run(
      `CREATE TRIGGER refuse_note BEFORE INSERT ON ${ROW_TABLE_NAME}
       WHEN NEW.collection_id = 'notes' BEGIN SELECT RAISE(ABORT, 'refused'); END`
    )
    storage.beginBatch()
    storage.storage.setItem("smithers-mvp.widgets", wire({
      "s:a": { versionKey: "v2", data: { id: "a", label: "after" } }
    }))
    storage.storage.setItem("smithers-mvp.notes", wire({
      "s:n": { versionKey: "v1", data: { id: "n", body: "boom" } }
    }))
    storage.commitBatch()
    await expect(storage.flush()).rejects.toThrow("refused")
    const rows = db.sqlite.query(`SELECT collection_id, value FROM ${ROW_TABLE_NAME}`).all() as Array<{
      collection_id: string
      value: string
    }>
    expect(rows).toEqual([{ collection_id: "widgets", value: JSON.stringify({ id: "a", label: "before" }) }])
    db.sqlite.close()
  })

  test("quarantines invalid rows and refuses newer schemas without mutation", async () => {
    const old = database()
    old.sqlite.run(`CREATE TABLE ${ROW_TABLE_NAME} (collection_id TEXT NOT NULL, row_key TEXT NOT NULL, version_key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (collection_id, row_key))`)
    old.sqlite.run(`CREATE TABLE ${METADATA_TABLE_NAME} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    old.sqlite.query(`INSERT INTO ${METADATA_TABLE_NAME} (key, value) VALUES (?, ?)`).run("schema-version", "8")
    old.sqlite.query(`INSERT INTO ${ROW_TABLE_NAME} VALUES (?, ?, ?, ?)`).run(
      "widgets", "s:bad", "v1", JSON.stringify({ id: "bad", label: 42 })
    )
    const migrated = await openSqliteRowStorage(old.host, { collections, schemaVersion: 9 })
    expect(old.sqlite.query(`SELECT count(*) AS count FROM ${ROW_TABLE_NAME}`).get()).toEqual({ count: 0 })
    expect(old.sqlite.query(`SELECT reason FROM ${QUARANTINE_TABLE_NAME}`).get()).toEqual({ reason: "schema-validation" })
    await migrated.close()

    const future = database()
    future.sqlite.run(`CREATE TABLE ${METADATA_TABLE_NAME} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    future.sqlite.query(`INSERT INTO ${METADATA_TABLE_NAME} (key, value) VALUES (?, ?)`).run("schema-version", "99")
    await expect(openSqliteRowStorage(future.host, { collections, schemaVersion: 9 }))
      .rejects.toBeInstanceOf(FutureSqliteSchemaError)
    expect(future.sqlite.query(`SELECT value FROM ${METADATA_TABLE_NAME} WHERE key = 'schema-version'`).get())
      .toEqual({ value: "99" })
    future.sqlite.close()
  })
})

describe("legacy SQLite imports", () => {
  const key = "smithers-mvp.widgets"
  const legacyRow = { versionKey: "old", data: { id: "a", label: "legacy" } }
  const seedKv = (sqlite: Database, entries: Record<string, string>) => {
    sqlite.run("CREATE TABLE smithers_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    for (const [key, value] of Object.entries(entries)) sqlite.query("INSERT INTO smithers_kv VALUES (?, ?)").run(key, value)
  }

  test("imports the historical envelope once, preserves originals and never resurrects deleted rows", async () => {
    const db = database()
    const raw = JSON.stringify({ version: 1, entries: { [key]: wire({ "s:a": legacyRow }) } })
    seedKv(db.sqlite, { "smithers-mvp.store": raw })
    const imported = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    expect(JSON.parse(imported.storage.getItem(key)!)).toEqual({ "s:a": legacyRow })
    expect(db.sqlite.query("SELECT value FROM smithers_kv").get()).toEqual({ value: raw })
    imported.storage.removeItem(key)
    await imported.flush()
    const reopened = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    expect(reopened.storage.getItem(key)).toBe("{}")
    expect(db.sqlite.query(`SELECT value FROM ${METADATA_TABLE_NAME} WHERE key = 'legacy-import-complete'`).get()).toEqual({ value: "1" })
    await reopened.close()
  })

  test("imports installed TanStack registry rows and quarantines malformed and incompatible originals", async () => {
    const db = database()
    db.sqlite.run("CREATE TABLE collection_registry (collection_id TEXT PRIMARY KEY, table_name TEXT, schema_version INTEGER)")
    db.sqlite.run("CREATE TABLE c_widgets (key TEXT PRIMARY KEY, value TEXT, metadata TEXT, row_version INTEGER)")
    db.sqlite.query("INSERT INTO collection_registry VALUES (?, ?, ?)").run("widgets", "c_widgets", 8)
    const insert = db.sqlite.query("INSERT INTO c_widgets VALUES (?, ?, NULL, ?)")
    insert.run("s:a", JSON.stringify(legacyRow.data), 3)
    insert.run("s:bad", JSON.stringify({ id: "bad", label: 42 }), 4)
    insert.run("s:broken", "{broken", 5)
    const store = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    expect(JSON.parse(store.storage.getItem(key)!)).toEqual({ "s:a": { ...legacyRow, versionKey: "sqlite-3" } })
    expect(db.sqlite.query(`SELECT row_key FROM ${QUARANTINE_TABLE_NAME} ORDER BY row_key`).all()).toEqual([{ row_key: "s:bad" }, { row_key: "s:broken" }])
    expect(db.sqlite.query("SELECT count(*) AS count FROM c_widgets").get()).toEqual({ count: 3 })
    await store.close()
  })

  test("validates per-collection KV maps while retaining newer normalized rows", async () => {
    const db = database()
    const initial = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    initial.storage.setItem(key, wire({ "s:a": { versionKey: "new", data: { id: "a", label: "current" } } }))
    await initial.flush()
    db.sqlite.run(`DELETE FROM ${METADATA_TABLE_NAME} WHERE key = 'legacy-import-complete'`)
    seedKv(db.sqlite, { [key]: wire({ "s:a": legacyRow, "s:b": { versionKey: "old", data: { id: "b", label: "saved" } }, "s:bad": { versionKey: "old", data: { id: "bad", label: false } } }) })
    const imported = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    const rows = JSON.parse(imported.storage.getItem(key)!)
    expect(rows["s:a"].data.label).toBe("current")
    expect(rows["s:b"].data.label).toBe("saved")
    expect(rows["s:bad"]).toBeUndefined()
    await imported.close()
  })

  test("failed import rolls back inserted rows and marker, so retry imports everything", async () => {
    const db = database()
    const initial = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    await initial.flush()
    db.sqlite.run(`DELETE FROM ${METADATA_TABLE_NAME} WHERE key = 'legacy-import-complete'`)
    seedKv(db.sqlite, { [key]: wire({ "s:a": legacyRow, "s:b": { ...legacyRow, data: { id: "b", label: "B" } } }) })
    db.sqlite.run(`CREATE TRIGGER refuse_import BEFORE INSERT ON ${ROW_TABLE_NAME} WHEN NEW.row_key = 's:b' BEGIN SELECT RAISE(ABORT, 'refused import'); END`)
    await expect(openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })).rejects.toThrow("refused import")
    expect(db.sqlite.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()).toEqual([])
    expect(db.sqlite.query(`SELECT * FROM ${METADATA_TABLE_NAME} WHERE key = 'legacy-import-complete'`).get()).toBe(null)
    db.sqlite.run("DROP TRIGGER refuse_import")
    const reopened = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    expect(Object.keys(JSON.parse(reopened.storage.getItem(key)!))).toEqual(["s:a", "s:b"])
    await reopened.close()
  })

  test("future current or legacy schema stamps fail before importing rows or markers", async () => {
    for (const source of ["current", "kv", "registry"] as const) {
      const db = database()
      if (source === "registry") {
        db.sqlite.run("CREATE TABLE collection_registry (collection_id TEXT PRIMARY KEY, table_name TEXT, schema_version INTEGER)")
        db.sqlite.query("INSERT INTO collection_registry VALUES (?, ?, ?)").run("widgets", "c_widgets", 99)
      } else {
        seedKv(db.sqlite, { [key]: wire({ "s:a": legacyRow }), ...(source === "kv" ? { "smithers-mvp.schemaVersion": "99" } : {}) })
        if (source === "current") {
          db.sqlite.run(`CREATE TABLE ${METADATA_TABLE_NAME} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
          db.sqlite.query(`INSERT INTO ${METADATA_TABLE_NAME} VALUES (?, ?)`).run("schema-version", "99")
        }
      }
      await expect(openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })).rejects.toBeInstanceOf(FutureSqliteSchemaError)
      expect(db.sqlite.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()).toEqual([])
      expect(db.sqlite.query(`SELECT * FROM ${METADATA_TABLE_NAME} WHERE key = 'legacy-import-complete'`).get()).toBe(null)
      db.sqlite.close()
    }
  })

  test("an authoritative empty envelope does not restore stale registry records", async () => {
    const db = database()
    seedKv(db.sqlite, { "smithers-mvp.store": JSON.stringify({ version: 1, entries: {} }), [key]: wire({ "s:a": legacyRow }) })
    db.sqlite.run("CREATE TABLE collection_registry (collection_id TEXT PRIMARY KEY, table_name TEXT, schema_version INTEGER)")
    db.sqlite.query("INSERT INTO collection_registry VALUES (?, ?, ?)").run("widgets", "obsolete_table", 8)
    const store = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    expect(store.storage.getItem(key)).toBe("{}")
    await store.close()
  })
})
