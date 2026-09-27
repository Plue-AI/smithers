import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { Card, WorkingCopy } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import { ENVELOPE_STORAGE_KEY, parseStorageEnvelope, STAGED_ENVELOPE_STORAGE_KEY } from "./TransactionalStorage"
import { addWorldNote } from "../state/TestFixtures"
import {
  APP_SCHEMA_VERSION,
  enforceSchemaVersion,
  PERSISTED_COLLECTION_IDS,
  PERSISTED_KEY_PREFIX,
  persistedStorageKeys,
  PERSISTENCE_BACKEND_STORAGE_KEY,
  readRecordedBackend,
  recordBackend,
  SCHEMA_QUARANTINE_PREFIX,
  SCHEMA_VERSION_STORAGE_KEY
} from "./SchemaVersion"

/** Each case gets its own storage so no case observes another case's writes. */
const memoryStorage = (): StorageApi & { readonly data: Map<string, string> } => {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

/** A storage that also enumerates, the way a real window.localStorage does. */
const enumerableStorage = (): StorageApi & { readonly data: Map<string, string> } => {
  const base = memoryStorage()
  // defineProperty, not Object.assign: assign would copy the getter's value
  // once and freeze length at 0.
  Object.defineProperty(base, "length", { get: () => base.data.size })
  Object.defineProperty(base, "key", {
    value: (index: number) => [...base.data.keys()][index] ?? null
  })
  return base
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

/*
 * The persisted envelope TanStack's localStorage collection writes:
 * {"<key>": {versionKey, data}}. Writing one by hand is how a store left by an
 * older build is reproduced without shipping an old build.
 */
const persistedRow = (key: string, row: Record<string, unknown>): string =>
  JSON.stringify({ [key]: { versionKey: "legacy", data: row } })

describe("the persisted collection inventory the gate clears", () => {
  /*
   * The gate clears a declared list, so a collection added to AppStore and not
   * declared here would keep its rows across a bump — exactly the silent
   * survival E14.2 exists to stop. Observe the actual storage reads: public
   * collections include derived views whose ids must never replace the
   * durable collections they project.
   */
  test("covers every durable collection a real store reads, excluding derived views", async () => {
    const storage = memoryStorage()
    const reads = new Set<string>()
    const store = await createAppStore({
      kind: "localStorage",
      storage: {
        ...storage,
        getItem: (key) => { reads.add(key); return storage.getItem(key) }
      }
    })
    const bookkeeping = new Set([
      ENVELOPE_STORAGE_KEY, STAGED_ENVELOPE_STORAGE_KEY,
      SCHEMA_VERSION_STORAGE_KEY, PERSISTENCE_BACKEND_STORAGE_KEY
    ])
    const durableIds = [...reads]
      .filter((key) => key.startsWith(PERSISTED_KEY_PREFIX) && !bookkeeping.has(key))
      .map((key) => key.slice(PERSISTED_KEY_PREFIX.length))
    // Removed collections retain historical cleanup keys.
    expect(durableIds).not.toContain(store.collections.repoTree.id)
    expect([...PERSISTED_COLLECTION_IDS].sort()).toEqual([...durableIds, store.collections.repoTree.id, "app-linear-integrations", "app-chain-events", "app-retired-chain-lineages", "app-harnesses"].sort())
    expect(durableIds).not.toContain(store.collections.cards.id)
    expect(durableIds).not.toContain(store.collections.workingCopies.id)
    await store.dispose?.()
  })

  /*
   * Everything a real boot writes is either a declared collection key or one
   * of the two bookkeeping stamps. A key that is neither would be data the
   * gate cannot reach, which is what leaves an old shape behind after a bump.
   */
  test("uses the storage key template a real store writes under", async () => {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "probe" })
      .isPersisted.promise
    const written = [...storage.data.keys()]
    expect(written.length).toBeGreaterThan(0)
    const declared = new Set([
      ...persistedStorageKeys(),
      SCHEMA_VERSION_STORAGE_KEY,
      PERSISTENCE_BACKEND_STORAGE_KEY
    ])
    for (const key of written) {
      expect(key.startsWith(PERSISTED_KEY_PREFIX)).toBe(true)
      expect(declared.has(key)).toBe(true)
    }
    // The gate ran on the path the app actually takes, rather than beside it.
    expect(storage.getItem(SCHEMA_VERSION_STORAGE_KEY)).toBe(String(APP_SCHEMA_VERSION))
  })
})

