import { describe, expect, test } from "bun:test"
import { captureBrowserStorageRecovery, createRecoveryDownload, recoveryStorage } from "./BrowserStorageRecovery"
import { PRIVACY_RETIREMENT_EVENT, PRIVACY_RETIREMENT_KEY } from "../chain/PrivacyRetirement"

const memory = (entries: ReadonlyArray<readonly [string, string]>) => {
  const bytes = new Map(entries)
  return {
    bytes,
    get length() {
      return bytes.size
    },
    key: (index: number) => [...bytes.keys()][index] ?? null,
    getItem: (key: string) => bytes.get(key) ?? null
  }
}

describe("a browser recovery artifact identifies its separate sources", () => {
  test("a required cross-backend privacy barrier refuses before reading SQLite when browser storage is absent", async () => {
    let reads = 0
    await expect(captureBrowserStorageRecovery({
      session: "unopened",
      localStorage: undefined,
      sqlite: async () => { reads++; return [] },
      requirePrivacyBarrier: true
    })).rejects.toThrow("The local recovery snapshot could not be read completely. No partial download was produced and saved data was not reset.")
    expect(reads).toBe(0)
  })
  test("retains ambiguous persisted histories and a memory session separately without interpreting any stamp", async () => {
    const localStorage = memory([["smithers-mvp.persistenceBackend", "unknown"], [
      "smithers-mvp.old",
      "older private original"
    ]])
    const transient = memory([["smithers-mvp.store", "temporary session"]])
    const sqlite = [{
      name: "raw",
      sql: null,
      columns: ["value"],
      rows: [[{ type: "text" as const, value: "newer private original" }]]
    }]
    const snapshot = await captureBrowserStorageRecovery({
      session: "memory",
      localStorage,
      sqlite: async () => sqlite,
      memory: transient
    })
    expect(snapshot.session).toBe("memory")
    expect(snapshot.unavailable).toEqual([])
    expect(snapshot.localStorage).toContainEqual({ key: "smithers-mvp.old", value: "older private original" })
    expect(snapshot.sqlite).toEqual(sqlite)
    expect(snapshot.memory).toEqual([{ key: "smithers-mvp.store", value: "temporary session" }])
    expect([...localStorage.bytes]).toEqual([["smithers-mvp.persistenceBackend", "unknown"], [
      "smithers-mvp.old",
      "older private original"
    ]])
  })

  test("unavailable APIs are explicit, not confused with an absent database", async () => {
    const unavailable = await captureBrowserStorageRecovery({
      session: "unopened",
      localStorage: undefined,
      sqlite: undefined
    })
    expect(unavailable.unavailable).toEqual(["localStorage", "sqlite"])
    expect(unavailable.sqlite).toBeUndefined()
    const absent = await captureBrowserStorageRecovery({
      session: "localStorage",
      localStorage: memory([]),
      sqlite: async () => undefined
    })
    expect(absent.unavailable).toEqual([])
    expect(absent.localStorage).toEqual([])
    expect(absent.sqlite).toBeUndefined()
  })

  test("a local edit during the SQLite read refuses a mixed capture", async () => {
    const localStorage = memory([["smithers-mvp.store", "before"]])
    await expect(captureBrowserStorageRecovery({
      session: "unopened",
      localStorage,
      sqlite: async () => {
        localStorage.bytes.set("smithers-mvp.store", "after")
        return []
      }
    })).rejects.toThrow("changed")
    expect(localStorage.getItem("smithers-mvp.store")).toBe("after")
  })

  test("unreadable SQLite refuses the artifact rather than silently exporting only localStorage", async () => {
    await expect(captureBrowserStorageRecovery({
      session: "unopened",
      localStorage: memory([]),
      sqlite: async () => {
        throw new Error("fixture unavailable")
      }
    })).rejects.toThrow("fixture unavailable")
  })

  test("a non-enumerable injected storage is refused instead of dropping historical keys", () => {
    expect(recoveryStorage(undefined)).toBeUndefined()
    expect(() => recoveryStorage({ getItem: () => "private" })).toThrow("could not be read completely")
  })
})

