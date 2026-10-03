import { installRequestId } from "./seams/InstallRequestId"
import { afterEach, describe, expect, test } from "bun:test"
import { digest } from "@smthrs/core/Digest"
import { agentTurnJournalDigestInput, type AgentTurnErasure } from "@smthrs/rpc/AgentTurnJournal"
import { TURN_ERASE_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { acknowledgeRemoteErasure, beginPrivacyRetirement, completePrivacyRetirement, deriveTurnErasures,
  PRIVACY_RETIREMENT_KEY, RESET_ERASURE_OUTBOX_KEY, preserveResetErasures, readResetErasures, readPrivacyRetirement, type PrivacyStorage } from "../chain/PrivacyRetirement"
import { createRemoteRetirementWorker } from "../chain/RemoteRetirement"
import { createTurnEraser, type EraseRemoteTurn } from "../runtime/TurnErasure"
import { createAppStore, type AppStore } from "./AppStore"
import { PERSISTENCE_BACKEND_STORAGE_KEY } from "../chain/SchemaVersion"
import { captureBrowserStorageRecovery, assertRecoverySnapshotCurrent } from "./BrowserStorageRecovery"

const token = "a".repeat(64), nextToken = "b".repeat(64)
const entry = (runId = "run", legId = "leg", raw = token): AgentTurnErasure => ({ runId, legId, retirementProof: digest(agentTurnJournalDigestInput("access", raw)) })
const memory = () => {
  const bytes = new Map<string, string>([[PERSISTENCE_BACKEND_STORAGE_KEY, "localStorage"]])
  const storage: PrivacyStorage = { get length() { return bytes.size }, key: index => [...bytes.keys()][index] ?? null,
    getItem: key => bytes.get(key) ?? null, setItem: (key, value) => { bytes.set(key, value) }, removeItem: key => { bytes.delete(key) } }
  return { storage, bytes }
}
const retire = (storage: PrivacyStorage, entries = [entry()]) => {
  const intent = beginPrivacyRetirement(storage, { id: installRequestId(), mode: "account", backend: "localStorage", targetStreamId: installRequestId() }, entries)
  completePrivacyRetirement(storage, intent)
  return intent
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const open = async (storage: PrivacyStorage, eraseTurn?: EraseRemoteTurn) => {
  const store = await createAppStore({ backend: { kind: "localStorage", storage }, mode: "localStorage", degraded: false,
    privacy: { record: storage, eraseInactiveDatabase: async () => {} } }, { eraseTurn })
  cleanups.push(async () => { await store.dispose?.() })
  return store
}
const start = async (store: AppStore, suffix = "", raw = token) => {
  await store.dispatch({ type: "http.turn.started", actor: "user", attemptId: `attempt${suffix}`, turnId: `run${suffix}`,
    text: "Private remote conversation", retry: false, journal: { version: 1, legId: `leg${suffix}`, token: raw } }).isPersisted.promise
  expect(store.collections.httpTurnLegs.get(`leg${suffix}`)?.status).toBe("prepared")
}

describe("private delete-only remote retirement outbox", () => {
  test("an ephemeral side turn keeps its proof across failed delivery, disposal, and retry", async () => {
    const { storage, bytes } = memory()
    const store = await open(storage)
    expect(store.queueTurnErasure("explain-run", { legId: "explain-leg", token })).toBe(true)
    expect(readResetErasures(storage)).toEqual([entry("explain-run", "explain-leg")])
    expect(JSON.stringify([...bytes])).not.toContain(token)
    await store.dispose?.()
    const failed = createRemoteRetirementWorker(storage, async () => { throw new Error("offline") })
    failed.wake(); await failed.settled(); await failed.dispose()
    expect(readResetErasures(storage)).toEqual([entry("explain-run", "explain-leg")])
    const erased: AgentTurnErasure[] = []
    const retried = createRemoteRetirementWorker(storage, async value => { erased.push(value) })
    retried.wake(); await retried.settled(); await retried.dispose()
    expect(erased).toEqual([entry("explain-run", "explain-leg")])
    expect(readResetErasures(storage)).toEqual([])
  })
  test("reset stages its known queue before erase and a refused staging write preserves the original marker", () => {
    const { storage } = memory(); retire(storage)
    const original = storage.getItem(PRIVACY_RETIREMENT_KEY)
    const fault = { ...storage, setItem: (key: string, value: string) => {
      if (key === RESET_ERASURE_OUTBOX_KEY) return // A lying host must fail the read-back check.
      storage.setItem(key, value)
    } }
    expect(() => preserveResetErasures(fault)).toThrow("cleanup")
    expect(storage.getItem(PRIVACY_RETIREMENT_KEY)).toBe(original)
    expect(storage.getItem(RESET_ERASURE_OUTBOX_KEY)).toBeNull()
    preserveResetErasures(storage)
    expect(readResetErasures(storage)).toEqual([entry()])
    expect(storage.getItem(RESET_ERASURE_OUTBOX_KEY)).not.toContain(token)
  })

  test("duplicate obligations drain once and stale proof acknowledgements cannot remove a reset obligation", async () => {
    const { storage } = memory(); retire(storage)
    preserveResetErasures(storage)
    acknowledgeRemoteErasure(storage, entry("run", "leg", nextToken))
    expect(readResetErasures(storage)).toEqual([entry()])
    let calls = 0
    const worker = createRemoteRetirementWorker(storage, async () => { calls++ })
    worker.wake(); await worker.settled(); await worker.dispose()
    expect(calls).toBe(1)
    expect(readResetErasures(storage)).toEqual([])
    expect(readPrivacyRetirement(storage)?.phase).toBe("complete")
  })

  test("a failed reset-outbox acknowledgement retries exact delete proof after the old marker is gone", async () => {
    const { storage } = memory(); retire(storage)
    preserveResetErasures(storage)
    storage.removeItem(PRIVACY_RETIREMENT_KEY)
    let failed = true
    const fault = { ...storage, removeItem: (key: string) => {
      if (failed && key === RESET_ERASURE_OUTBOX_KEY) throw new Error("ack not saved")
      storage.removeItem(key)
    } }
    let calls = 0
    const worker = createRemoteRetirementWorker(fault, async () => { calls++ })
    worker.wake(); await worker.settled()
    expect(readResetErasures(storage)).toEqual([entry()])
    failed = false
    worker.wake(); await worker.settled(); await worker.dispose()
    expect(calls).toBe(2)
    expect(readResetErasures(storage)).toEqual([])
  })

  test("pending local cleanup never starts remote work; recovered authority fills a degraded intent before token erasure", async () => {
    const { storage } = memory()
    const first = await open(storage)
    await start(first)
    beginPrivacyRetirement(storage, { id: "degraded-intent", mode: "account", backend: "localStorage", targetStreamId: "safe-next" })
    let calls = 0
    const premature = createRemoteRetirementWorker(storage, async () => { calls++ })
    premature.wake(); await premature.settled(); await premature.dispose()
    expect(calls).toBe(0)
    await first.dispose?.()
    const reopened = await open(storage)
    expect(reopened.privacyRetirementStatus()).toEqual({ phase: "remote-pending", remotePending: 1 })
    expect(readPrivacyRetirement(storage)?.erasures).toEqual([entry()])
    expect(JSON.stringify(await reopened.readRecovery())).not.toContain(token)
  })

  test("bounded drain passes retain and then acknowledge every entry beyond one pass", async () => {
    const { storage } = memory()
    const entries = Array.from({ length: 35 }, (_, index) => entry(`run-${index}`, `leg-${index}`))
    retire(storage, entries)
    const erased: AgentTurnErasure[] = []
    const worker = createRemoteRetirementWorker(storage, async item => { erased.push(item) })
    try {
      worker.wake(); await worker.settled()
      expect(erased).toHaveLength(32)
      expect(readPrivacyRetirement(storage)?.erasures).toEqual(entries.slice(32))
      worker.wake(); await worker.settled()
      expect(erased).toEqual(entries)
      expect(readPrivacyRetirement(storage)?.phase).toBe("complete")
    } finally { await worker.dispose() }
  })

  test("a non-answering eraser exhausts its budget without acknowledging or blocking clean state", async () => {
    const { storage } = memory(); retire(storage)
    const late = Promise.withResolvers<void>()
    const worker = createRemoteRetirementWorker(storage, () => late.promise, { budgetMs: 1 })
    worker.wake(); await worker.settled(); await worker.dispose()
    expect(readPrivacyRetirement(storage)?.phase).toBe("remote-pending")
    late.resolve(); await Promise.resolve()
    expect(readPrivacyRetirement(storage)?.erasures).toEqual([entry()])
  })

  test("prepared producer proof is staged before raw-token erasure and offline work does not block a new owner", async () => {
    const { storage, bytes } = memory()
    const store = await open(storage)
    await start(store)
    await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    expect(store.privacyRetirementStatus()).toEqual({ phase: "remote-pending", remotePending: 1 })
    expect(readPrivacyRetirement(storage)?.erasures).toEqual([entry()])
    expect(JSON.stringify([...bytes])).not.toContain(token)
    expect(JSON.stringify(await store.readRecovery())).not.toContain(entry().retirementProof)
    expect(JSON.stringify(store.agentContextSnapshot())).not.toContain(entry().retirementProof)
    expect(JSON.stringify(await store.eventHistory())).not.toContain(entry().retirementProof)
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "bob", admin: false, scopesPlain: null }).isPersisted.promise
    expect(store.session().phase).toBe("idle")
    await start(store, "-new", nextToken)
    await store.dispatch({ type: "app.reset", actor: "user" }).isPersisted.promise
    expect(readPrivacyRetirement(storage)?.erasures).toEqual([entry(), entry("run-new", "leg-new", nextToken)])
    expect(JSON.stringify([...bytes])).not.toContain(nextToken)
    expect(store.privacyRetirementStatus()).toEqual({ phase: "remote-pending", remotePending: 2 })
  })

  test("boot drains after local cleanup without account or agent startup and durably drops only acknowledged proofs", async () => {
    const { storage } = memory()
    const first = await open(storage)
    await start(first)
    await first.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    await first.dispose?.()
    const received = Promise.withResolvers<AgentTurnErasure>(), release = Promise.withResolvers<void>()
    const reopened = await open(storage, async item => { received.resolve(item); await release.promise })
    expect(await received.promise).toEqual(entry())
    expect(reopened.privacyRetirementStatus().phase).toBe("remote-pending")
    expect(reopened.session().phase).toBe("idle")
    release.resolve()
    // Worker acknowledgement crosses a few promise continuations, no timer is needed.
    for (let i = 0; i < 20 && readPrivacyRetirement(storage)?.phase !== "complete"; i++) await Promise.resolve()
    expect(reopened.privacyRetirementStatus()).toEqual({ phase: "complete", remotePending: 0 })
    expect(storage.getItem(PRIVACY_RETIREMENT_KEY)).not.toContain(entry().retirementProof)
  })

  test("lost acknowledgement retries the same erase; an old response cannot overwrite a newer merged local intent", async () => {
    const { storage } = memory()
    retire(storage)
    let calls = 0, failAck = true
    const fault: PrivacyStorage = { ...storage, get length() { return storage.length }, setItem: (key, value) => {
      if (failAck && key === PRIVACY_RETIREMENT_KEY && value.includes('"phase":"complete"')) throw new Error("ack receipt unavailable")
      storage.setItem(key, value)
    } }
    const first = createRemoteRetirementWorker(fault, async () => { calls++ })
    first.wake(); await first.settled(); await first.dispose()
    expect(readPrivacyRetirement(storage)?.erasures).toEqual([entry()])
    failAck = false
    const waiting = Promise.withResolvers<void>(), called = Promise.withResolvers<void>()
    const second = createRemoteRetirementWorker(fault, async () => { calls++; called.resolve(); await waiting.promise })
    second.wake(); await called.promise
    const next = beginPrivacyRetirement(storage, { id: "new-owner", mode: "reset", backend: "localStorage", targetStreamId: "new-stream" }, [entry("other", "other-leg", nextToken)])
    waiting.resolve(); await second.settled(); await second.dispose()
    expect(calls).toBe(2)
    expect(readPrivacyRetirement(storage)).toMatchObject({ id: next.id, phase: "pending", erasures: [entry("other", "other-leg", nextToken)] })
    completePrivacyRetirement(storage, next)
    expect(readPrivacyRetirement(storage)?.phase).toBe("remote-pending")
  })

  for (const status of [404, 401, 500]) test(`HTTP ${status} is not a remote erase acknowledgement`, async () => {
    const { storage } = memory(); retire(storage)
    const erase = createTurnEraser(async () => new Response("not acknowledged", { status }))
    const worker = createRemoteRetirementWorker(storage, erase)
    worker.wake(); await worker.settled(); await worker.dispose()
    expect(readPrivacyRetirement(storage)?.erasures).toEqual([entry()])
  })

  test("only typed ERASE success removes the proof; transport sends no read token or identity", async () => {
    const { storage } = memory(); retire(storage)
    const calls: Array<{ url: string; body: unknown; headers: unknown }> = []
    const erase = createTurnEraser(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers })
      return Response.json({ status: "retired" })
    })
    const worker = createRemoteRetirementWorker(storage, erase)
    worker.wake(); await worker.settled(); await worker.dispose()
    expect(calls).toEqual([{ url: TURN_ERASE_PATH, body: entry(), headers: { "content-type": "application/json" } }])
    expect(JSON.stringify(calls)).not.toContain(token)
    expect(readPrivacyRetirement(storage)).toMatchObject({ phase: "complete", erasures: [] })
  })

  test("unknown success bodies and network failures retain pending work", async () => {
    for (const http of [async () => Response.json({ status: "ok" }), async () => { throw new Error("offline") }]) {
      const { storage } = memory(); retire(storage)
      const worker = createRemoteRetirementWorker(storage, createTurnEraser(http))
      worker.wake(); await worker.settled(); await worker.dispose()
      expect(readPrivacyRetirement(storage)?.phase).toBe("remote-pending")
    }
  })

  test("disposing aborts a stuck eraser and a late acknowledgement cannot mutate released storage", async () => {
    const { storage } = memory(); retire(storage)
    const entered = Promise.withResolvers<void>(), late = Promise.withResolvers<void>()
    const worker = createRemoteRetirementWorker(storage, async () => { entered.resolve(); await late.promise })
    worker.wake(); await entered.promise
    await worker.dispose()
    const before = storage.getItem(PRIVACY_RETIREMENT_KEY)
    late.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(storage.getItem(PRIVACY_RETIREMENT_KEY)).toBe(before)
    expect(readPrivacyRetirement(storage)?.phase).toBe("remote-pending")
  })

  test("capture omits delete proofs and acknowledgement alone does not invalidate the clean generation", async () => {
    const { storage } = memory(); retire(storage)
    const snapshot = await captureBrowserStorageRecovery({ session: "localStorage", localStorage: storage, sqlite: undefined })
    expect(JSON.stringify(snapshot)).not.toContain(entry().retirementProof)
    expect(snapshot.localStorage?.some(row => row.key === PRIVACY_RETIREMENT_KEY)).toBe(false)
    acknowledgeRemoteErasure(storage, entry())
    expect(() => assertRecoverySnapshotCurrent(snapshot)).not.toThrow()
    retire(storage, [entry("new", "next", nextToken)])
    expect(() => assertRecoverySnapshotCurrent(snapshot)).toThrow("changed")
  })

  test("proof derivation is deterministic and conflicting scoped capabilities cannot silently replace one another", () => {
    expect(deriveTurnErasures([{ turnId: "run", journal: { legId: "leg", token } }])).toEqual([entry()])
    const { storage } = memory(); retire(storage)
    const before = storage.getItem(PRIVACY_RETIREMENT_KEY)
    expect(() => beginPrivacyRetirement(storage, { id: "new", mode: "reset", backend: "localStorage", targetStreamId: "new" }, [entry("run", "leg", nextToken)])).toThrow("cleanup")
    expect(storage.getItem(PRIVACY_RETIREMENT_KEY)).toBe(before)
  })
})
