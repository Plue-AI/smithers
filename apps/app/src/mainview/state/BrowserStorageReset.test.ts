import { beginPrivacyRetirement, completePrivacyRetirement, PRIVACY_RETIREMENT_KEY, RESET_ERASURE_OUTBOX_KEY, readResetErasures } from "../chain/PrivacyRetirement"
import { createTurnEraser } from "../runtime/TurnErasure"
import { TURN_ERASE_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"

GlobalRegistrator.register()
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { createAppStore, resetLocalBrowserStorage } = await import("./AppStore")

const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks")
let occupied = false
let acquisitions = 0
beforeEach(() => {
  occupied = false
  acquisitions = 0
  Object.defineProperty(navigator, "locks", { configurable: true, value: {
    request: async (_name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
      if (occupied) return callback(null)
      occupied = true
      acquisitions += 1
      try { await callback({}) } finally { occupied = false }
    }
  } })
})
afterEach(() => {
  if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks)
  else Reflect.deleteProperty(navigator, "locks")
})

/*
 * The reset offered on the startup failure panel. The profile that could not
 * boot — "prepare runtime and persisted state: Invalid string length" against
 * 890415370 bytes of OPFS fileSystem usage, smithers.sh build 8e55636b — shares
 * its origin with the marketing site, so the erase has to be prefix-scoped.
 */