describe("enforceSchemaVersion", () => {
  test("default behavior preserves older state and waits for a validated commit", () => {
    const storage = memoryStorage()
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION - 1))
    storage.setItem("smithers-mvp.app-messages", "original conversation")
    const before = [...storage.data]
    expect(enforceSchemaVersion(storage).action).toBe("validate")
    expect([...storage.data]).toEqual(before)
  })

  test("default behavior refuses a newer store without resetting or quarantining it", () => {
    const storage = memoryStorage()
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION + 1))
    storage.setItem("smithers-mvp.app-messages", "future conversation")
    const before = [...storage.data]
    expect(() => enforceSchemaVersion(storage)).toThrow("cannot be opened")
    expect([...storage.data]).toEqual(before)
  })

  test("validated upgrades preserve bytes and the old stamp until the storage opener commits", () => {
    const storage = memoryStorage()
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION - 1))
    storage.setItem(`${PERSISTED_KEY_PREFIX}app-sessions`, "legacy bytes")
    const before = [...storage.data]
    expect(enforceSchemaVersion(storage, { onMismatch: "validate" }).action).toBe("validate")
    expect([...storage.data]).toEqual(before)
  })

  test("validated upgrades refuse future or invalid app versions without touching storage", () => {
    for (const stamp of [String(APP_SCHEMA_VERSION + 1), "invalid"]) {
      const storage = memoryStorage()
      storage.setItem(SCHEMA_VERSION_STORAGE_KEY, stamp)
      storage.setItem(`${PERSISTED_KEY_PREFIX}app-sessions`, "future bytes")
      const before = [...storage.data]
      expect(() => enforceSchemaVersion(storage, { onMismatch: "validate" })).toThrow("cannot be opened")
      expect([...storage.data]).toEqual(before)
    }
  })
  test("a fresh store waits for validation; a committed stamp then matches", () => {
    const storage = memoryStorage()
    const first = enforceSchemaVersion(storage)
    expect(first.action).toBe("validate")
    expect(first.from).toBe(null)
    expect(storage.getItem(SCHEMA_VERSION_STORAGE_KEY)).toBe(null)
    // The validated storage opener, not this read-only gate, commits the stamp.
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION))
    const second = enforceSchemaVersion(storage)
    expect(second.action).toBe("match")
    expect(second.clearedKeys).toEqual([])
  })

  test("clears every declared collection key on a bump", () => {
    const storage = memoryStorage()
    for (const key of persistedStorageKeys()) storage.setItem(key, "{}")
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION))
    const outcome = enforceSchemaVersion(storage, { version: APP_SCHEMA_VERSION + 1, onMismatch: "reset" })
    expect(outcome.action).toBe("reset")
    expect(outcome.from).toBe(String(APP_SCHEMA_VERSION))
    expect([...outcome.clearedKeys]).toEqual([...persistedStorageKeys()].sort())
    for (const key of persistedStorageKeys()) expect(storage.getItem(key)).toBe(null)
    expect(outcome.quarantinedKeys).toHaveLength(persistedStorageKeys().length)
    for (const key of outcome.quarantinedKeys) {
      expect(key.startsWith(SCHEMA_QUARANTINE_PREFIX)).toBe(true)
      expect(storage.getItem(key)).toBe("{}")
    }
    expect(storage.getItem(SCHEMA_VERSION_STORAGE_KEY)).toBe(String(APP_SCHEMA_VERSION + 1))
  })

  test("leaves a matching store untouched", () => {
    const storage = memoryStorage()
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION))
    storage.setItem(`${PERSISTED_KEY_PREFIX}app-sessions`, "{}")
    const outcome = enforceSchemaVersion(storage)
    expect(outcome.action).toBe("match")
    expect(storage.getItem(`${PERSISTED_KEY_PREFIX}app-sessions`)).toBe("{}")
  })

  test("does not touch keys outside the store's namespace", () => {
    const storage = enumerableStorage()
    storage.setItem("unrelated-app.state", "keep me")
    enforceSchemaVersion(storage, { version: APP_SCHEMA_VERSION + 1, onMismatch: "reset" })
    expect(storage.getItem("unrelated-app.state")).toBe("keep me")
  })

  /*
   * An enumerating storage reaches keys the declared list has forgotten: a
   * collection removed in an earlier release still has rows in an alpha
   * user's browser, and leaving them there leaks the old shape forward.
   */
  test("an enumerating storage also clears a retired collection's key", () => {
    const storage = enumerableStorage()
    storage.setItem(`${PERSISTED_KEY_PREFIX}app-retired-collection`, "{}")
    // A genuine bump, so the stamp must be present.
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION))
    const outcome = enforceSchemaVersion(storage, { version: APP_SCHEMA_VERSION + 1, onMismatch: "reset" })
    expect(outcome.clearedKeys).toContain(`${PERSISTED_KEY_PREFIX}app-retired-collection`)
    expect(storage.getItem(`${PERSISTED_KEY_PREFIX}app-retired-collection`)).toBe(null)
  })
})