describe("the private local Blob handoff", () => {
  test("only retirement storage events invalidate downloads, and disposal releases listeners and all remaining URLs", () => {
    const page = new EventTarget()
    const listeners: string[] = []
    const removedListeners: string[] = []
    const addedCallbacks: EventListener[] = []
    const removedCallbacks: EventListener[] = []
    const ownedListeners = new Map<string, Set<EventListener>>()
    const revoked: string[] = []
    let created = 0
    const host = {
      defaultView: {
        addEventListener: (name: string, callback: EventListener) => {
          listeners.push(name)
          addedCallbacks.push(callback)
          const owned = ownedListeners.get(name) ?? new Set<EventListener>()
          owned.add(callback)
          ownedListeners.set(name, owned)
          page.addEventListener(name, callback)
        },
        removeEventListener: (name: string, callback: EventListener) => {
          removedListeners.push(name)
          removedCallbacks.push(callback)
          ownedListeners.get(name)?.delete(callback)
          page.removeEventListener(name, callback)
        }
      },
      createElement: () => ({ click() {}, remove() {} }),
      body: { append() {} }
    } as unknown as Document
    const urls = {
      createObjectURL: () => `blob:owned-${++created}`,
      revokeObjectURL: (url: string) => { revoked.push(url) }
    } as unknown as typeof URL
    const handoff = createRecoveryDownload(host, urls)
    const storageEvent = (key: string | null) => {
      const event = new Event("storage")
      Object.defineProperty(event, "key", { value: key })
      page.dispatchEvent(event)
    }
    try {
      expect(listeners).toEqual(["smithers-privacy-retirement", "storage"])
      handoff.download("first private file")
      storageEvent("another-app.setting")
      expect(revoked).toEqual([])
      storageEvent(PRIVACY_RETIREMENT_KEY)
      expect(revoked).toEqual(["blob:owned-1"])
      handoff.download("second private file")
      storageEvent(null)
      expect(revoked).toEqual(["blob:owned-1", "blob:owned-2"])
      handoff.download("third private file")
    } finally { handoff.dispose() }
    expect(revoked).toEqual(["blob:owned-1", "blob:owned-2", "blob:owned-3"])
    expect(removedListeners).toEqual(["smithers-privacy-retirement", "storage"])
    expect(removedCallbacks[0]).toBe(addedCallbacks[0])
    expect(removedCallbacks[1]).toBe(addedCallbacks[1])
    expect([...ownedListeners.values()].map(owned => owned.size)).toEqual([0, 0])
    storageEvent(null)
    page.dispatchEvent(new Event(PRIVACY_RETIREMENT_EVENT))
    expect(revoked).toEqual(["blob:owned-1", "blob:owned-2", "blob:owned-3"])
  })

  for (const failure of ["url", "append"] as const) {
    test(`${failure} refusal never clicks or retains an object URL, and append refusal removes its anchor`, () => {
      const revoked: string[] = []
      let created = 0
      let removed = 0
      let clicks = 0
      const host = {
        createElement: () => ({ click: () => { clicks++ }, remove: () => { removed++ } }),
        body: { append: () => { if (failure === "append") throw new Error("fixture append refused") } }
      } as unknown as Document
      const urls = {
        createObjectURL: () => {
          if (failure === "url") throw new Error("fixture url refused")
          created++
          return "blob:refused"
        },
        revokeObjectURL: (url: string) => { revoked.push(url) }
      } as unknown as typeof URL
      const handoff = createRecoveryDownload(host, urls)
      try {
        expect(() => handoff.download("private file")).toThrow(`fixture ${failure} refused`)
        expect(clicks).toBe(0)
        expect(created).toBe(failure === "url" ? 0 : 1)
        expect(revoked).toEqual(failure === "url" ? [] : ["blob:refused"])
        if (failure === "append") expect(removed).toBe(1)
      } finally { handoff.dispose() }
      expect(revoked).toEqual(failure === "url" ? [] : ["blob:refused"])
    })
  }

  for (const failure of [undefined, "element", "click"] as const) {
    test(`owns every object URL and anchor (failure: ${failure ?? "none"})`, async () => {
      const revoked: string[] = []
      const blobs: Blob[] = []
      let removed = 0
      let clicks = 0
      const anchor = {
        href: "",
        download: "",
        hidden: false,
        click: () => {
          clicks++
          if (failure === "click") throw new Error("fixture click refused")
        },
        remove: () => {
          removed++
        }
      }
      const host = {
        createElement: () => {
          if (failure === "element") throw new Error("fixture element refused")
          return anchor
        },
        body: { append: () => {} }
      } as unknown as Document
      const urls = {
        createObjectURL: (blob: Blob) => {
          blobs.push(blob)
          return "blob:fixture"
        },
        revokeObjectURL: (url: string) => {
          revoked.push(url)
        }
      } as unknown as typeof URL
      const handoff = createRecoveryDownload(host, urls)
      try {
        if (failure === undefined) {
          handoff.download("private file")
          expect(await blobs[0]?.text()).toBe("private file")
          expect(anchor.download).toBe("smithers-local-recovery.json")
          expect(anchor.href).toBe("blob:fixture")
          expect(clicks).toBe(1)
          expect(removed).toBe(1)
          expect(revoked).toEqual([])
        } else {
          expect(() => handoff.download("private file")).toThrow("fixture")
          expect(revoked.length).toBe(blobs.length)
        }
      } finally {
        handoff.dispose()
      }
      expect(revoked.length).toBe(blobs.length)
      handoff.dispose()
      expect(revoked.length).toBe(blobs.length)
      expect(() => handoff.download("later")).toThrow("could not be read completely")
    })
  }
})