describe("resetLocalBrowserStorage", () => {
  test("a different origin writer refuses reset before deleting any bytes", async () => {
    window.localStorage.clear()
    window.localStorage.setItem("smithers-mvp.store", "private evidence")
    occupied = true
    let reloads = 0
    await expect(resetLocalBrowserStorage(() => { reloads += 1 })).rejects.toThrow("another Smithers tab")
    expect(window.localStorage.getItem("smithers-mvp.store")).toBe("private evidence")
    expect(reloads).toBe(0)
  })

  test("a stolen lease rejects pending drafts and all subsequent writes", async () => {
    window.localStorage.clear()
    window.localStorage.setItem("smithers-mvp.persistenceBackend", "localStorage")
    const stolen = Promise.withResolvers<void>()
    Object.defineProperty(navigator, "locks", { configurable: true, value: {
      request: (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) =>
        Promise.race([callback({}), stolen.promise])
    } })
    const store = await createAppStore()
    const committed = window.localStorage.getItem("smithers-mvp.store")
    const draft = store.dispatch({ type: "composer.changed", actor: "user", draft: "pending before takeover" })
    const rejected = draft.isPersisted.promise.then(() => undefined, error => error)
    stolen.reject(new DOMException("Stolen", "AbortError"))
    expect(await rejected).toBeInstanceOf(Error)
    await store.dispose?.()
    expect(window.localStorage.getItem("smithers-mvp.store")).toBe(committed)
    expect(() => store.dispatch({ type: "composer.changed", actor: "user", draft: "stale" })).toThrow("closed")
  })

  test("reset disposes the live dispatcher and reacquires its lease before erasing", async () => {
    window.localStorage.clear()
    window.localStorage.setItem("smithers-mvp.persistenceBackend", "localStorage")
    const store = await createAppStore()
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "private draft" }).isPersisted.promise
    expect(acquisitions).toBe(1)
    let reloads = 0
    await resetLocalBrowserStorage(() => { expect(occupied).toBe(true); reloads += 1 })
    expect(acquisitions).toBe(2)
    expect(reloads).toBe(1)
    expect(occupied).toBe(false)
    expect(window.localStorage.getItem("smithers-mvp.store")).toBeNull()
    expect(() => store.dispatch({ type: "composer.changed", actor: "user", draft: "late write" })).toThrow("closed")
    expect(window.localStorage.getItem("smithers-mvp.store")).toBeNull()
  })

  test("a reset whose durable proof staging fails erases neither the original state nor its privacy marker", async () => {
    window.localStorage.clear()
    const intent = beginPrivacyRetirement(window.localStorage, { id: "pending-reset", targetStreamId: "old-stream", mode: "account", backend: "localStorage" }, [
      { runId: "old-run", legId: "old-leg", retirementProof: "c".repeat(64) }
    ])
    completePrivacyRetirement(window.localStorage, intent)
    window.localStorage.setItem("smithers-mvp.store", "original private state")
    const marker = window.localStorage.getItem(PRIVACY_RETIREMENT_KEY)
    const original = window.localStorage
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage")
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      get length() { return original.length }, key: (index: number) => original.key(index),
      getItem: (key: string) => original.getItem(key), removeItem: (key: string) => original.removeItem(key),
      setItem: (key: string, value: string) => { if (key !== RESET_ERASURE_OUTBOX_KEY) original.setItem(key, value) }
    } })
    let reloaded = false
    try {
      await expect(resetLocalBrowserStorage(() => { reloaded = true })).rejects.toThrow("cleanup")
      expect(window.localStorage.getItem("smithers-mvp.store")).toBe("original private state")
      expect(window.localStorage.getItem(PRIVACY_RETIREMENT_KEY)).toBe(marker)
      expect(reloaded).toBe(false)
      expect(occupied).toBe(false)
    } finally {
      if (descriptor) Object.defineProperty(window, "localStorage", descriptor)
      else Reflect.deleteProperty(window, "localStorage")
    }
  })

  test("raw reset preserves validated delete proofs and a fresh app drains only typed retirement receipts", async () => {
    window.localStorage.clear()
    const proof = { runId: "old-run", legId: "old-leg", retirementProof: "b".repeat(64) }
    const intent = beginPrivacyRetirement(window.localStorage, { id: "old-generation", targetStreamId: "old-stream", mode: "account", backend: "localStorage" }, [proof])
    completePrivacyRetirement(window.localStorage, intent)
    window.localStorage.setItem("smithers-mvp.store", "unreadable private original")
    await resetLocalBrowserStorage(() => {})
    expect(window.localStorage.getItem("smithers-mvp.store")).toBeNull()
    expect(window.localStorage.getItem(PRIVACY_RETIREMENT_KEY)).toBeNull()
    expect(readResetErasures(window.localStorage)).toEqual([proof])
    window.localStorage.setItem("smithers-mvp.persistenceBackend", "localStorage")
    const received = Promise.withResolvers<void>(), reply = Promise.withResolvers<Response>()
    const calls: Array<{ path: string; body: unknown }> = []
    const erase = createTurnEraser(async (path, init) => {
      calls.push({ path: String(path), body: JSON.parse(String(init?.body)) })
      received.resolve()
      return reply.promise
    })
    const store = await createAppStore(undefined, { eraseTurn: erase })
    try {
      await received.promise
      expect(store.privacyRetirementStatus()).toEqual({ phase: "remote-pending", remotePending: 1 })
      expect(JSON.stringify(await store.readRecovery())).not.toContain(proof.retirementProof)
      expect(JSON.stringify(store.agentContextSnapshot())).not.toContain(proof.retirementProof)
      expect(JSON.stringify(await store.eventHistory())).not.toContain(proof.retirementProof)
      // A later account scrub cannot erase the independent, validated queue.
      await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
      expect(readResetErasures(window.localStorage)).toEqual([proof])
      reply.resolve(Response.json({ status: "retired" }))
      for (let index = 0; index < 30 && readResetErasures(window.localStorage).length > 0; index++) await Promise.resolve()
      expect(window.localStorage.getItem(RESET_ERASURE_OUTBOX_KEY)).toBeNull()
      expect(calls).toEqual([{ path: TURN_ERASE_PATH, body: proof }])
      expect((await store.verifyState()).valid).toBe(true)
    } finally { reply.resolve(Response.json({ status: "retired" })); await store.dispose?.() }
  })

  test("removes only this app's localStorage keys, then reloads", async () => {
    window.localStorage.clear()
    window.localStorage.setItem("smithers-mvp.app-messages", "conversation")
    window.localStorage.setItem("smithers-mvp.persistenceBackend", "opfs")
    window.localStorage.setItem("smithers-mvp-quarantine.10.app-cards", "older envelope")
    window.localStorage.setItem("someone-elses-key", "not ours")
    let reloads = 0
    await resetLocalBrowserStorage(() => {
      reloads += 1
    })
    expect(reloads).toBe(1)
    expect(window.localStorage.getItem("smithers-mvp.app-messages")).toBeNull()
    expect(window.localStorage.getItem("smithers-mvp.persistenceBackend")).toBeNull()
    expect(window.localStorage.getItem("smithers-mvp-quarantine.10.app-cards")).toBeNull()
    expect(window.localStorage.getItem("someone-elses-key")).toBe("not ours")
  })
})
