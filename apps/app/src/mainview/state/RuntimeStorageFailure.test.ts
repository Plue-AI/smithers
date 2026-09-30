import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { APP_SCHEMA_VERSION } from "../chain/SchemaVersion"
import { openSqliteRowStorage } from "../chain/SqliteRowStorage"
import { createAppStore, PERSISTED_COLLECTION_SPECS, type AppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, silentAgent } from "./TestFixtures"
import { STAGED_ENVELOPE_STORAGE_KEY } from "../chain/TransactionalStorage"
import { flowArgs } from "../flows/FlowArgs"

const controllerFor = scopedControllers()

for (const count of [1, 12]) test(`a refused real SQLite write stops ${count} pending signup commands and reports one runtime failure`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-write-failure-")), path = join(directory, "app.sqlite")
  const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  let armed = false, writesAfterFailure = 0, failed = false
  const originalWarn = console.warn
  const diagnostics: Array<ReadonlyArray<unknown>> = []
  let diagnosticSinkThrew = false
  const open = async () => {
    const db = new Database(path)
    const adapter = await openSqliteRowStorage({
      execute: async <Row>(sql: string, params: ReadonlyArray<unknown> = []) => {
        if (armed && sql === "BEGIN IMMEDIATE") {
          armed = false; entered.resolve(); await held.promise; failed = true
          throw new Error("PRIVATE WORKER FAILURE")
        }
        if (failed && !/^(SELECT|PRAGMA|ROLLBACK)/i.test(sql)) writesAfterFailure++
        const statement = db.query(sql)
        if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<Row>
        statement.run(...params as []); return []
      }, close: () => db.close()
    }, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION })
    return createAppStore({ kind: "opfs", ...adapter, close: async () => { try { await adapter.close() } catch (error) { if (!failed) throw error } }, storageEventApi: { addEventListener() {}, removeEventListener() {} } })
  }
  let store: AppStore | undefined, restored: AppStore | undefined
  try {
    store = await open()
    console.warn = (...parts: unknown[]) => {
      if (parts[0] !== "Smithers: local write failed") return originalWarn(...parts)
      diagnostics.push(parts)
      if (count === 12) { diagnosticSinkThrew = true; throw new Error("diagnostic sink failed") }
    }
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", provider: "github", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    const controller = controllerFor(store, silentAgent, {})
    await store.settled?.()
    const failures: Error[] = []
    // Observe the same store signal the browser host uses, without installing
    // a global failure that would leak into another test's document.
    store.onStorageFailure(error => { failures.push(error) })
    armed = true
    const pending = Array.from({ length: count }, (_, index) => controller.commands.run("signup.set", flowArgs("signup.set", { field: "name", value: `PRIVATE INPUT ${index}` })))
    await entered.promise
    expect(failures).toEqual([])
    held.resolve()
    const outcomes = await Promise.all(pending)
    expect(outcomes.every(outcome => outcome.status === "failed")).toBe(true)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.message).toBe("Changes could not be saved.")
    expect(diagnostics).toEqual([["Smithers: local write failed", {
      fault: "storage-unavailable", worker: "other", stage: "event"
    }]])
    expect(diagnosticSinkThrew).toBe(count === 12)
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE WORKER FAILURE")
    expect(controller.runCommand("account.show")).toBe(false)
    expect(() => controller.changeDraft("a later edit")).not.toThrow()
    expect(() => store!.dispatch({ type: "composer.changed", actor: "user", draft: "must not queue" })).toThrow()
    expect(writesAfterFailure).toBe(0)
    await controller.dispose().catch(() => {})
    failed = false
    restored = await open()
    expect(restored.session().signup?.draft).toEqual({ account: "owner" })
    expect(restored.session().draft).toBe("")
    expect(restored.collections.commandIntents.size).toBe(0)
    expect((await restored.verifyState()).valid).toBe(true)
    const retry = controllerFor(restored, silentAgent, {})
    expect((await retry.commands.run("signup.set", "name Retried name")).status).toBe("executed")
    expect(restored.session().signup?.draft.name).toBe("Retried name")
  } finally {
    console.warn = originalWarn
    held.resolve(); await Promise.resolve(restored?.dispose?.()).catch(() => {}); await Promise.resolve(store?.dispose?.()).catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a failed checkpoint names only its stage and still closes the SQLite writer", async () => {
  const db = new Database(":memory:")
  let fail = false
  const adapter = await openSqliteRowStorage({
    execute: async <Row>(sql: string, params: ReadonlyArray<unknown> = []) => {
      if (fail && sql === "BEGIN IMMEDIATE") throw new Error("PRIVATE CHECKPOINT SQL")
      const statement = db.query(sql)
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<Row>
      statement.run(...params as []); return []
    }, close: () => db.close()
  }, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION })
  const store = await createAppStore({ kind: "opfs", ...adapter,
    storageEventApi: { addEventListener() {}, removeEventListener() {} }
  })
  const diagnostics: Array<ReadonlyArray<unknown>> = []
  const originalWarn = console.warn
  console.warn = (...parts: unknown[]) => {
    if (parts[0] === "Smithers: local write failed") diagnostics.push(parts)
    else originalWarn(...parts)
  }
  try {
    const failures: Error[] = []
    store.onStorageFailure(error => { failures.push(error) })
    fail = true
    await expect(store.compactEvents()).rejects.toThrow("PRIVATE CHECKPOINT SQL")
    expect(diagnostics).toEqual([["Smithers: local write failed", {
      fault: "storage-unavailable", worker: "other", stage: "checkpoint"
    }]])
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE CHECKPOINT SQL")
    expect(failures.map(error => error.message)).toEqual(["Changes could not be saved."])
    expect(() => store.dispatch({ type: "composer.changed", actor: "user", draft: "must not queue" })).toThrow()
  } finally {
    console.warn = originalWarn
    await Promise.resolve(store.dispose?.()).catch(() => {})
  }
})

