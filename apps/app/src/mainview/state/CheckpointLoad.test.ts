import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PERSISTED_COLLECTION_BUDGET_BYTES, PERSISTED_JOURNAL_COMPACTION_BYTES } from "../chain/PersistenceBudget"
import { APP_SCHEMA_VERSION } from "../chain/SchemaVersion"
import { OversizedSqliteCollectionError, ROW_TABLE_NAME, openSqliteRowStorage } from "../chain/SqliteRowStorage"
import type { SqliteRowDatabase } from "../chain/SqliteRowStorage"
import { createAppStore, PERSISTED_COLLECTION_SPECS, type AppStore } from "./AppStore"

const opened: AppStore[] = []
const directories: string[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.dispose?.()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const temporaryPath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-checkpoint-load-"))
  directories.push(directory)
  return join(directory, "state.sqlite")
}

const host = (db: Database): SqliteRowDatabase => ({
  execute: async <Row>(sql: string, params: ReadonlyArray<unknown> = []) => {
    const statement = db.query(sql)
    if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<Row>
    statement.run(...params as [])
    return []
  },
  close: () => db.close()
})

const open = async (path: string, budgetBytes: number) => {
  const db = new Database(path)
  const adapter = await openSqliteRowStorage(host(db), {
    collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION, budgetBytes
  })
  const store = await createAppStore({ kind: "opfs", ...adapter,
    storageEventApi: { addEventListener: () => {}, removeEventListener: () => {} } })
  opened.push(store)
  return store
}

/** The stored bytes the bounded loader charges each collection. */
const storedBytes = (path: string): Map<string, number> => {
  const db = new Database(path, { readonly: true })
  try {
    return new Map(db.query(
      `SELECT collection_id AS id, SUM(length(CAST(row_key AS BLOB)) + length(CAST(value AS BLOB))) AS bytes
       FROM ${ROW_TABLE_NAME} GROUP BY collection_id`
    ).all().map(row => [(row as { id: string }).id, (row as { bytes: number }).bytes]))
  } finally { db.close() }
}

const readable = (store: AppStore) => ({
  cards: [...store.collections.cards.values()].map(card => card.id).sort(),
  notes: [...store.collections.worldDocuments.values()].map(note => `${note.id}:${note.body.length}`).sort()
})

const fill = (unit: string, bytes: number): string => unit.repeat(Math.ceil(bytes / unit.length))

/*
 * A profile whose every collection fits the load budget while the checkpoint,
 * which holds all of them at once, does not. This is the production shape: the
 * canary's app-event-checkpoints row exceeded the budget with no single
 * projected collection anywhere near it.
 */
const seedSpreadStore = async (path: string, budgetBytes: number): Promise<void> => {
  const store = await open(path, budgetBytes)
  const share = Math.floor((budgetBytes * 3) / 5 / 4)
  const body = fill("note body ", share)
  const content = fill("source line\n", share)
  for (let index = 0; index < 4; index += 1) {
    await store.dispatch({ type: "card.upsert", actor: "user", card: {
      id: `file-${index}`, kind: "file", title: `source-${index}.ts`, status: "active", createdAt: index + 1, ordinal: index,
      payload: { repo: "org/repo", path: `source-${index}.ts`, content, truncated: false }
    } }).isPersisted.promise
    await store.dispatch({ type: "world.document.upserted", actor: "user", document: {
      id: `note-${index}`, path: `notes/${index}.md`, title: `Note ${index}`, body,
      links: [], tags: [], sources: [], confidence: 1
    } }).isPersisted.promise
  }
  await store.compactEvents()
  await store.dispose?.()
  opened.splice(opened.indexOf(store), 1)
}

test("a checkpoint larger than the budget every collection fits still boots", async () => {
  const budgetBytes = 512 * 1024
  const path = temporaryPath()
  await seedSpreadStore(path, budgetBytes)

  const bytes = storedBytes(path)
  const over = [...bytes].filter(([, size]) => size > budgetBytes).map(([id]) => id)
  expect(over).toEqual(["app-event-checkpoints"])

  const reopened = await open(path, budgetBytes)
  const share = Math.floor((budgetBytes * 3) / 5 / 4)
  expect(readable(reopened)).toEqual({
    cards: ["file-0", "file-1", "file-2", "file-3"],
    notes: [...Array(4).keys()].map(index => `note-${index}:${fill("note body ", share).length}`).sort()
  })
  expect((await reopened.verifyState()).valid).toBe(true)
// Persisting eight large events, compacting, reopening and verifying is an I/O
// regression check; the collection's byte budget is not a five-second deadline.
}, 30_000)