describe("a real store across a schema version bump", () => {
  test("legacy cards and copies keep durable authority across migration, live projection, reopen and reset", async () => {
    const storage = memoryStorage()
    const card: Card = {
      id: "legacy-card", kind: "status", title: "Before", status: "active",
      createdAt: 1, ordinal: 1, payload: { note: "kept from the old store" }
    }
    const copy: WorkingCopy = {
      id: "workspace:legacy", workspaceId: "legacy", repoId: "org/repo",
      kind: "workspace", label: "Before", updatedAt: 1, revision: 0
    }
    const cardKey = `${PERSISTED_KEY_PREFIX}app-cards`
    const copyKey = `${PERSISTED_KEY_PREFIX}app-working-copies`
    const legacyCard = persistedRow(card.id, card)
    const legacyCopy = persistedRow(copy.id, copy)
    storage.setItem(cardKey, legacyCard)
    storage.setItem(copyKey, legacyCopy)
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION - 1))

    const store = await createAppStore({ kind: "localStorage", storage })
    expect(store.collections.cards.get(card.id)).toMatchObject(card)
    expect(store.collections.workingCopies.get(copy.id)).toMatchObject(copy)
    await store.dispatch({ type: "card.updated", actor: "system", id: card.id, patch: { title: "After" } })
      .isPersisted.promise
    await store.dispatch({
      type: "workingcopies.workspaces.loaded", actor: "system", copies: [{ ...copy, label: "After" }]
    }).isPersisted.promise

    const committed = storage.getItem(ENVELOPE_STORAGE_KEY)!
    const entries = parseStorageEnvelope(committed)!.entries
    expect(JSON.parse(entries[cardKey]!)[`s:${card.id}`].data.title).toBe("After")
    expect(JSON.parse(entries[copyKey]!)[`s:${copy.id}`].data.label).toBe("After")
    for (const view of [store.collections.cards, store.collections.workingCopies]) {
      const key = `${PERSISTED_KEY_PREFIX}${view.id}`
      expect(entries[key]).toBeUndefined()
      expect(storage.getItem(key)).toBeNull()
    }
    // Legacy bytes are recovery copies; the committed envelope now owns data.
    expect(storage.getItem(cardKey)).toBe(legacyCard)
    expect(storage.getItem(copyKey)).toBe(legacyCopy)
    expect(storage.getItem(SCHEMA_VERSION_STORAGE_KEY)).toBe(String(APP_SCHEMA_VERSION))
    await store.dispose?.()
    const reopened = await createAppStore({ kind: "localStorage", storage })
    expect(reopened.collections.cards.get(card.id)?.title).toBe("After")
    expect(reopened.collections.workingCopies.get(copy.id)?.label).toBe("After")
    await reopened.dispose?.()

    // Reopen may commit boot migrations (including tutorial presentation).
    // Reset must quarantine the latest durable bytes, not the earlier snapshot.
    const beforeReset = storage.getItem(ENVELOPE_STORAGE_KEY)!
    const outcome = enforceSchemaVersion(storage, { version: APP_SCHEMA_VERSION + 1, onMismatch: "reset" })
    for (const key of [cardKey, copyKey, ENVELOPE_STORAGE_KEY]) expect(storage.getItem(key)).toBeNull()
    const recovery = outcome.quarantinedKeys.map((key) => storage.getItem(key))
    expect(recovery).toContain(beforeReset)
    expect(recovery).toContain(legacyCard)
    expect(recovery).toContain(legacyCopy)
  })

  test("future state refuses app open without changing the durable store", async () => {
    const storage = memoryStorage()
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION + 1))
    storage.setItem(ENVELOPE_STORAGE_KEY, "future opaque bytes")
    const before = [...storage.data]
    await expect(createAppStore({ kind: "localStorage", storage })).rejects.toThrow("cannot be opened")
    expect([...storage.data]).toEqual(before)
  })

  test("a failed validated commit leaves the older schema stamp and legacy bytes untouched", async () => {
    const storage = memoryStorage()
    const stamp = String(APP_SCHEMA_VERSION - 1)
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, stamp)
    const legacyKey = `${PERSISTED_KEY_PREFIX}app-cards`
    storage.setItem(legacyKey, "{}")
    const host: StorageApi = {
      ...storage,
      setItem: (key, value) => {
        if (key === ENVELOPE_STORAGE_KEY) throw new Error("quota refused")
        storage.setItem(key, value)
      }
    }
    await expect(createAppStore({ kind: "localStorage", storage: host })).rejects.toThrow("quota refused")
    expect(storage.getItem(SCHEMA_VERSION_STORAGE_KEY)).toBe(stamp)
    expect(storage.getItem(legacyKey)).toBe("{}")
  })
  /*
   * The defect E14.2 names. TanStack's localStorage loader parses the
   * {versionKey, data} envelope and never runs the collection schema, so a row
   * whose shape no longer exists enters the live collection. Every case here
   * goes through `createAppStore`, because the gate is only real if it runs on
   * the path the app actually takes: an older build's store is reproduced by
   * writing its bytes and its stamp, never by calling the gate by hand.
   */
  test("a boot over an older stamp keeps invalid rows out and preserves compatible state", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    await addWorldNote(first)
    await first.dispatch({ type: "composer.changed", actor: "user", draft: "written before the bump" })
      .isPersisted.promise
    storage.setItem(
      `${PERSISTED_KEY_PREFIX}app-cards`,
      persistedRow("invalid-card", { id: "invalid-card", kind: "kind-that-no-longer-exists" })
    )
    // The store as an older build left it: its rows, under its version.
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION - 1))

    const second = await createAppStore({ kind: "localStorage", storage })
    expect(second.collections.cards.get("invalid-card")).toBeUndefined()
    expect(second.collections.cards.size).toBe(0)
    expect(second.session().draft).toBe("written before the bump")
    expect(second.session().id).toBe("main")
    expect(second.collections.worldDocuments.size).toBeGreaterThan(0)
    expect(storage.getItem(SCHEMA_VERSION_STORAGE_KEY)).toBe(String(APP_SCHEMA_VERSION))
  })

  test("the validated store still dispatches and persists", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    await first.dispatch({ type: "composer.changed", actor: "user", draft: "before" })
      .isPersisted.promise
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION - 1))

    const second = await createAppStore({ kind: "localStorage", storage })
    expect(second.session().draft).toBe("before")
    await second.dispatch({ type: "composer.changed", actor: "user", draft: "after" })
      .isPersisted.promise
    await settled()

    const third = await createAppStore({ kind: "localStorage", storage })
    expect(third.session().draft).toBe("after")
  })

  /*
   * The other half of the contract, and the one a too-eager gate breaks: an
   * ordinary reopen resets nothing. Without this, "clear on every boot" would
   * pass every case above and lose every conversation.
   */
  test("an ordinary reopen preserves what a real store persisted", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    await first.dispatch({ type: "composer.changed", actor: "user", draft: "durable draft" })
      .isPersisted.promise

    const second = await createAppStore({ kind: "localStorage", storage })
    expect(second.session().draft).toBe("durable draft")
  })

  /*
   * The reset clears the data and keeps the stamps. Clearing the backend stamp
   * would send the next launch to whichever store it opened first, which is
   * the E3.6 loss: the app reads an empty database while the conversation sits
   * in the other one.
   */
  test("a reset keeps the stamp that says which backend holds the store", async () => {
    const storage = memoryStorage()
    recordBackend(storage, "localStorage")
    storage.setItem(
      `${PERSISTED_KEY_PREFIX}app-cards`,
      persistedRow("invalid-card", { id: "invalid-card", kind: "kind-that-no-longer-exists" })
    )
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION - 1))

    const store = await createAppStore({ kind: "localStorage", storage })
    expect(store.collections.cards.get("invalid-card")).toBeUndefined()
    expect(readRecordedBackend(storage)).toBe("localStorage")
  })
})

describe("the recorded backend", () => {
  test("round-trips, and reads null when no launch has stamped one", () => {
    const storage = memoryStorage()
    expect(readRecordedBackend(storage)).toBe(null)
    recordBackend(storage, "opfs")
    expect(readRecordedBackend(storage)).toBe("opfs")
    recordBackend(storage, "localStorage")
    expect(readRecordedBackend(storage)).toBe("localStorage")
  })

  test("refuses an unknown backend without changing its stamp", () => {
    const storage = memoryStorage()
    storage.setItem(PERSISTENCE_BACKEND_STORAGE_KEY, "indexeddb")
    expect(() => readRecordedBackend(storage)).toThrow("backend")
    expect(storage.getItem(PERSISTENCE_BACKEND_STORAGE_KEY)).toBe("indexeddb")
  })
})
