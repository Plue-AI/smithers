import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { StartupErrorBoundary } from "../StartupBoundary"
import { createAppStore, PERSISTED_COLLECTION_SPECS } from "./AppStore"
import { APP_SCHEMA_VERSION } from "../chain/SchemaVersion"
import { openSqliteRowStorage, OversizedSqliteCollectionError, ROW_TABLE_NAME } from "../chain/SqliteRowStorage"
import type { SqliteRowDatabase } from "../chain/SqliteRowStorage"
import { readSqliteRecovery } from "../chain/StorageRecovery"
import { RECOVERY_DOWNLOAD_LABEL, RECOVERY_RESET_LABEL } from "./StorageRecoveryContract"

GlobalRegistrator.register()
afterAll(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

/* A rejected use(bootPromise) reaches the startup boundary as this render throw. */
const RejectedBoot = ({ error }: { readonly error: unknown }) => { throw error }

test("an oversized app refuses with recovery actions and leaves complete authority available", async () => {
  const db = new Database(":memory:")
  const host: SqliteRowDatabase = { execute: async <T,>(sql: string, params: ReadonlyArray<unknown> = []) => {
    const statement = db.query(sql)
    if (/^\s*(?:SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<T>
    statement.run(...params as [])
    return []
  } }
  const open = (budgetBytes?: number) => openSqliteRowStorage(host, {
    collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION,
    ...(budgetBytes === undefined ? {} : { budgetBytes })
  })
  const boot = async (budgetBytes?: number) => createAppStore({ kind: "opfs", ...await open(budgetBytes),
    storageEventApi: { addEventListener: () => {}, removeEventListener: () => {} } })
  const element = document.createElement("div")
  document.body.append(element)
  const root = createRoot(element)
  try {
    expect(PERSISTED_COLLECTION_SPECS.every(spec => spec.partialLoad === "refuse")).toBe(true)
    const seeded = await boot()
    try {
      for (let index = 0; index < 6; index += 1) await seeded.dispatch({ type: "card.upsert", actor: "user", card: {
        id: `file-${index}`, kind: "file", title: `source-${index}.ts`, status: "active", createdAt: index + 1, ordinal: index,
        payload: { repo: "org/repo", path: `source-${index}.ts`, content: "private source 😀".repeat(8_000), truncated: false }
      } }).isPersisted.promise
      expect((await seeded.verifyState()).valid).toBe(true)
    } finally { await seeded.dispose?.() }
    const before = JSON.stringify(await readSqliteRecovery(host))
    const budgetBytes = 256 * 1024
    const bytes = (db.query(`SELECT SUM(length(CAST(value AS BLOB))) AS bytes FROM ${ROW_TABLE_NAME}`).get() as { bytes: number }).bytes
    expect(bytes).toBeGreaterThan(budgetBytes * 3)
    let refused: unknown
    try { const unexpected = await boot(budgetBytes); await unexpected.dispose?.() }
    catch (error) { refused = error }
    expect(refused).toBeInstanceOf(OversizedSqliteCollectionError)
    let reported: unknown
    const consoleError = console.error
    console.error = () => {}
    try {
      flushSync(() => root.render(<StartupErrorBoundary onError={error => { reported = error }}>
        <RejectedBoot error={refused} />
      </StartupErrorBoundary>))
    } finally { console.error = consoleError }
    expect(reported).toBe(refused)
    expect(element.querySelector("h1")?.textContent).toBe("This browser's saved data is too large for Smithers to open. Not your fault. It was kept as it was.")
    expect(element.querySelector("details pre")?.textContent).toContain("source was preserved")
    const buttons = [...element.querySelectorAll("button")]
    expect(buttons.map(button => button.textContent)).toEqual(expect.arrayContaining([RECOVERY_DOWNLOAD_LABEL, RECOVERY_RESET_LABEL]))
    expect(buttons.every(button => !button.disabled)).toBe(true)
    expect(element.textContent).not.toContain("private source")
    expect(element.querySelector(".smithers-composer")).toBeNull()
    // Raw recovery reads the same complete source even though bounded boot refused.
    expect(JSON.stringify(await readSqliteRecovery(host))).toBe(before)
    const recovered = await boot()
    try {
      expect(recovered.collections.cards.size).toBe(6)
      expect((await recovered.verifyState()).valid).toBe(true)
    } finally { await recovered.dispose?.() }
  } finally {
    flushSync(() => root.unmount())
    element.remove()
    db.close()
  }
}, 60_000)