test("a store compacted many times keeps one checkpoint and reopens at the tip", async () => {
  const path = temporaryPath()
  const store = await open(path, PERSISTED_COLLECTION_BUDGET_BYTES)
  for (let index = 0; index < 5; index += 1) {
    await store.dispatch({ type: "world.document.upserted", actor: "user", document: {
      id: `note-${index}`, path: `notes/${index}.md`, title: `Note ${index}`, body: `body ${index}`,
      links: [], tags: [], sources: [], confidence: 1
    } }).isPersisted.promise
    await store.compactEvents()
  }
  const before = readable(store)
  const head = (await store.eventHistory()).head
  await store.dispose?.()
  opened.splice(opened.indexOf(store), 1)

  const db = new Database(path, { readonly: true })
  try {
    expect(db.query(`SELECT row_key FROM ${ROW_TABLE_NAME} WHERE collection_id = 'app-event-checkpoints'`).all()).toHaveLength(1)
  } finally { db.close() }

  const reopened = await open(path, PERSISTED_COLLECTION_BUDGET_BYTES)
  expect(readable(reopened)).toEqual(before)
  expect((await reopened.eventHistory()).head).toMatchObject({ streamId: head.streamId, stateHash: head.stateHash })
  expect((await reopened.verifyState()).valid).toBe(true)
})

test("the production sentence names the store a returning browser can no longer open", () => {
  expect(new OversizedSqliteCollectionError("app-event-checkpoints", PERSISTED_COLLECTION_BUDGET_BYTES).message).toBe(
    "The app-event-checkpoints store exceeds the 67108864-byte load budget. Its complete history is required; opening was refused and its source was preserved."
  )
})

test("a checkpoint past the 64 MiB budget boots, and the next one is back under it", async () => {
  const path = temporaryPath()
  const seeded = await open(path, PERSISTED_COLLECTION_BUDGET_BYTES)
  await seeded.dispatch({ type: "card.upsert", actor: "user", card: {
    id: "kept", kind: "file", title: "kept.ts", status: "active", createdAt: 1, ordinal: 0,
    payload: { repo: "org/repo", path: "kept.ts", content: "kept source", truncated: false }
  } }).isPersisted.promise
  await seeded.compactEvents()
  await seeded.dispose?.()
  opened.splice(opened.indexOf(seeded), 1)

  // Insignificant JSON whitespace: the same checkpoint, past the budget on disk.
  const grown = new Database(path)
  try {
    const stored = grown.query(`SELECT value FROM ${ROW_TABLE_NAME} WHERE collection_id = 'app-event-checkpoints'`).get() as { value: string }
    grown.query(`UPDATE ${ROW_TABLE_NAME} SET value = ? WHERE collection_id = 'app-event-checkpoints'`)
      .run(`{${" ".repeat(PERSISTED_COLLECTION_BUDGET_BYTES)}${stored.value.slice(1)}`)
  } finally { grown.close() }
  expect(storedBytes(path).get("app-event-checkpoints")!).toBeGreaterThan(PERSISTED_COLLECTION_BUDGET_BYTES)

  const reopened = await open(path, PERSISTED_COLLECTION_BUDGET_BYTES)
  expect(readable(reopened)).toEqual({ cards: ["kept"], notes: [] })
  expect(reopened.collections.cards.get("kept")).toMatchObject({ payload: { content: "kept source" } })
  expect((await reopened.verifyState()).valid).toBe(true)
  await reopened.dispatch({ type: "card.upsert", actor: "user", card: {
    id: "later", kind: "file", title: "later.ts", status: "active", createdAt: 2, ordinal: 1,
    payload: { repo: "org/repo", path: "later.ts", content: "later source", truncated: false }
  } }).isPersisted.promise
  await reopened.compactEvents()
  await reopened.dispose?.()
  opened.splice(opened.indexOf(reopened), 1)
  expect(storedBytes(path).get("app-event-checkpoints")!).toBeLessThan(PERSISTED_COLLECTION_BUDGET_BYTES)
}, 120_000)

test("an event suffix past the compaction threshold is checkpointed before 64 events", async () => {
  const store = await open(temporaryPath(), PERSISTED_COLLECTION_BUDGET_BYTES)
  const content = fill("source line\n", PERSISTED_JOURNAL_COMPACTION_BYTES / 8)
  for (let index = 0; index < 8; index += 1) {
    await store.dispatch({ type: "card.upsert", actor: "user", card: {
      id: `file-${index}`, kind: "file", title: `source-${index}.ts`, status: "active", createdAt: index + 1, ordinal: index,
      payload: { repo: "org/repo", path: `source-${index}.ts`, content, truncated: false }
    } }).isPersisted.promise
  }
  for (let turn = 0; turn < 200 && (await store.eventHistory()).events.length > 0; turn += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const history = await store.eventHistory()
  expect(history.events).toEqual([])
  expect(history.checkpoint.reason).toBe("compaction")
  expect(history.checkpoint.sequence).toBe(history.head.sequence)
  expect((await store.verifyState()).valid).toBe(true)
}, 120_000)
