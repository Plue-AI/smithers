import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { Database } from "bun:sqlite"
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import { APP_SCHEMA_VERSION } from "../chain/SchemaVersion"
import { openSqliteRowStorage } from "../chain/SqliteRowStorage"
import { createAppStore, PERSISTED_COLLECTION_SPECS } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, settled, silentAgent, waitFor } from "./TestFixtures"

GlobalRegistrator.register({ url: "https://owner.test/" })
afterAll(async () => { for (let tick = 0; tick < 3; tick++) await settled(); await GlobalRegistrator.unregister() })
const createController = scopedControllers()
const open = async (path: string, beforeCommit?: () => Promise<void>) => {
  const db = new Database(path)
  const adapter = await openSqliteRowStorage({
    execute: async <Row,>(sql: string, params: ReadonlyArray<unknown> = []) => {
      if (/^\s*COMMIT\b/i.test(sql)) await beforeCommit?.()
      const statement = db.query(sql)
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<Row>
      statement.run(...params as []); return []
    }, close: () => db.close()
  }, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION })
  return createAppStore({ kind: "opfs", ...adapter, storageEventApi: { addEventListener: () => {}, removeEventListener: () => {} } })
}

/*
 * The signed-out chat gate is the composer's producer of a sign-in prompt
 * since the browser turn driver left (90ef5aaccb). The prompt is shown only
 * from its committed receipt: never while SQLite holds the commit, never when
 * storage refuses it, and input stays usable meanwhile.
 */
for (const refusedSave of [false, true]) {
  test(`signed-out gate: a ${refusedSave ? "refused" : "held SQLite"} receipt cannot display a saved sign-in prompt`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-signin-receipt-")), path = join(directory, "app.sqlite")
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let hold = false, starts = 0
    const diagnostics: string[] = []
    const storage = memoryStorage()
    const store = refusedSave ? await createAppStore({ kind: "localStorage", storage: { ...storage, setItem: (key, value) => {
      if (hold) { hold = false; entered.resolve(); throw new Error("disk full") }
      storage.setItem(key, value)
    } } }) : await open(path, async () => {
      if (!hold) return
      hold = false
      entered.resolve(); await release.promise
    })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
    const controller = createController(store, { ...silentAgent, available: true, startTurn: async () => { starts++; return { status: "started" } } },
      { bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["agent", "identity"], authFlow: "credentials", sandbox: null },
        applicationIdentity: { current: async () => null }, fetchImpl: async () => Response.json({}, { status: 404 }),
        clientErrors: { report: (_kind, error) => { diagnostics.push(String(error)) }, reported: () => diagnostics.length } })
    const host = document.createElement("div"); document.body.append(host)
    const root = createRoot(host)
    flushSync(() => root.render(<ControllerTestProvider controller={controller}><App /></ControllerTestProvider>))
    try {
      await store.dispatch({ type: "composer.changed", actor: "user", draft: "Keep this request" }).isPersisted.promise
      await settled()
      await store.settled?.()
      hold = true
      const sent = controller.send("Keep this request")
      await entered.promise
      expect(store.collections.savedSignInPrompts.size).toBe(0)
      await settled()
      expect(host.querySelector("[data-testid=transcript]")?.textContent).not.toContain("Sign in with GitHub to send this message.")
      // Input remains usable while the gate waits for real persistence.
      const typing = store.dispatch({ type: "composer.changed", actor: "user", draft: "A newer draft" })
      expect(store.session().draft).toBe("A newer draft")
      await settled()
      expect(host.querySelector("[data-testid=transcript]")?.textContent).not.toContain("Sign in with GitHub to send this message.")
      release.resolve()
      await typing.isPersisted.promise.catch(() => {})
      expect(await sent).toBe(false)
      expect(starts).toBe(0)
      if (refusedSave) {
        await settled()
        expect(host.querySelector("[data-testid=transcript]")?.textContent).not.toContain("Sign in with GitHub to send this message.")
        expect([...store.collections.messages.values()].some(message => message.action?.flow === "sign-in")).toBe(false)
        expect(diagnostics.some(report => report.includes("\"seam\":\"turn.sign-in\""))).toBe(true)
      } else {
        await waitFor(() => host.textContent?.includes("Sign in with GitHub to send this message.") === true)
        const events = [...store.collections.transitions.values()]
        expect(events.filter(event => event.type === "chat.sign-in.required")).toHaveLength(1)
        expect(events.some(event => event.type === "message.submitted" || event.type === "message.response.completed")).toBe(false)
      }
      flushSync(() => root.unmount()); host.remove()
      await controller.dispose()
      const reopened = refusedSave ? await createAppStore({ kind: "localStorage", storage }) : await open(path)
      try {
        expect((await reopened.verifyState()).valid).toBe(true)
        if (!refusedSave) {
          expect(reopened.session().draft).toBe("A newer draft")
          expect([...reopened.collections.messages.values()].filter(message => message.action?.flow === "sign-in")).toHaveLength(1)
        }
      } finally { await reopened.dispose?.() }
    } finally {
      hold = false; release.resolve()
      if (host.isConnected) { flushSync(() => root.unmount()); host.remove() }
      await controller.dispose(); rmSync(directory, { recursive: true, force: true })
    }
  })
}