test("a recoverable localStorage refusal does not stop the controller or require reload", async () => {
  const bytes = memoryStorage(); let fail = false
  const store = await createAppStore({ kind: "localStorage", storage: { ...bytes, setItem: (key, value) => {
    if (fail && key === STAGED_ENVELOPE_STORAGE_KEY) throw new Error("temporary refusal")
    bytes.setItem(key, value)
  } } })
  const controller = controllerFor(store, silentAgent, {})
  try {
    await store.settled?.()
    const failures: Error[] = []
    store.onStorageFailure(error => { failures.push(error) })
    fail = true
    expect((await controller.commands.run("appearance.theme", "paper")).status).toBe("failed")
    expect(failures).toEqual([])
    fail = false
    expect(await controller.commands.run("appearance.theme", "paper")).toMatchObject({ status: "executed" })
    expect(store.session().palette).toBe("paper")
  } finally { fail = false; await controller.dispose(); await store.dispose?.() }
})

test("a queued privacy retirement still closes reads after an earlier SQLite write fails", async () => {
  const db = new Database(":memory:"), held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  let fail = false
  const adapter = await openSqliteRowStorage({
    execute: async <Row>(sql: string, params: ReadonlyArray<unknown> = []) => {
      if (fail && sql === "BEGIN IMMEDIATE") { entered.resolve(); await held.promise; throw new Error("private disk failure") }
      const statement = db.query(sql)
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<Row>
      statement.run(...params as []); return []
    }, close: () => db.close()
  }, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION })
  const bytes = new Map<string, string>()
  const record = { get length() { return bytes.size }, key: (index: number) => [...bytes.keys()][index] ?? null,
    getItem: (key: string) => bytes.get(key) ?? null, setItem: (key: string, value: string) => { bytes.set(key, value) },
    removeItem: (key: string) => { bytes.delete(key) } }
  const store = await createAppStore({ backend: { kind: "opfs", ...adapter, storageEventApi: { addEventListener() {}, removeEventListener() {} } },
    mode: "opfs", degraded: false, privacy: { record, eraseInactiveDatabase: async () => {} } })
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "old-owner", provider: "github", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    const failures: Error[] = []
    store.onStorageFailure(error => { failures.push(error) })
    fail = true
    const edit = store.dispatch({ type: "composer.changed", actor: "user", draft: "PRIVATE INPUT" }).isPersisted.promise
    void edit.catch(() => {})
    await entered.promise
    const retirement = store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    void retirement.catch(() => {})
    held.resolve()
    await Promise.allSettled([edit, retirement])
    expect(failures[0]?.message).toBe("Changes could not be saved.")
    expect(store.privacyWriteState()).toBe("failed")
    expect(() => store.session()).toThrow("Local privacy cleanup is incomplete")
  } finally { held.resolve(); await Promise.resolve(store.dispose?.()).catch(() => {}) }
})
