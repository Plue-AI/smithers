import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { Database } from "bun:sqlite"
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { CardView, type CardViewProps } from "../ChatCards"
import { APP_SCHEMA_VERSION } from "../chain/SchemaVersion"
import { openSqliteRowStorage, ROW_TABLE_NAME } from "../chain/SqliteRowStorage"
import { createAppStore, PERSISTED_COLLECTION_SPECS } from "./AppStore"
import { createAppController } from "./AppController"
import { settled, silentAgent } from "./TestFixtures"

GlobalRegistrator.register({ url: "https://activity.test/" })
afterAll(async () => { await settled(); await GlobalRegistrator.unregister() })
const createController = createAppController
const failureText = (error: unknown): string => error instanceof AggregateError
  ? [String(error), ...error.errors.map(failureText)].join("\n") : String(error)
const noop = () => {}
const handlers: Omit<CardViewProps, "card"> = {
  maximized: false, onDecideApproval: noop,
  onMaximize: noop, onMinimize: noop,
  onConnectGitHub: noop, onRunWorkflow: noop, onStopRun: noop,
  onRetryRun: noop, onChooseWorkflowRepo: noop, worldDocuments: [], onChangeWorldDocument: noop,
  onRunCommand: noop
}
const repo = "owner/repo"

for (const refresh of [false, true]) for (const interrupted of [false, true]) {
 test(`${refresh ? "refreshed" : "first"} activity waits for ${interrupted ? "an interrupted" : "a successful"} SQLite commit and restores only committed bodies`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-activity-receipt-"))
  const path = join(directory, "app.sqlite")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let hold = false, activityWrite = false
  const open = async () => {
    const db = new Database(path)
    const adapter = await openSqliteRowStorage({
      execute: async <Row,>(sql: string, params: ReadonlyArray<unknown> = []) => {
        if (hold && /^\s*INSERT\b/i.test(sql) && params[0] === "app-cards" &&
          typeof params[3] === "string" && JSON.parse(params[3]).kind === "repo-update") activityWrite = true
        if (hold && activityWrite && /^\s*COMMIT\b/i.test(sql)) {
          hold = false; entered.resolve(); await release.promise
          if (interrupted) throw new Error("Interrupted activity publication before SQLite COMMIT")
        }
        const statement = db.query(sql)
        if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<Row>
        statement.run(...params as []); return []
      }, close: () => db.close()
    }, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION })
    return createAppStore({ kind: "opfs", ...adapter,
      storageEventApi: { addEventListener: noop, removeEventListener: noop } })
  }
  const store = await open()
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", provider: "github", admin: false, scopesPlain: null }).isPersisted.promise
  let title = "Committed previous receipt"
  const controller = createController(store, silentAgent, {
    applicationIdentity: { current: async () => null },
    fetchImpl: async input => String(input).includes("/issues?state=open")
      ? Response.json([{ number: 1, title, state: "open", updated_at: "2026-09-29T00:00:00Z" }])
      : Response.json([])
  })
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  const paint = () => {
    const card = [...store.collections.cards.values()].find(card => card.kind === "repo-update")
    flushSync(() => root.render(card === undefined ? null : <CardView card={card} {...handlers} projectionStore={store} />))
  }
  if (refresh) {
    await controller.showRepoOverview(repo)
    await store.settled?.()
    paint()
    expect(host.textContent).toContain("Committed previous receipt")
    await settled()
  }
  title = "Uncommitted activity receipt"
  let completed = false, disposed = false
  hold = true
  const work = controller.showRepoOverview(repo).then(
    value => { completed = true; return { value } },
    error => { completed = true; return { error } }
  )
  try {
    await entered.promise
    expect(completed).toBe(false)
    const reader = new Database(path, { readonly: true })
    try {
      const saved = reader.query(`SELECT value FROM ${ROW_TABLE_NAME} WHERE collection_id = 'app-cards'`).all()
      expect(saved).toHaveLength(refresh ? 1 : 0)
      expect(JSON.stringify(saved)).not.toContain('Uncommitted activity receipt')
    } finally { reader.close() }
    paint(); await settled()
    // The public store may expose an optimistic card. Its user-visible result
    // must not look like a completed, reload-safe receipt before COMMIT.
    expect(host.textContent).not.toContain("Uncommitted activity receipt")
    if (refresh) {
      expect(host.textContent).toContain("Committed previous receipt")
    }
    controller.changeDraft("Chat remains usable")
    expect(store.session().draft).toBe("Chat remains usable")
    release.resolve()
    const outcome = await work
    if (interrupted) expect(outcome).toHaveProperty("error")
    else expect(outcome).toEqual({ value: { value: expect.stringContaining("Uncommitted activity receipt") } })
    if (interrupted) await store.settled?.().catch(error => { expect(failureText(error)).toContain("Interrupted activity publication before SQLite COMMIT") })
    else await store.settled?.()
    paint(); await settled()
    if (interrupted) {
      // A refused commit closes the controller and its views. The completed
      // body must never appear; the prior durable body is checked on reopen.
      expect(host.textContent).not.toContain("Uncommitted activity receipt")
    } else {
      expect(host.textContent).toContain("Uncommitted activity receipt")
    }
    flushSync(() => root.unmount()); host.remove(); await settled()
    disposed = true
    if (interrupted) await controller.dispose().catch(error => { expect(failureText(error)).toContain("Interrupted activity publication before SQLite COMMIT") })
    else await controller.dispose()
    const reopened = await open()
    try {
      expect((await reopened.verifyState()).valid).toBe(true)
      const saved = [...reopened.collections.cards.values()].filter(card => card.kind === "repo-update")
      if (interrupted && !refresh) expect(saved).toEqual([])
      else expect(saved).toContainEqual(expect.objectContaining({ kind: "repo-update",
        payload: expect.objectContaining({ items: expect.arrayContaining([expect.objectContaining({ title: interrupted ? "Committed previous receipt" : "Uncommitted activity receipt" })]) }) }))
      if (!interrupted) expect(reopened.session().draft).toBe("Chat remains usable")
      if (saved[0]) {
        const restoredHost = document.createElement("div"); document.body.append(restoredHost)
        const restoredRoot = createRoot(restoredHost)
        try {
          flushSync(() => restoredRoot.render(<CardView card={saved[0]!} {...handlers} projectionStore={reopened} />))
          expect(restoredHost.textContent).toContain(interrupted ? "Committed previous receipt" : "Uncommitted activity receipt")
        } finally { flushSync(() => restoredRoot.unmount()); restoredHost.remove() }
      }
      await reopened.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "bob", provider: "github", admin: false, scopesPlain: null }).isPersisted.promise
      expect(reopened.collections.savedRepositoryUpdates.size).toBe(0)
    } finally { await reopened.dispose?.() }
  } finally {
    hold = false; release.resolve(); await work.catch(() => {})
    if (host.isConnected) { flushSync(() => root.unmount()); host.remove(); await settled() }
    if (!disposed) {
      if (interrupted) await controller.dispose().catch(error => { expect(failureText(error)).toContain("Interrupted activity publication before SQLite COMMIT") })
      else await controller.dispose()
    }
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)

}
