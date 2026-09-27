import { z } from "zod"
import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { openSqliteRowStorage, ROW_TABLE_NAME, type SqliteRowDatabase } from "../chain/SqliteRowStorage"
import { APP_SCHEMA_VERSION } from "../chain/SchemaVersion"
import { createAppStore } from "./AppStore"

const fixture = async () => {
  const db = new Database(":memory:")
  const statements: string[] = []
  const host: SqliteRowDatabase = {
    execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []) => {
      statements.push(sql)
      const query = db.query(sql)
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return query.all(...params as []) as ReadonlyArray<TRow>
      query.run(...params as [])
      return []
    }
  }
  const storage = await openSqliteRowStorage(host, { collections: [
    "app-sessions", "app-connector-operations", "world-documents", "app-identity-sessions",
    "app-billing-accounts", "app-cloud-sessions", "app-tabs", "app-workspaces", "app-branches", "app-frames"
  ].map((id) => ({ id, schema: z.object({ id: z.string() }).passthrough() })), schemaVersion: APP_SCHEMA_VERSION })
  statements.length = 0
  return { db, statements, backend: { kind: "opfs" as const, ...storage, storageEventApi: { addEventListener() {}, removeEventListener() {} } } }
}

test("a fresh store commits all nine seed collections in one SQLite transaction", async () => {
  const { db, statements, backend } = await fixture()
  try {
    const store = await createAppStore(backend)
    expect(statements.filter((sql) => /^BEGIN/i.test(sql))).toHaveLength(1)
    expect(db.query(`SELECT DISTINCT collection_id FROM ${ROW_TABLE_NAME}`).all()).toHaveLength(9)
    expect(store.session().id).toBe("main")
    await store.dispose?.()
  } finally { db.close() }
})

test("a rejected seed rolls back the entire initial store", async () => {
  const { db, backend } = await fixture()
  try {
    db.exec(`CREATE TRIGGER refuse_seed BEFORE INSERT ON ${ROW_TABLE_NAME}
      WHEN NEW.collection_id = 'app-billing-accounts' BEGIN SELECT RAISE(ABORT, 'refused seed'); END`)
    await expect(createAppStore(backend)).rejects.toThrow("refused seed")
    expect(db.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()).toHaveLength(0)
  } finally { db.close() }
})
