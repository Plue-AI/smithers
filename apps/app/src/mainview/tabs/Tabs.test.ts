import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { Card } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"

/*
 * The tabs collection's transitions (docs/LOCAL-APP.md "Cards"): main is
 * seeded and permanent, opened card tabs take the next place and become
 * active, closing the active tab falls back to the tab on its left, a card
 * tab's close keeps the card, and boot reconciliation drops the card tabs
 * whose card is gone. The terminal and harness tabs retired
 * (smithersai/smithers#2229): `tabs.migration.test.ts` covers a store that
 * still holds them.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const boot = (storage = memoryStorage()): Promise<AppStore> => createAppStore({ kind: "localStorage", storage })

const persisted = async (store: AppStore, transition: Parameters<AppStore["dispatch"]>[0]): Promise<void> => {
  await store.dispatch(transition).isPersisted.promise
}

const tabIds = (store: AppStore): Array<string> =>
  [...store.collections.tabs.values()].sort((left, right) => left.ordinal - right.ordinal).map((tab) => tab.id)

const card = (id: string, title: string): Card => ({
  id,
  kind: "agents",
  title,
  status: "active",
  createdAt: 1,
  ordinal: 0,
  payload: { native: false, agents: [] }
})
const themeCard = card("agents", "Agents")

const cardTab = (id: string, cardId: string, title = "Card") =>
  ({ type: "tab.opened", actor: "user", tab: { id, kind: "card", title, cardId } }) as const

describe("the tabs collection", () => {
  test("boots with the permanent main tab selected", async () => {
    const store = await boot()
    expect(tabIds(store)).toEqual(["main"])
    expect(store.collections.tabs.get("main")).toMatchObject({ kind: "main", title: "Smithers", ordinal: 0 })
    expect(store.session().activeTabId).toBe("main")
  })

  test("opening tabs appends them in creation order and activates the newest", async () => {
    const store = await boot()
    await persisted(store, cardTab("tab-a", "card-a"))
    await persisted(store, cardTab("tab-b", "card-b"))
    expect(tabIds(store)).toEqual(["main", "tab-a", "tab-b"])
    expect(store.session().activeTabId).toBe("tab-b")
    // A duplicate id is ignored; main is never re-inserted.
    await persisted(store, cardTab("tab-a", "card-a2"))
    expect(store.collections.tabs.get("tab-a")).toMatchObject({ cardId: "card-a" })
    await persisted(store, { type: "tab.opened", actor: "user", tab: { id: "main", kind: "main", title: "Smithers" } })
    expect(tabIds(store)).toEqual(["main", "tab-a", "tab-b"])
  })

  test("selecting names an existing tab; an unknown id changes nothing", async () => {
    const store = await boot()
    await persisted(store, cardTab("tab-a", "card-a"))
    await persisted(store, { type: "tab.selected", actor: "user", id: "main" })
    expect(store.session().activeTabId).toBe("main")
    await persisted(store, { type: "tab.selected", actor: "user", id: "tab-zzz" })
    expect(store.session().activeTabId).toBe("main")
    await persisted(store, { type: "tab.selected", actor: "user", id: "tab-a" })
    expect(store.session().activeTabId).toBe("tab-a")
  })

  test("closing the active tab selects the tab to its left; main never closes", async () => {
    const store = await boot()
    for (const id of ["a", "b", "c"]) await persisted(store, cardTab(`tab-${id}`, `card-${id}`))
    await persisted(store, { type: "tab.selected", actor: "user", id: "tab-b" })
    await persisted(store, { type: "tab.closed", actor: "user", id: "tab-b" })
    expect(tabIds(store)).toEqual(["main", "tab-a", "tab-c"])
    expect(store.session().activeTabId).toBe("tab-a")
    // Closing an inactive tab leaves the selection alone.
    await persisted(store, { type: "tab.closed", actor: "user", id: "tab-c" })
    expect(store.session().activeTabId).toBe("tab-a")
    await persisted(store, { type: "tab.closed", actor: "user", id: "tab-a" })
    expect(store.session().activeTabId).toBe("main")
    await persisted(store, { type: "tab.closed", actor: "user", id: "main" })
    expect(tabIds(store)).toEqual(["main"])
  })

  test("closing a card tab keeps the card in the transcript", async () => {
    const store = await boot()
    await persisted(store, { type: "card.upsert", actor: "user", card: themeCard })
    await persisted(store, cardTab("tab-card-agents", "agents", "Agents"))
    expect(store.session().activeTabId).toBe("tab-card-agents")
    await persisted(store, { type: "tab.closed", actor: "user", id: "tab-card-agents" })
    expect(tabIds(store)).toEqual(["main"])
    expect(store.collections.cards.get("agents")).toBeDefined()
  })

  test("a tab records the repository it was opened in, so the sidebar can nest it", async () => {
    const store = await boot()
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "t1", kind: "card", title: "Balance · smithers", cardId: "balance", repoKey: "local:/Users/will/smithers" }
    })
    await persisted(store, cardTab("t2", "runs"))
    expect(store.collections.tabs.get("t1")?.repoKey).toBe("local:/Users/will/smithers")
    expect(store.collections.tabs.get("t2")?.repoKey).toBeUndefined()
  })

  test("boot keeps card tabs whose card exists, drops orphaned card tabs, and reselects", async () => {
    const storage = memoryStorage()
    const first = await boot(storage)
    await persisted(first, { type: "card.upsert", actor: "user", card: themeCard })
    await persisted(first, cardTab("tab-card-agents", "agents", "Agents"))
    await persisted(first, cardTab("tab-card-gone", "no-such-card", "Gone"))
    expect(first.session().activeTabId).toBe("tab-card-gone")

    const second = await boot(storage)
    expect(tabIds(second)).toEqual(["main", "tab-card-agents"])
    // The dead active tab closed like any other: the tab to its left takes over.
    expect(second.session().activeTabId).toBe("tab-card-agents")
    // Every reconciliation is journaled with the system actor.
    const journal = [...second.collections.transitions.values()]
    expect(journal.filter((record) => record.type === "tab.closed" && record.actor === "system")).toHaveLength(1)
  })
})
