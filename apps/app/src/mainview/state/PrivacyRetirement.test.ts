import { installRequestId } from "./seams/InstallRequestId"
import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { beginPrivacyRetirement, completePrivacyRetirement, eraseLocalRecoveryCopies, readPrivacyRetirement,
  PRIVACY_RETIREMENT_KEY, PRIVACY_RETIREMENT_EVENT, type PrivacyStorage } from "../chain/PrivacyRetirement"
import { ENVELOPE_STORAGE_KEY, parseStorageEnvelope } from "../chain/TransactionalStorage"
import { APP_SCHEMA_VERSION, PERSISTENCE_BACKEND_STORAGE_KEY } from "../chain/SchemaVersion"
import { eraseSqliteRecoveryCopies } from "../chain/SqlitePrivacyRetirement"
import { openSqliteRowStorage, type SqliteRowDatabase } from "../chain/SqliteRowStorage"
import { readSqliteRecovery } from "../chain/StorageRecovery"
import { createAppStore, PERSISTED_COLLECTION_SPECS, type AppStore } from "./AppStore"
import { captureBrowserStorageRecovery, createRecoveryDownload } from "./BrowserStorageRecovery"
import { createStorageRecoveryAction } from "./StorageRecoveryAction"
import { createAuthBillingController } from "./controller/auth-billing"
import { createControllerContext } from "./controller/context"
import { unavailableAgent } from "./TestFixtures"

const secret = "PRIVATE-RETIRED-ACCOUNT-BYTES"
const memory = () => {
  const bytes = new Map<string, string>()
  const storage: PrivacyStorage = {
    get length() { return bytes.size }, key: index => [...bytes.keys()][index] ?? null,
    getItem: key => bytes.get(key) ?? null, setItem: (key, value) => { bytes.set(key, value) },
    removeItem: key => { bytes.delete(key) }
  }
  storage.setItem(PERSISTENCE_BACKEND_STORAGE_KEY, "localStorage")
  return { storage, bytes }
}
const stores: AppStore[] = []
afterEach(async () => { for (const store of stores.splice(0)) await Promise.resolve(store.dispose?.()).catch(() => {}) })
const open = async (storage: PrivacyStorage, eraseInactiveDatabase: () => Promise<void> = async () => {}) => {
  const store = await createAppStore({ backend: { kind: "localStorage", storage }, mode: "localStorage", degraded: false,
    privacy: { record: storage, eraseInactiveDatabase } })
  stores.push(store)
  return store
}
const fill = async (store: AppStore) => {
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
    admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "message.submitted", actor: "user", turnId: "private", text: secret }).isPersisted.promise
  await store.dispatch({ type: "world.document.upserted", actor: "user", document: {
    id: "local-note", title: "Local", path: "local.md", body: "permitted machine note", links: [], tags: [], sources: [], confidence: 1
  } }).isPersisted.promise
}
const database = () => {
  const db = new Database(":memory:")
  const host: SqliteRowDatabase = { execute: async <Row>(sql: string, params: ReadonlyArray<unknown> = []) => {
    const statement = db.query(sql)
    if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<Row>
    statement.run(...params as []); return []
  } }
  return { db, host }
}

