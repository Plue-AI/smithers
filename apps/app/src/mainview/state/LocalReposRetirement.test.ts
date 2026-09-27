import { Database } from "bun:sqlite"
import { APP_SCHEMA_VERSION } from "../chain/SchemaVersion"
import { openSqliteRowStorage, ROW_TABLE_NAME } from "../chain/SqliteRowStorage"
import { afterEach, expect, test } from "bun:test"
import { digest } from "@smthrs/core/Digest"
import { APP_PROJECTOR_VERSION, appProjectionHash } from "./AppEventStream"
import { createAppStore, PERSISTED_COLLECTION_SPECS, type AppStore } from "./AppStore"
import { canonicalEventValue } from "./EventValue"
import { memoryStorage } from "./TestFixtures"
import { ENVELOPE_STORAGE_KEY, parseStorageEnvelope } from "../chain/TransactionalStorage"

const opened: AppStore[] = []
const databases: Database[] = []
afterEach(async () => { for (const store of opened.splice(0)) await store.dispose?.(); for (const db of databases.splice(0)) db.close() })

test.each(["localStorage", "sqlite"].flatMap(backend => ["local:/checkout", "owner/repo#local:/checkout", "owner/repo", "owner/repo#workspace:box"].map(selection => ({ backend, selection }))))("retired inventory upgrades and reopens: %j", async ({ backend, selection }) => {
  const storage = memoryStorage()
  const open = async () => { const store = await createAppStore({ kind: "localStorage", storage }); opened.push(store); return store }
  const store = await open()
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "owner/repo", org: "owner", name: "repo", ownerKind: "user", head: null }] }).isPersisted.promise
  await store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [{ id: "box", repoId: "owner/repo", name: "Box", targetBookmark: null, status: "running", provisioningStage: null, suspendedAt: null, createdAt: null }] }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "kept", kind: "file", title: "README", status: "active", createdAt: 1, ordinal: 1, payload: { repo: "owner/repo", path: "README.md", content: "saved", truncated: false } } }).isPersisted.promise
  await store.dispatch({ type: "tab.opened", actor: "user", tab: { id: "card-kept", kind: "card", cardId: "kept", title: "README" } }).isPersisted.promise
  await store.compactEvents()
  const old = await store.eventHistory()
  await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
  const snapshot = structuredClone(old.checkpoint.snapshot) as Record<string, Array<Record<string, unknown>>>
  snapshot.repos = [{ id: "old", name: "owner/repo", path: "/checkout", warnings: [], git: null, smithers: { detected: false, workspaceFile: null, declarationFiles: [], workspaces: [], reason: "none" } }]
  snapshot.pinnedRepos = [{ id: "local:/checkout", name: "owner/repo", path: "/checkout", branch: null, origin: "local", pinnedAt: 1 }]
  snapshot.workingCopies!.push({ id: "local:/checkout", kind: "local", repoId: "owner/repo", label: "repo", path: "/checkout", updatedAt: 1, revision: 1 })
  snapshot.sessions![0]!.activeRepoKey = selection
  const stateHash = appProjectionHash(snapshot as unknown as Parameters<typeof appProjectionHash>[0])
  const head = { ...old.head, projectorVersion: APP_PROJECTOR_VERSION - 1, stateHash }
  const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: APP_PROJECTOR_VERSION - 1, snapshot, stateHash }
  const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
  const envelope = parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!
  for (const [name, rows] of Object.entries({ "app-repos": snapshot.repos, "app-pinned-repos": snapshot.pinnedRepos, "app-working-copies": snapshot.workingCopies!, "app-sessions": snapshot.sessions!, "app-event-heads": [head], "app-event-checkpoints": [checkpoint] })) {
    envelope.entries[`smithers-mvp.${name}`] = JSON.stringify(Object.fromEntries(rows.map(row => [`s:${row.id}`, { versionKey: "fixture", data: row }])))
  }
  storage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify(envelope))
  let openUpgraded = open
  if (backend === "sqlite") {
    const db = new Database(":memory:"); databases.push(db)
    const host = {
      execute: async <Row>(sql: string, params: ReadonlyArray<unknown> = []) => {
        const statement = db.query(sql)
        if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<Row>
        statement.run(...params as []); return []
      }, close: () => {}
    }
    const previous = await openSqliteRowStorage(host, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION - 1 })
    await previous.close()
    // Previous normalized SQLite rows, including the now-unknown collection.
    for (const [key, value] of Object.entries(envelope.entries)) {
      if (!key.startsWith("smithers-mvp.app-") && key !== "smithers-mvp.world-documents") continue
      for (const [rowKey, row] of Object.entries(JSON.parse(value) as Record<string, { versionKey: string; data: unknown }>)) {
        db.query(`INSERT INTO ${ROW_TABLE_NAME} (collection_id, row_key, version_key, value) VALUES (?, ?, ?, ?)`).run(key.slice("smithers-mvp.".length), rowKey, row.versionKey, JSON.stringify(row.data))
      }
    }
    openUpgraded = async () => {
      const adapter = await openSqliteRowStorage(host, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION })
      const upgraded = await createAppStore({ kind: "opfs", ...adapter, storageEventApi: { addEventListener: () => {}, removeEventListener: () => {} } })
      opened.push(upgraded); return upgraded
    }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const upgraded = await openUpgraded()
    expect(upgraded.collections).not.toHaveProperty("repos")
    expect(upgraded.collections.repositories.has("owner/repo")).toBe(true)
    expect(upgraded.collections.workingCopies.has("local:/checkout")).toBe(false)
    expect(upgraded.collections.pinnedRepos.size).toBe(0)
    expect(upgraded.session().activeRepoKey).toBe(selection.includes("local:") ? null : selection)
    expect(upgraded.collections.tabs.get("card-kept")).toMatchObject({ cardId: "kept" })
    expect(upgraded.collections.cards.get("kept")?.payload).toMatchObject({ content: "saved" })
    expect(upgraded.collections.workingCopies.has("workspace:box")).toBe(true)
    expect((await upgraded.verifyState()).valid).toBe(true)
    expect((await upgraded.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect(() => upgraded.dispatch({ type: "repos.loaded", actor: "system", repos: [] } as never)).toThrow()
    await upgraded.dispose?.(); opened.splice(opened.indexOf(upgraded), 1)
  }
})
