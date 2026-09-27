import type { StorageApi } from "@tanstack/db"
import { afterEach, expect, test } from "bun:test"
import { digest } from "@smthrs/core/Digest"
import { APP_PROJECTOR_VERSION, appProjectionHash } from "../state/AppEventStream"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"
import { canonicalEventValue } from "../state/EventValue"
import { memoryStorage } from "../state/TestFixtures"
import { ENVELOPE_STORAGE_KEY, parseStorageEnvelope } from "../chain/TransactionalStorage"

/*
 * The terminal and harness tabs retired (smithersai/smithers#2229). A store
 * saved by the previous projector still holds their rows, an `activeTabId`
 * pointing at one, and the `+` menu and close-question session fields. The
 * migration is the projector upgrade: the saved rows are validated against
 * this build's schemas (a terminal or harness row fails `TabSchema` and is
 * quarantined; the session's retired fields normalize away) and seed a fresh
 * stream, and boot reconciliation reselects main. Nothing replays the old
 * `pty.*`, `tab.menu.toggled`, `tab.close.asked` or `harnesses.loaded` events.
 */

const opened: AppStore[] = []
afterEach(async () => { for (const store of opened.splice(0)) await store.dispose?.() })
const open = async (storage: StorageApi) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  opened.push(store)
  return store
}
const editEnvelope = (storage: StorageApi, edit: (entries: Record<string, string>) => void) => {
  const envelope = parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!
  edit(envelope.entries)
  storage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify(envelope))
}
const rows = (entries: Record<string, string>, id: string): Record<string, { versionKey: string; data: Record<string, unknown> }> =>
  JSON.parse(entries[`smithers-mvp.${id}`] ?? "{}")

test("a store saved with terminal and harness tabs opens on its card tabs, active tab main, no menu or close question", async () => {
  const storage = memoryStorage()
  const store = await open(storage)
  await store.dispatch({ type: "card.upsert", actor: "user", card: {
    id: "balance", kind: "theme-picker", title: "Balance", status: "active", createdAt: 1, ordinal: 1, payload: { selected: "night-owl" }
  } }).isPersisted.promise
  await store.dispatch({ type: "tab.opened", actor: "user", tab: { id: "card-balance", kind: "card", title: "Balance", cardId: "balance" } }).isPersisted.promise
  await store.compactEvents()
  const old = await store.eventHistory()
  await store.dispose?.(); opened.splice(opened.indexOf(store), 1)

  // What the previous projector persisted: two process tabs, the harness one active with its close question open, the `+` menu open.
  const terminal = { id: "pty-1", kind: "terminal", title: "Terminal · ~", sessionId: "pty-1", cwd: "~", exitCode: 0, ordinal: 2 }
  const harness = { id: "pty-2", kind: "harness", title: "Claude Code · ~", sessionId: "pty-2", cwd: "~", harnessId: "claude", ordinal: 3 }
  const snapshot = structuredClone(old.checkpoint.snapshot) as Record<string, Array<Record<string, unknown>>>
  snapshot.tabs = [...snapshot.tabs!, terminal, harness]
  snapshot.harnesses = [{ id: "claude", displayName: "Claude Code", binary: "/usr/local/bin/claude", version: "2.0.0", status: "signed-in", account: { email: "will@example.com" }, launch: { argv: ["claude"] } }]
  Object.assign(snapshot.sessions![0]!, { activeTabId: "pty-2", tabMenuOpen: true, pendingTabCloseId: "pty-2" })
  const stateHash = appProjectionHash(snapshot as unknown as Parameters<typeof appProjectionHash>[0])
  const head = { ...old.head, projectorVersion: APP_PROJECTOR_VERSION - 1, stateHash }
  const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: APP_PROJECTOR_VERSION - 1, snapshot, stateHash }
  const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
  editEnvelope(storage, entries => {
    entries["smithers-mvp.app-event-heads"] = JSON.stringify({ "s:current": { versionKey: "fixture", data: head } })
    entries["smithers-mvp.app-event-checkpoints"] = JSON.stringify({ "s:current": { versionKey: "fixture", data: checkpoint } })
    const tabs = rows(entries, "app-tabs")
    for (const tab of [terminal, harness]) tabs[`s:${tab.id}`] = { versionKey: "fixture", data: tab }
    entries["smithers-mvp.app-tabs"] = JSON.stringify(tabs)
    entries["smithers-mvp.app-harnesses"] = JSON.stringify(Object.fromEntries(snapshot.harnesses!.map(row => [`s:${row.id}`, { versionKey: "fixture", data: row }])))
    const sessions = rows(entries, "app-sessions")
    for (const row of Object.values(sessions)) Object.assign(row.data, { activeTabId: "pty-2", tabMenuOpen: true, pendingTabCloseId: "pty-2" })
    entries["smithers-mvp.app-sessions"] = JSON.stringify(sessions)
  })

  const upgraded = await open(storage)
  expect([...upgraded.collections.tabs.values()].sort((left, right) => left.ordinal - right.ordinal).map(tab => tab.id)).toEqual(["main", "card-balance"])
  expect(upgraded.collections.tabs.get("card-balance")).toMatchObject({ kind: "card", cardId: "balance" })
  expect(upgraded.session().activeTabId).toBe("main")
  expect(upgraded.session()).not.toHaveProperty("tabMenuOpen")
  expect(upgraded.session()).not.toHaveProperty("pendingTabCloseId")
  expect((await upgraded.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
  expect((await upgraded.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
  expect((await upgraded.verifyState()).valid).toBe(true)
  // The reselection is journaled like every reconciliation, and a reopen keeps the result.
  expect([...upgraded.collections.transitions.values()].some(record => record.type === "tab.selected" && record.actor === "system")).toBe(true)
  await upgraded.dispose?.(); opened.splice(opened.indexOf(upgraded), 1)
  const reopened = await open(storage)
  expect([...reopened.collections.tabs.keys()].sort()).toEqual(["card-balance", "main"])
  expect(reopened.session().activeTabId).toBe("main")
})