describe("durable privacy retirement", () => {
  for (const fails of [false, true]) test(`signout waits for the privacy receipt before reporting completion (failure: ${fails})`, async () => {
    const { storage } = memory()
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const store = await open(storage, async () => { entered.resolve(); await release.promise; if (fails) throw new Error(secret) })
    await fill(store)
    const ctx = createControllerContext(store, unavailableAgent, { fetchImpl: async () => Response.json({}) })
    const auth = createAuthBillingController(ctx)
    let changed = 0, finished = false
    ctx.identityChanged = () => { changed++ }
    try {
      const signingOut = auth.signOut().finally(() => { finished = true })
      await entered.promise
      expect(finished).toBe(false)
      expect(changed).toBe(0)
      release.resolve()
      const result = await signingOut
      if (fails) {
        expect(result).toContain("Signed out. Smithers could not finish clearing this browser's data.")
        expect(result).not.toContain("Reload")
        expect(result).not.toContain(secret)
        expect(readPrivacyRetirement(storage)?.phase).toBe("pending")
        expect(changed).toBe(0)
      } else {
        expect(result).toBeUndefined()
        expect(readPrivacyRetirement(storage)?.phase).toBe("complete")
        expect(changed).toBe(1)
      }
    } finally { release.resolve(); await ctx.dispose() }
  })

  test("checkpoint write failure preserves the pending fence and rejects old live reads until a successful boot retry", async () => {
    const fixture = memory()
    let fail = false
    const storage: PrivacyStorage = { ...fixture.storage, get length() { return fixture.storage.length }, setItem: (key, value) => {
      if (fail && key === ENVELOPE_STORAGE_KEY) throw new Error("checkpoint disk failure")
      fixture.storage.setItem(key, value)
    } }
    const store = await open(storage)
    await fill(store)
    fail = true
    await expect(store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise).rejects.toThrow("disk failure")
    expect(readPrivacyRetirement(storage)?.phase).toBe("pending")
    expect(() => store.collections.messages.get("message-private-user")).toThrow("cleanup")
    expect(() => store.session()).toThrow("cleanup")
    await expect(store.eventHistory()).rejects.toThrow("cleanup")
    await expect(store.readRecovery()).rejects.toThrow()
    await Promise.resolve(store.dispose?.()).catch(() => {})
    fail = false
    const recovered = await open(storage)
    expect((await recovered.verifyState()).valid).toBe(true)
    expect(JSON.stringify([...fixture.bytes])).not.toContain(secret)
  })

  test("a refused intent cannot claim privacy completion or mutate saved rows", async () => {
    const fixture = memory()
    const storage: PrivacyStorage = { ...fixture.storage, get length() { return fixture.storage.length }, setItem: (key, value) => {
      if (key === PRIVACY_RETIREMENT_KEY) throw new Error("intent quota refusal")
      fixture.storage.setItem(key, value)
    } }
    const store = await open(storage)
    await fill(store)
    const before = [...fixture.bytes]
    expect(() => store.dispatch({ type: "identity.session.cleared", actor: "user" })).toThrow("quota")
    expect([...fixture.bytes]).toEqual(before)
    expect(() => store.agentContextSnapshot()).toThrow("cleanup")
  })

  test("reset removes permitted machine notes too, while preserving stream retirement identities", async () => {
    const { storage, bytes } = memory()
    const store = await open(storage)
    await fill(store)
    await store.dispatch({ type: "app.reset", actor: "user" }).isPersisted.promise
    expect(store.collections.worldDocuments.size).toBe(0)
    expect(JSON.stringify([...bytes])).not.toContain("permitted machine note")
    const entries = parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!.entries
    expect(Object.keys(JSON.parse(entries["smithers-mvp.app-event-retirements"]!)).length).toBeGreaterThan(0)
    expect(readPrivacyRetirement(storage)).toMatchObject({ phase: "complete", mode: "reset" })
  })

  test("real SQLite AppStore retirement removes legacy tables, unknown rows and inactive localStorage", async () => {
    const { db, host } = database()
    const { storage, bytes } = memory()
    storage.setItem(PERSISTENCE_BACKEND_STORAGE_KEY, "opfs")
    const adapter = await openSqliteRowStorage(host, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION })
    const store = await createAppStore({ backend: { kind: "opfs", ...adapter,
      storageEventApi: { addEventListener: () => {}, removeEventListener: () => {} } }, mode: "opfs", degraded: false,
      privacy: { record: storage, eraseInactiveDatabase: async () => { throw new Error("active DB must not be retired as inactive") } }
    })
    try {
      await fill(store)
      db.query("INSERT INTO smithers_collection_rows VALUES (?, ?, ?, ?)").run("unknown", "s:old", "v", secret)
      db.query("INSERT INTO smithers_metadata VALUES (?, ?)").run("unknown.private", secret)
      db.run("CREATE TABLE smithers_kv(key TEXT, value TEXT)")
      db.query("INSERT INTO smithers_kv VALUES (?, ?)").run("old", secret)
      db.run("CREATE TABLE collection_registry(collection_id TEXT, table_name TEXT, schema_version INTEGER)")
      db.run("CREATE TABLE c_old_notes(value TEXT)")
      db.query("INSERT INTO c_old_notes VALUES (?)").run(secret)
      db.query("INSERT INTO collection_registry VALUES ('old_notes', 'c_old_notes', 1)").run()
      db.query("INSERT INTO smithers_row_quarantine VALUES (?, ?, ?, ?, ?, ?)").run("old", "old", "x", secret, "old", "2026-09-14")
      db.run("ALTER TABLE smithers_collection_rows ADD COLUMN obsolete_private TEXT DEFAULT 'PRIVATE-RETIRED-ACCOUNT-BYTES'")
      db.run("CREATE INDEX old_private_index ON smithers_collection_rows(obsolete_private)")
      db.run("CREATE VIEW old_private_view AS SELECT 'PRIVATE-RETIRED-ACCOUNT-BYTES' AS value")
      db.run("ANALYZE")
      for (const key of [ENVELOPE_STORAGE_KEY, "smithers-mvp.old", "smithers-mvp-quarantine.store.old", "smithers-mvp.theme"]) storage.setItem(key, secret)
      await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
      expect(JSON.stringify(await store.readRecovery())).not.toContain(secret)
      expect(JSON.stringify([...bytes])).not.toContain(secret)
      expect(store.collections.worldDocuments.get("local-note")?.body).toBe("permitted machine note")
      expect((await store.verifyState()).valid).toBe(true)
      expect(readPrivacyRetirement(storage)?.phase).toBe("complete")
      expect(db.query("PRAGMA table_info(smithers_collection_rows)").all().map(row => (row as { name: string }).name)).toEqual(["collection_id", "row_key", "version_key", "value"])
    } finally { await store.dispose?.(); db.close() }
  })

  test("signout removes raw/quarantine/unknown current entries and inactive DB while preserving only permitted live notes", async () => {
    const { storage, bytes } = memory()
    const initial = await open(storage)
    await fill(initial)
    await initial.dispose?.()
    const envelope = parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!
    envelope.entries["smithers-mvp.obsolete-private-collection"] = secret
    storage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify(envelope))
    for (const key of ["smithers-mvp.app-messages", "smithers-mvp-quarantine.store.before-normalization", "smithers-mvp-quarantine.row.old.hash"]) storage.setItem(key, secret)
    storage.setItem("unrelated-app.private", "unrelated")
    const inactive = database()
    try {
      inactive.db.run("CREATE TABLE old_notes(value TEXT)")
      inactive.db.query("INSERT INTO old_notes VALUES (?)").run(secret)
      const store = await open(storage, () => eraseSqliteRecoveryCopies(inactive.host))
      await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
      expect(readPrivacyRetirement(storage)?.phase).toBe("complete")
      expect(JSON.stringify([...bytes])).not.toContain(secret)
      expect(storage.getItem("unrelated-app.private")).toBe("unrelated")
      expect(await readSqliteRecovery(inactive.host)).toEqual([])
      expect(store.collections.worldDocuments.get("local-note")?.body).toBe("permitted machine note")
      expect((await store.verifyState()).valid).toBe(true)
      await store.dispose?.()
      const reopened = await open(storage)
      expect(reopened.collections.messages.size).toBe(0)
      expect(reopened.collections.worldDocuments.get("local-note")?.body).toBe("permitted machine note")
    } finally { inactive.db.close() }
  })

  for (const phase of ["before-checkpoint", "after-checkpoint", "completion-write"] as const) {
    test(`restart resumes pending retirement ${phase} without adopting old recovery copies`, async () => {
      const fixture = memory()
      let failCompletion = false
      const storage: PrivacyStorage = { ...fixture.storage, get length() { return fixture.storage.length },
        setItem: (key, value) => {
          if (failCompletion && key === PRIVACY_RETIREMENT_KEY && value.includes('"phase":"complete"')) throw new Error("completion refused")
          fixture.storage.setItem(key, value)
        } }
      let failInactive = phase === "after-checkpoint"
      const store = await open(storage, async () => { if (failInactive) throw new Error("inactive database unavailable") })
      await fill(store)
      storage.setItem("smithers-mvp-quarantine.store.corrupt", secret)
      if (phase === "before-checkpoint") {
        beginPrivacyRetirement(storage, { id: installRequestId(), mode: "account", backend: "localStorage", targetStreamId: installRequestId() })
      } else {
        failCompletion = phase === "completion-write"
        await expect(store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise).rejects.toThrow()
        // Failed retirement cannot expose the previous account through the live public read surface.
        expect(() => store.collections.messages.size).toThrow("cleanup")
        expect(() => store.agentContextSnapshot()).toThrow("cleanup")
      }
      expect(readPrivacyRetirement(storage)?.phase).toBe("pending")
      await expect(store.readRecovery()).rejects.toThrow()
      expect(() => store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" })).toThrow("cleanup")
      await store.dispose?.()
      failInactive = false
      failCompletion = false
      const recovered = await open(storage)
      expect(readPrivacyRetirement(storage)?.phase).toBe("complete")
      expect(JSON.stringify([...fixture.bytes])).not.toContain(secret)
      expect(recovered.collections.worldDocuments.get("local-note")?.body).toBe("permitted machine note")
      expect((await recovered.verifyState()).valid).toBe(true)
    })
  }

  test("pending intent with missing authority refuses legacy adoption before modifying source bytes", async () => {
    const { storage, bytes } = memory()
    storage.setItem("smithers-mvp.app-messages", secret)
    beginPrivacyRetirement(storage, { id: "operation", mode: "account", backend: "localStorage", targetStreamId: "next" })
    const before = [...bytes]
    await expect(open(storage)).rejects.toThrow("cleanup")
    expect([...bytes]).toEqual(before)
  })

  test("degraded-memory signout leaves OPFS retirement pending and cannot report successful erasure", async () => {
    const { storage } = memory()
    storage.setItem(PERSISTENCE_BACKEND_STORAGE_KEY, "opfs")
    const transient = memory().storage
    const store = await createAppStore({ backend: { kind: "localStorage", storage: transient }, mode: "memory", degraded: true,
      privacy: { record: storage, eraseInactiveDatabase: async () => { throw new Error("unavailable") } } })
    stores.push(store)
    await fill(store)
    expect(() => store.dispatch({ type: "identity.session.cleared", actor: "user" })).toThrow("cleanup")
    expect(readPrivacyRetirement(storage)).toMatchObject({ phase: "pending", backend: "opfs" })
    await expect(store.readRecovery()).rejects.toThrow()
  })

  test("local deletion retries cannot remove other app data or forget the durable pending marker", () => {
    const { storage } = memory()
    const intent = beginPrivacyRetirement(storage, { id: "op", mode: "reset", backend: "localStorage", targetStreamId: "stream" })
    storage.setItem("smithers-mvp-quarantine.old", secret)
    storage.setItem("other.key", secret)
    const broken: PrivacyStorage = { ...storage, get length() { return storage.length }, removeItem: () => { throw new Error("disk") } }
    expect(() => eraseLocalRecoveryCopies(broken, new Set())).toThrow()
    expect(readPrivacyRetirement(storage)?.phase).toBe("pending")
    eraseLocalRecoveryCopies(storage, new Set())
    completePrivacyRetirement(storage, intent)
    expect(storage.getItem("other.key")).toBe(secret)
    expect(readPrivacyRetirement(storage)?.phase).toBe("complete")
  })

  test("normalized retirement rewrites exact permitted rows and rolls back all deletions when SQLite fails", async () => {
    const { db, host } = database()
    try {
      const adapter = await openSqliteRowStorage(host, { collections: [{ id: "notes", schema: z.object({ id: z.string(), body: z.string() }) }], schemaVersion: 12 })
      adapter.storage.setItem("smithers-mvp.notes", JSON.stringify({ "s:n": { versionKey: "v1", data: { id: "n", body: "permitted" } } }))
      await adapter.flush()
      db.query("INSERT INTO smithers_collection_rows VALUES (?, ?, ?, ?)").run("unknown", "s:old", "v", secret)
      db.run("CREATE TABLE smithers_kv(key TEXT, value TEXT)")
      db.query("INSERT INTO smithers_kv VALUES (?, ?)").run("old", secret)
      const permitted = new Map([["notes", new Map([["s:n", { id: "n", body: "permitted" }]])]])
      let fail = true
      const fault: SqliteRowDatabase = { execute: (sql, params) => {
        if (fail && sql.startsWith("DROP TABLE")) throw new Error("delete interrupted")
        return host.execute(sql, params)
      } }
      await expect(eraseSqliteRecoveryCopies(fault)).rejects.toThrow("interrupted")
      expect(db.query("SELECT value FROM smithers_kv").get()).toEqual({ value: secret })
      fail = false
      await adapter.retireRecoveryCopies(permitted)
      expect(JSON.stringify(await adapter.readRecovery())).not.toContain(secret)
      expect(db.query("SELECT row_key, version_key, value FROM smithers_collection_rows").all()).toEqual([
        { row_key: "s:n", version_key: "v1", value: JSON.stringify({ id: "n", body: "permitted" }) }
      ])
      adapter.storage.setItem("smithers-mvp.notes", JSON.stringify({ "s:n": { versionKey: "v2", data: { id: "n", body: "next" } } }))
      await adapter.flush()
    } finally { db.close() }
  })

  test("a captured old generation cannot download after a completed account boundary", async () => {
    const { storage } = memory()
    storage.setItem("smithers-mvp.old", secret)
    const snapshot = await captureBrowserStorageRecovery({ session: "localStorage", localStorage: storage, sqlite: undefined })
    const intent = beginPrivacyRetirement(storage, { id: "op", mode: "account", backend: "localStorage", targetStreamId: "stream" })
    eraseLocalRecoveryCopies(storage, new Set())
    completePrivacyRetirement(storage, intent)
    let downloads = 0
    const action = createStorageRecoveryAction({ read: async () => snapshot, download: () => { downloads++ } }, "user")
    try {
      expect(await action.run()).toContain("changed")
      expect(downloads).toBe(0)
      expect(JSON.stringify([...action.state.values()])).not.toContain(secret)
    } finally { await action.dispose() }
  })

  test("capture across an account boundary refuses even when both stores finish before release", async () => {
    const { storage } = memory()
    storage.setItem("smithers-mvp.old", secret)
    const waiting = Promise.withResolvers<readonly []>()
    const snapshot = captureBrowserStorageRecovery({ session: "unopened", localStorage: storage, sqlite: () => waiting.promise })
    const intent = beginPrivacyRetirement(storage, { id: "op", mode: "account", backend: "localStorage", targetStreamId: "stream" })
    eraseLocalRecoveryCopies(storage, new Set())
    completePrivacyRetirement(storage, intent)
    waiting.resolve([])
    await expect(snapshot).rejects.toThrow("changed")
  })

  test("privacy invalidation revokes pending Blob URLs and permits a later fresh download", () => {
    const page = new EventTarget()
    const revoked: string[] = []
    let created = 0
    const host = { defaultView: page, createElement: () => ({ click() {}, remove() {} }), body: { append() {} } } as unknown as Document
    const urls = { createObjectURL: () => `blob:${++created}`, revokeObjectURL: (url: string) => { revoked.push(url) } } as unknown as typeof URL
    const download = createRecoveryDownload(host, urls)
    try {
      download.download(secret)
      page.dispatchEvent(new Event(PRIVACY_RETIREMENT_EVENT))
      expect(revoked).toEqual(["blob:1"])
      download.download("current account")
      expect(created).toBe(2)
    } finally { download.dispose() }
    expect(revoked).toEqual(["blob:1", "blob:2"])
  })

  test("corrupt or future fences refuse boot/export without deleting opaque recovery data", async () => {
    for (const marker of ["broken", JSON.stringify({ version: 999 }), JSON.stringify({ version: 1, phase: "complete" })]) {
      const { storage, bytes } = memory()
      storage.setItem(PRIVACY_RETIREMENT_KEY, marker)
      storage.setItem("smithers-mvp-quarantine.old", secret)
      const before = [...bytes]
      await expect(open(storage)).rejects.toThrow("cleanup")
      await expect(captureBrowserStorageRecovery({ session: "unopened", localStorage: storage, sqlite: undefined })).rejects.toThrow()
      expect([...bytes]).toEqual(before)
    }
  })
})
