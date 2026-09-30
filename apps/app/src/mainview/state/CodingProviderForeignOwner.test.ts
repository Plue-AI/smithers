import { afterEach, expect, test } from "bun:test"
import { PERSISTENCE_BACKEND_STORAGE_KEY } from "../chain/SchemaVersion"
import { readPrivacyRetirement, type PrivacyStorage } from "../chain/PrivacyRetirement"
import { ENVELOPE_STORAGE_KEY } from "../chain/TransactionalStorage"
import { appProjectionHasForeignProviderRequests, scrubForeignProviderRequests, type AppProjectionSnapshot } from "./AppProjection"
import { createAppStore, type AppStore } from "./AppStore"

const secret = "ALICE-PRIVATE-DEVICE-CODE-2873"
type Request = NonNullable<ReturnType<AppStore["session"]>["codingProviderRequests"]>[number]
const alice: Request[] = [
  { id: "alice-device", owner: "alice", action: "codex" as const, state: "requested" as const,
    device: { id: "22222222-2222-2222-2222-222222222222", userCode: secret, verificationUri: "https://alice.example/device", interval: 5, expiresAt: "2099-01-01T00:00:00Z" } },
  { id: "alice-order", owner: "alice", action: "order" as const, provider: "claude" as const, ids: ["ALICE-ORDER-2873"], state: "completed" as const }
]
const bob: Request = { id: "bob-connect", owner: "bob", action: "connect" as const, state: "requested" as const }
const markers = [secret, "alice-device", "alice-order", "ALICE-ORDER-2873", "alice.example"]

const memory = () => {
  const bytes = new Map<string, string>()
  const storage: PrivacyStorage = {
    get length() { return bytes.size }, key: index => [...bytes.keys()][index] ?? null,
    getItem: key => bytes.get(key) ?? null, setItem: (key, value) => { bytes.set(key, value) }, removeItem: key => { bytes.delete(key) }
  }
  storage.setItem(PERSISTENCE_BACKEND_STORAGE_KEY, "localStorage")
  return storage
}
const opened: AppStore[] = []
afterEach(async () => { for (const store of opened.splice(0)) await Promise.resolve(store.dispose?.()).catch(() => {}) })
const open = async (storage: PrivacyStorage) => {
  const store = await createAppStore({ backend: { kind: "localStorage", storage }, mode: "localStorage", degraded: false,
    privacy: { record: storage, eraseInactiveDatabase: async () => {} } })
  opened.push(store)
  return store
}
const close = async (store: AppStore) => { await store.dispose?.(); opened.splice(opened.indexOf(store), 1) }
const signIn = (store: AppStore, login: string) => store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login,
  admin: false, scopesPlain: null }).isPersisted.promise

/** A pre-fix store: Bob is signed in and Alice's request metadata was never cleaned. */
const saved = async (requests: Request[], login = "bob") => {
  const storage = memory()
  const first = await open(storage)
  await signIn(first, login)
  await first.dispatch({ type: "coding.provider.requests.changed", actor: "system", requests }).isPersisted.promise
  const stream = (await first.eventHistory()).head.streamId
  await close(first)
  return { storage, stream }
}
const expectNoAlice = async (store: AppStore, storage: PrivacyStorage) => {
  for (const marker of markers) {
    expect(JSON.stringify(await store.eventHistory())).not.toContain(marker)
    expect(storage.getItem(ENVELOPE_STORAGE_KEY)).not.toContain(marker)
  }
}

test("a different owner's request metadata is scrubbed and the signed-in owner's work survives", async () => {
  const { storage, stream } = await saved([...alice, bob])
  storage.setItem("smithers-mvp-quarantine.store.old", secret)
  expect(storage.getItem(ENVELOPE_STORAGE_KEY)).toContain(secret)
  const store = await open(storage)
  expect(store.session().codingProviderRequests).toEqual([bob])
  expect((await store.verifyState()).valid).toBe(true)
  expect((await store.eventHistory()).head.streamId).not.toBe(stream)
  await expectNoAlice(store, storage)
  expect(storage.getItem("smithers-mvp-quarantine.store.old")).toBeNull()
  expect(readPrivacyRetirement(storage)).toMatchObject({ phase: "complete", mode: "scrub" })
  expect(store.collections.identitySessions.get("identity")).toMatchObject({ state: "signed-in", login: "bob" })
  await close(store)
  const reopened = await open(storage)
  expect(reopened.session().codingProviderRequests).toEqual([bob])
  await expectNoAlice(reopened, storage)
})

test("a store holding only foreign requests ends with none", async () => {
  const { storage } = await saved(alice)
  const store = await open(storage)
  expect(store.session().codingProviderRequests ?? []).toEqual([])
  await expectNoAlice(store, storage)
})

test("the signed-in owner's own requests are left in place on the same stream", async () => {
  const { storage, stream } = await saved([bob])
  const store = await open(storage)
  expect(store.session().codingProviderRequests).toEqual([bob])
  expect((await store.eventHistory()).head.streamId).toBe(stream)
  expect(readPrivacyRetirement(storage)).toBeUndefined()
})

test("an unavailable identity is unknown ownership and keeps every request", async () => {
  const { storage } = await saved([...alice, bob])
  const first = await open(storage)
  const scrubbed = first.session().codingProviderRequests
  await first.dispatch({ type: "identity.session.loaded", actor: "system", state: "unavailable", login: null, 
    admin: false, scopesPlain: null }).isPersisted.promise
  await first.dispatch({ type: "coding.provider.requests.changed", actor: "system", requests: [...alice, bob] }).isPersisted.promise
  expect(scrubbed).toEqual([bob])
  await close(first)
  const reopened = await open(storage)
  expect(reopened.session().codingProviderRequests).toEqual([...alice, bob])
})

test("a signed-out store is not a foreign-owner case", () => {
  const snapshot = { identitySessions: [{ id: "identity", state: "signed-out", accountOwnerLogin: null }], sessions: [{ codingProviderRequests: alice }] } as unknown as AppProjectionSnapshot
  expect(appProjectionHasForeignProviderRequests(snapshot)).toBe(false)
  expect(scrubForeignProviderRequests(snapshot)).toBe(snapshot)
})

test("a failed cleanup write is reported and the next open finishes it", async () => {
  const fixture = await saved([...alice, bob])
  let fail = true
  const storage: PrivacyStorage = { ...fixture.storage, get length() { return fixture.storage.length },
    setItem: (key, value) => {
      if (fail && key === ENVELOPE_STORAGE_KEY && readPrivacyRetirement(fixture.storage)?.phase === "pending") throw new Error("checkpoint disk failure")
      fixture.storage.setItem(key, value)
    } }
  await expect(open(storage)).rejects.toThrow("checkpoint disk failure")
  expect(readPrivacyRetirement(storage)?.phase).toBe("pending")
  fail = false
  const recovered = await open(storage)
  expect(recovered.session().codingProviderRequests).toEqual([bob])
  await expectNoAlice(recovered, storage)
  expect(readPrivacyRetirement(storage)?.phase).toBe("complete")
})
