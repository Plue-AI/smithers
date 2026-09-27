import { afterEach, expect, test } from "bun:test"
import { createAppStore, type AppStore } from "./AppStore"
import { emptyAppProjection, seedAppProjection } from "./AppProjection"
import { projectRepositoryUpdate } from "./CardProjection"
import { notificationReceiptKey, notificationReadVersion, type RepositoryNotification } from "./RepositoryNotifications"
import { memoryStorage, writeLegacyCollection } from "./TestFixtures"
import type { Card } from "./AppState"

const stores: AppStore[] = []
afterEach(async () => { for (const store of stores.splice(0)) await store.dispose?.() })
const activity = (version = "v1", read = false): Extract<Card, { kind: "repo-update" }> => ({
  id: "activity", kind: "repo-update", title: "Activity", status: "active", createdAt: 1, ordinal: 0,
  payload: { scope: "github:one", repo: "org/repo", checkedAt: 1, summary: "One update", problems: [], openIssues: 1, openPrs: 0,
    items: [{ id: "notice", version, kind: "issue", number: 1, source: "smithers", title: "An issue", state: "open", tags: ["original"], read }] }
})
const notice = (version = "v1"): RepositoryNotification => ({ id: "notice", scope: "github:one", repo: "org/repo", source: "smithers", sourceId: "1", kind: "issue", number: 1,
  title: "An issue", state: "open", updatedAt: version, version, tags: ["original"], processedAt: 1 })
const observe = (store: AppStore, notification: RepositoryNotification) => store.dispatch({ type: "repo.update.observed", actor: "system",
  context: { id: "context", scope: "github:one", data: { repo: "org/repo", checkedAt: 1, openIssues: 1, openPrs: 0, problems: [], items: [], truncated: false } },
  notifications: [notification]
}).isPersisted.promise
const project = (store: AppStore, card: ReturnType<typeof activity>) => projectRepositoryUpdate(card,
  [...store.collections.repositoryNotifications.values()], [...store.collections.notificationReceipts.values()])

test("read receipts and tags join current and historical cards without copying mutations", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage }); stores.push(store)
  await observe(store, notice())
  await store.dispatch({ type: "card.upsert", actor: "system", card: activity() }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "system", card: { ...activity(), id: "current" } }).isPersisted.promise
  await store.dispatch({ type: "card.navigated", actor: "user", card: { id: "activity", kind: "file", title: "file", status: "active", createdAt: 1, ordinal: 0,
    payload: { repo: "org/repo", path: "file", content: "text", truncated: false } } }).isPersisted.promise
  const beforeCards = structuredClone([...store.collections.cards.values()])
  const beforeHistory = structuredClone([...store.collections.cardHistories.values()])
  await store.dispatch({ type: "notifications.read", actor: "user", receipts: [{ id: "notice", version: "v1" }] }).isPersisted.promise
  await store.dispatch({ type: "notification.tagged", actor: "user", id: "notice", tag: "follow-up" }).isPersisted.promise
  expect([...store.collections.cards.values()]).toEqual(beforeCards)
  expect([...store.collections.cardHistories.values()]).toEqual(beforeHistory)
  const saved = store.collections.cardHistories.get("activity")!.entries.find(card => card.kind === "repo-update")!
  if (saved.kind !== "repo-update") throw new Error("Missing saved activity")
  expect(project(store, saved).payload.items[0]).toMatchObject({ read: true, tags: ["original", "follow-up"] })
  expect(project(store, activity()).payload.items[0]?.read).toBe(true)
  expect(store.collections.repositoryNotifications.get("notice")?.readVersion).toBe("v1")
  await observe(store, { ...notice("v2"), tags: ["original", "follow-up"] })
  expect(store.collections.repositoryNotifications.get("notice")?.readVersion).toBeUndefined()
  expect(project(store, saved).payload.items[0]?.read).toBe(true)
  expect(project(store, activity("v2")).payload.items[0]?.read).toBe(false)
  await store.dispatch({ type: "notifications.read", actor: "user", receipts: [{ id: "notice", version: "v1" }] }).isPersisted.promise
  expect(store.collections.notificationReceipts.has(notificationReceiptKey("notice", "v2"))).toBe(false)
  await store.dispatch({ type: "notifications.read", actor: "user", receipts: [{ id: "notice", version: "v2" }] }).isPersisted.promise
  expect(store.collections.notificationReceipts.size).toBe(2)
  expect((await store.verifyState()).valid).toBe(true)
  await store.dispose?.()
  const restored = await createAppStore({ kind: "localStorage", storage }); stores.push(restored)
  expect(project(restored, saved).payload.items[0]).toMatchObject({ read: true, tags: ["original", "follow-up"] })
  expect(project(restored, activity("v2")).payload.items[0]?.read).toBe(true)
  expect(notificationReadVersion(notice("v2"), restored.collections.notificationReceipts)).toBe("v2")
  expect((await restored.verifyState()).valid).toBe(true)
})

test("legacy baseline retains observed current and historical read facts without invented timestamps", async () => {
  const storage = memoryStorage()
  const legacyNotice = { ...notice("v2"), readVersion: "v1" }
  const legacyHistory = { id: "activity", index: 0, entries: [activity("v0", true)] }
  writeLegacyCollection(storage, "app-repository-notifications", [legacyNotice])
  writeLegacyCollection(storage, "app-cards", [activity("v2", false)])
  writeLegacyCollection(storage, "app-card-histories", [legacyHistory])
  const store = await createAppStore({ kind: "localStorage", storage }); stores.push(store)
  expect([...store.collections.notificationReceipts.values()].map(row => row.version).sort()).toEqual(["v0", "v1"])
  expect([...store.collections.notificationReceipts.values()].every(row => Object.keys(row).filter(key => !key.startsWith("$" )).sort().join(",") === "id,notificationId,version")).toBe(true)
  expect(store.collections.repositoryNotifications.get("notice")?.readVersion).toBeUndefined()
  expect(project(store, activity("v0")).payload.items[0]?.read).toBe(true)
  expect(project(store, activity("v2")).payload.items[0]?.read).toBe(false)
  await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
  expect(store.collections.notificationReceipts.size).toBe(0)
})

test("pure boot also normalizes read evidence held only by archived frame or branch snapshots", () => {
  const baseline = seedAppProjection(emptyAppProjection(), { createdAt: 1, theme: "light" })
  const snapshot = (card: ReturnType<typeof activity>) => ({ revision: 1, messages: [], cards: [card], worldDocuments: [], draft: "" })
  const prior = { ...baseline,
    frames: baseline.frames.map(row => ({ ...row, snapshot: snapshot(activity("frame-version", true)) })),
    branches: baseline.branches.map(row => ({ ...row, snapshot: snapshot(activity("branch-version", true)) })) }
  const before = structuredClone(prior)
  const seeded = seedAppProjection(prior, { createdAt: 2, theme: "light" })
  expect(prior).toEqual(before)
  expect(seeded.notificationReceipts.map(row => row.version).sort()).toEqual(["branch-version", "frame-version"])
  expect(seedAppProjection(seeded, { createdAt: 3, theme: "light" }).notificationReceipts).toEqual(seeded.notificationReceipts)
})
