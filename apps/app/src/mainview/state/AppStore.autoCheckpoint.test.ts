import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { memoryStorage } from "./TestFixtures"

const until = async (condition: () => Promise<boolean>) => {
  const deadline = Date.now() + 10_000
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error("Checkpoint maintenance did not settle")
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

test("idle checkpoint bounds reopen replay while retaining documents and later edits", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  try {
    await store.dispatch({ type: "world.document.upserted", actor: "user", document: {
      id: "kept", path: "kept.md", title: "Kept", body: "Preserve my work", links: [], tags: [], sources: [], confidence: 1
    } }).isPersisted.promise
    for (let index = 0; index < 67; index++) {
      await store.dispatch({ type: "theme.changed", actor: "user", theme: index % 2 === 0 ? "dark" : "light" }).isPersisted.promise
    }
    const before = await store.eventHistory()
    await until(async () => (await store.eventHistory()).checkpoint.sequence >= before.head.sequence)
    const compacted = await store.eventHistory()
    expect(compacted.events).toHaveLength(0)
    expect(compacted.head).toEqual(before.head)
    expect(store.collections.worldDocuments.get("kept")?.body).toBe("Preserve my work")
    expect((await store.verifyState()).valid).toBe(true)
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "Continue after checkpoint" }).isPersisted.promise
  } finally { await store.dispose?.() }
  const reopened = await createAppStore({ kind: "localStorage", storage })
  try {
    expect(reopened.collections.worldDocuments.get("kept")?.body).toBe("Preserve my work")
    expect(reopened.session().draft).toBe("Continue after checkpoint")
    expect((await reopened.eventHistory()).events.length).toBeLessThan(5)
    expect((await reopened.verifyState()).valid).toBe(true)
  } finally { await reopened.dispose?.() }
}, 30_000)

test("failed automatic checkpoint retains its suffix and retries after a committed edit", async () => {
  const durable = memoryStorage()
  let rejectWrites = false
  let refused = 0
  const storage = { ...durable, setItem: (key: string, value: string) => {
    if (rejectWrites) { refused++; throw new Error("disk unavailable") }
    durable.setItem(key, value)
  } }
  const store = await createAppStore({ kind: "localStorage", storage })
  try {
    for (let index = 0; index < 65; index++) {
      await store.dispatch({ type: "theme.changed", actor: "user", theme: index % 2 === 0 ? "dark" : "light" }).isPersisted.promise
    }
    const before = await store.eventHistory()
    const failures: number[] = []
    store.onMaintenanceFailure((_error, streak) => failures.push(streak))
    rejectWrites = true
    await until(async () => refused > 0)
    rejectWrites = false
    expect(failures).toEqual([1])
    const retained = await store.eventHistory()
    expect(retained.head).toEqual(before.head)
    expect(retained.events).toEqual(before.events)
    expect((await store.verifyState()).valid).toBe(true)
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "still editable" }).isPersisted.promise
    await until(async () => (await store.eventHistory()).events.length === 0)
    expect(store.session().draft).toBe("still editable")
    expect((await store.verifyState()).valid).toBe(true)
  } finally { rejectWrites = false; await store.dispose?.() }
}, 30_000)
