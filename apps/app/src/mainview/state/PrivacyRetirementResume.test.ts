import { afterEach, describe, expect, test } from "bun:test"
import { PRIVACY_RETIREMENT_KEY, readPrivacyRetirement, type PrivacyStorage } from "../chain/PrivacyRetirement"
import { PERSISTENCE_BACKEND_STORAGE_KEY } from "../chain/SchemaVersion"
import { createAppStore, resolvePersistence, type AppStore, type BrowserPersistenceHost } from "./AppStore"

/*
 * The defect this pins: a sign-out on a localStorage-backed browser that still
 * holds an OPFS file it cannot open left the privacy marker `pending`. Every
 * boot resumed the cleanup, failed to open that same inactive file, and threw
 * "Local privacy cleanup is incomplete. Reload to retry", so reloading could
 * never work. The inactive file holds no live data, so boot now removes it
 * whole when it cannot be opened, and fails only when that removal fails too.
 */

const secret = "PRIVATE-RESUME-BYTES"
const stores: AppStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await Promise.resolve(store.dispose?.()).catch(() => {})
})

const memory = (): PrivacyStorage => {
  const bytes = new Map<string, string>()
  const storage: PrivacyStorage = {
    get length() { return bytes.size },
    key: index => [...bytes.keys()][index] ?? null,
    getItem: key => bytes.get(key) ?? null,
    setItem: (key, value) => { bytes.set(key, value) },
    removeItem: key => { bytes.delete(key) }
  }
  storage.setItem(PERSISTENCE_BACKEND_STORAGE_KEY, "localStorage")
  return storage
}

/** A browser whose inactive OPFS file exists and never opens. */
const brokenInactiveDatabase = (storage: PrivacyStorage, removal: "works" | "fails" | "absent") => {
  let exists = true
  const removed: string[] = []
  const host: BrowserPersistenceHost = {
    bootRecord: () => storage,
    openDatabase: async () => { throw new Error("OPFS did not open within 4000ms") },
    databaseExists: async () => exists,
    ...(removal === "absent" ? {} : {
      removeDatabase: async () => {
        removed.push("smithers-mvp.sqlite")
        if (removal === "fails") throw new DOMException("held", "NoModificationAllowedError")
        exists = false
      }
    })
  }
  return { host, removed, exists: () => exists }
}

const boot = async (host: BrowserPersistenceHost): Promise<AppStore> => {
  const store = await createAppStore(await resolvePersistence(host))
  stores.push(store)
  return store
}

/** Sign out while the inactive file cannot be erased: the marker stays pending. */
const strandPendingMarker = async (storage: PrivacyStorage): Promise<void> => {
  const { host } = brokenInactiveDatabase(storage, "absent")
  const store = await boot(host)
  await store.dispatch({ type: "message.submitted", actor: "user", turnId: "private", text: secret }).isPersisted.promise
  await expect(store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise).rejects.toThrow()
  expect(readPrivacyRetirement(storage)?.phase).toBe("pending")
  await Promise.resolve(store.dispose?.()).catch(() => {})
  stores.splice(stores.indexOf(store), 1)
}

describe("a stuck pending privacy marker", () => {
  test("boot resumes it by removing the unopenable inactive database, then every reload stays healthy", async () => {
    const storage = memory()
    await strandPendingMarker(storage)
    const browser = brokenInactiveDatabase(storage, "works")
    const resumed = await boot(browser.host)
    expect(browser.removed).toEqual(["smithers-mvp.sqlite"])
    expect(browser.exists()).toBe(false)
    expect(readPrivacyRetirement(storage)?.phase).toBe("complete")
    expect((await resumed.verifyState()).valid).toBe(true)
    expect(JSON.stringify(Object.fromEntries(Array.from({ length: storage.length }, (_, index) => {
      const key = storage.key(index)!
      return [key, storage.getItem(key)]
    })))).not.toContain(secret)
    await Promise.resolve(resumed.dispose?.())
    stores.splice(stores.indexOf(resumed), 1)
    await boot(browser.host)
  })

  test("a removal that fails too surfaces the typed storage variant, and a later healthy boot still recovers", async () => {
    const storage = memory()
    await strandPendingMarker(storage)
    const failing = brokenInactiveDatabase(storage, "fails")
    const refusal = await boot(failing.host).then(() => undefined, (error: unknown) => error)
    expect(refusal).toMatchObject({ _tag: "PrivacyStorageUnavailable" })
    expect(readPrivacyRetirement(storage)?.phase).toBe("pending")
    await boot(brokenInactiveDatabase(storage, "works").host)
    expect(readPrivacyRetirement(storage)?.phase).toBe("complete")
  })

  test("an unreadable marker fails with its own variant instead of a generic cleanup error", async () => {
    const storage = memory()
    storage.setItem(PRIVACY_RETIREMENT_KEY, "{not json")
    const refusal = await resolvePersistence(brokenInactiveDatabase(storage, "works").host).then(() => undefined, (error: unknown) => error)
    expect(refusal).toMatchObject({ _tag: "PrivacyMarkerUnreadable" })
  })
})
