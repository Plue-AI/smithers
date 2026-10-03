import { installRequestId } from "./seams/InstallRequestId"
import type { StorageApi } from "@tanstack/db"
import { afterEach, expect, test } from "bun:test"
import { digest } from "@smthrs/core/Digest"
import { PERSISTENCE_BACKEND_STORAGE_KEY } from "../chain/SchemaVersion"
import { beginPrivacyRetirement, readPrivacyRetirement, type PrivacyStorage } from "../chain/PrivacyRetirement"
import { ENVELOPE_STORAGE_KEY, parseStorageEnvelope } from "../chain/TransactionalStorage"
import { APP_PROJECTOR_VERSION, appProjectionHash, replayAppEvents } from "./AppEventStream"
import { canonicalEventValue } from "./EventValue"
import { appProjectionHasOrphanedProviderRequests, type AppProjectionSnapshot } from "./AppProjection"
import { createAppStore, type AppStore } from "./AppStore"

const secret = "ALICE-PRIVATE-DEVICE-CODE-2828"
const privateMetadata = [secret, "ALICE-PRIVATE-ORDER-2828", "ALICE-PRIVATE-REVOKE-2828",
  "old-device-request", "old-order-request", "old-revoke-request", "11111111-1111-1111-1111-111111111111",
  "https://alice.example/device", "alice"]
const request = { id: "old-device-request", owner: "alice", action: "codex" as const, state: "requested" as const,
  device: { id: "11111111-1111-1111-1111-111111111111", userCode: secret,
    verificationUri: "https://alice.example/device", interval: 5, expiresAt: "2099-01-01T00:00:00Z" } }
const requests = [request,
  { id: "old-order-request", owner: "alice", action: "order" as const, provider: "claude" as const,
    ids: [privateMetadata[1]!], state: "completed" as const },
  { id: "old-revoke-request", owner: "alice", action: "revoke" as const,
    connectionId: privateMetadata[2]!, state: "failed" as const }]

const memory = () => {
  const bytes = new Map<string, string>()
  const storage: PrivacyStorage = {
    get length() { return bytes.size }, key: index => [...bytes.keys()][index] ?? null,
    getItem: key => bytes.get(key) ?? null,
    setItem: (key, value) => { bytes.set(key, value) },
    removeItem: key => { bytes.delete(key) }
  }
  storage.setItem(PERSISTENCE_BACKEND_STORAGE_KEY, "localStorage")
  return { storage, bytes }
}

const opened: AppStore[] = []
afterEach(async () => { for (const store of opened.splice(0)) await Promise.resolve(store.dispose?.()).catch(() => {}) })
const open = async (storage: PrivacyStorage) => {
  const store = await createAppStore({ backend: { kind: "localStorage", storage }, mode: "localStorage", degraded: false,
    privacy: { record: storage, eraseInactiveDatabase: async () => {} } })
  opened.push(store)
  return store
}

/** Simulate the old build's sealed, signed-out checkpoint and its materialized row. */
const signedOutFixture = async (version = APP_PROJECTOR_VERSION, completeMarker = false) => {
  const { storage, bytes } = memory()
  const first = await open(storage)
  if (completeMarker) {
    await first.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
      admin: false, scopesPlain: null }).isPersisted.promise
    await first.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    expect(readPrivacyRetirement(storage)?.phase).toBe("complete")
  } else {
    await first.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null,
      admin: false, scopesPlain: null }).isPersisted.promise
  }
  if (!completeMarker) await first.compactEvents()
  const before = await first.eventHistory()
  expect(before.events).toHaveLength(0)
  await first.dispose?.()
  opened.splice(opened.indexOf(first), 1)

  const envelope = parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!
  const entries = envelope.entries
  const sessionKey = "smithers-mvp.app-sessions"
  const checkpointKey = "smithers-mvp.app-event-checkpoints"
  const headKey = "smithers-mvp.app-event-heads"
  const sessionRows = JSON.parse(entries[sessionKey]!) as Record<string, { data: Record<string, unknown> }>
  sessionRows["s:main"]!.data.codingProviderRequests = requests
  entries[sessionKey] = JSON.stringify(sessionRows)
  const checkpointRows = JSON.parse(entries[checkpointKey]!) as Record<string, { data: Record<string, unknown> }>
  const checkpoint = checkpointRows["s:current"]!.data
  const snapshot = checkpoint.snapshot as AppProjectionSnapshot
  ;(snapshot.sessions[0] as { codingProviderRequests?: unknown }).codingProviderRequests = requests
  const stateHash = appProjectionHash(snapshot)
  checkpoint.projectorVersion = version
  checkpoint.stateHash = stateHash
  checkpoint.reason = "privacy-reset"
  const { hash: _hash, ...body } = checkpoint
  checkpoint.hash = digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body))
  entries[checkpointKey] = JSON.stringify(checkpointRows)
  const headRows = JSON.parse(entries[headKey]!) as Record<string, { data: Record<string, unknown> }>
  headRows["s:current"]!.data.projectorVersion = version
  headRows["s:current"]!.data.stateHash = stateHash
  entries[headKey] = JSON.stringify(headRows)
  storage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify(envelope))
  for (const marker of privateMetadata) expect(storage.getItem(ENVELOPE_STORAGE_KEY)).toContain(marker)
  return { storage, bytes, oldStream: before.head.streamId }
}

const expectClean = async (store: AppStore, storage: StorageApi, oldStream: string) => {
  expect(store.session().codingProviderRequests ?? []).toEqual([])
  expect((await store.verifyState()).valid).toBe(true)
  const history = await store.eventHistory()
  expect(history.head.streamId).not.toBe(oldStream)
  for (const marker of privateMetadata) {
    expect(JSON.stringify(history)).not.toContain(marker)
    expect(storage.getItem(ENVELOPE_STORAGE_KEY)).not.toContain(marker)
  }
}

for (const version of [APP_PROJECTOR_VERSION, APP_PROJECTOR_VERSION - 1]) {
  test(`boot retires a sealed signed-out checkpoint with private coding requests at projector ${version}`, async () => {
    const { storage, bytes, oldStream } = await signedOutFixture(version, version === APP_PROJECTOR_VERSION)
    storage.setItem("smithers-mvp-quarantine.store.old", secret)
    const store = await open(storage)
    await expectClean(store, storage, oldStream)
    expect(readPrivacyRetirement(storage)).toMatchObject({ phase: "complete", mode: "account" })
    for (const marker of privateMetadata) expect(JSON.stringify([...bytes])).not.toContain(marker)
    await store.dispose?.()
    opened.splice(opened.indexOf(store), 1)
    const reopened = await open(storage)
    await expectClean(reopened, storage, oldStream)
  })
}

test("failed boot cleanup is reported and resumes on the next open", async () => {
  const fixture = await signedOutFixture()
  let failCleanup = true
  const storage: PrivacyStorage = { ...fixture.storage, get length() { return fixture.storage.length },
    setItem: (key, value) => {
      if (failCleanup && key === ENVELOPE_STORAGE_KEY && readPrivacyRetirement(fixture.storage)?.phase === "pending") {
        throw new Error("checkpoint disk failure")
      }
      fixture.storage.setItem(key, value)
    } }
  await expect(open(storage)).rejects.toThrow("checkpoint disk failure")
  expect(readPrivacyRetirement(storage)?.phase).toBe("pending")
  expect(storage.getItem(ENVELOPE_STORAGE_KEY)).toContain(secret)
  failCleanup = false
  const recovered = await open(storage)
  await expectClean(recovered, storage, fixture.oldStream)
  expect(readPrivacyRetirement(storage)?.phase).toBe("complete")
})

test("a recovery-copy removal failure keeps cleanup pending after the clean checkpoint commits", async () => {
  const fixture = await signedOutFixture()
  const oldCopy = "smithers-mvp-quarantine.store.old"
  fixture.storage.setItem(oldCopy, secret)
  let refuseRemoval = true
  const storage: PrivacyStorage = { ...fixture.storage, get length() { return fixture.storage.length },
    removeItem: key => { if (!refuseRemoval || key !== oldCopy) fixture.storage.removeItem(key) } }
  await expect(open(storage)).rejects.toThrow("cleanup")
  expect(readPrivacyRetirement(storage)?.phase).toBe("pending")
  expect(storage.getItem(oldCopy)).toBe(secret)
  expect(storage.getItem(ENVELOPE_STORAGE_KEY)).not.toContain(secret)
  refuseRemoval = false
  const recovered = await open(storage)
  await expectClean(recovered, storage, fixture.oldStream)
  expect(storage.getItem(oldCopy)).toBeNull()
  expect(readPrivacyRetirement(storage)?.phase).toBe("complete")
})

for (const version of [APP_PROJECTOR_VERSION, APP_PROJECTOR_VERSION - 1]) {
  test(`corrupt projector ${version} checkpoint is refused before private bytes are erased`, async () => {
    const { storage } = await signedOutFixture(version)
    const envelope = parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!
    const key = "smithers-mvp.app-event-checkpoints"
    const rows = JSON.parse(envelope.entries[key]!) as Record<string, { data: Record<string, unknown> }>
    rows["s:current"]!.data.hash = "0".repeat(64)
    envelope.entries[key] = JSON.stringify(rows)
    storage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify(envelope))
    await expect(open(storage)).rejects.toMatchObject({ reason: "checkpoint" })
    for (const marker of privateMetadata) expect(storage.getItem(ENVELOPE_STORAGE_KEY)).toContain(marker)
    expect(readPrivacyRetirement(storage)).toBeUndefined()
  })
}

test("a pending old cleanup targeting the contaminated stream rotates again before clearing it", async () => {
  const { storage, oldStream } = await signedOutFixture()
  beginPrivacyRetirement(storage, { id: installRequestId(), mode: "account", backend: "localStorage", targetStreamId: oldStream })
  const store = await open(storage)
  await expectClean(store, storage, oldStream)
  expect(readPrivacyRetirement(storage)).toMatchObject({ phase: "complete", targetStreamId: (await store.eventHistory()).head.streamId })
  await store.dispose?.()
  opened.splice(opened.indexOf(store), 1)
  const reopened = await open(storage)
  await expectClean(reopened, storage, oldStream)
  await reopened.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "bob",
    admin: false, scopesPlain: null }).isPersisted.promise
  expect(reopened.session().codingProviderRequests ?? []).toEqual([])
})

for (const identity of ["signed-in", "unavailable"] as const) {
  test(`pending same-owner request survives ${identity} reopen`, async () => {
    const { storage } = memory()
    const first = await open(storage)
    await first.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
      admin: false, scopesPlain: null }).isPersisted.promise
    await first.dispatch({ type: "coding.provider.requests.changed", actor: "system", requests: [request] }).isPersisted.promise
    if (identity === "unavailable") await first.dispatch({ type: "identity.session.loaded", actor: "system",
      state: "unavailable", login: null, admin: false, scopesPlain: null }).isPersisted.promise
    await first.dispose?.()
    opened.splice(opened.indexOf(first), 1)
    const reopened = await open(storage)
    expect(reopened.session().codingProviderRequests).toEqual([request])
    expect((await reopened.verifyState()).valid).toBe(true)
    expect(storage.getItem(ENVELOPE_STORAGE_KEY)).toContain(secret)
    if (identity === "unavailable") {
      await reopened.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
        admin: false, scopesPlain: null }).isPersisted.promise
      expect(reopened.session().codingProviderRequests).toEqual([request])
    }
  })
}

test("unknown ownership does not qualify a saved request for signed-out cleanup", async () => {
  const { storage } = await signedOutFixture()
  const store = await open(storage)
  const history = await store.eventHistory()
  const signedOut = replayAppEvents(history.checkpoint, history.events, history.head).snapshot
  expect(appProjectionHasOrphanedProviderRequests(signedOut)).toBe(false)
  const withRequests = { ...signedOut, sessions: signedOut.sessions.map(row => ({ ...row, codingProviderRequests: requests })) }
  expect(appProjectionHasOrphanedProviderRequests(withRequests)).toBe(true)
  expect(appProjectionHasOrphanedProviderRequests({ ...withRequests, identitySessions: [] })).toBe(false)
  const { accountOwnerLogin: _owner, ...legacyIdentity } = signedOut.identitySessions[0]!
  expect(appProjectionHasOrphanedProviderRequests({ ...withRequests, identitySessions: [
    { ...legacyIdentity, state: "unavailable", login: null }
  ] })).toBe(false)
  expect(appProjectionHasOrphanedProviderRequests({ ...withRequests, identitySessions: [
    { ...legacyIdentity, state: "unavailable", login: null, accountOwnerLogin: "alice" }
  ] })).toBe(false)
  expect(appProjectionHasOrphanedProviderRequests({ ...withRequests, identitySessions: [
    { ...legacyIdentity, state: "unknown", login: null, accountOwnerLogin: null }
  ] })).toBe(false)
  expect(appProjectionHasOrphanedProviderRequests({ ...withRequests, identitySessions: [
    { ...legacyIdentity, state: "unavailable", login: null, accountOwnerLogin: null }
  ] })).toBe(false)
})

test("missing identity in an older checkpoint never turns a synthetic null owner into sign-out cleanup", async () => {
  const { storage, oldStream } = await signedOutFixture(APP_PROJECTOR_VERSION - 1)
  const envelope = parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!
  const checkpointKey = "smithers-mvp.app-event-checkpoints"
  const headKey = "smithers-mvp.app-event-heads"
  const identityKey = "smithers-mvp.app-identity-sessions"
  const checkpointRows = JSON.parse(envelope.entries[checkpointKey]!) as Record<string, { data: Record<string, unknown> }>
  const checkpoint = checkpointRows["s:current"]!.data
  const snapshot = { ...(checkpoint.snapshot as AppProjectionSnapshot), identitySessions: [] }
  checkpoint.snapshot = snapshot
  const stateHash = appProjectionHash(snapshot)
  checkpoint.stateHash = stateHash
  const { hash: _hash, ...body } = checkpoint
  checkpoint.hash = digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body))
  envelope.entries[checkpointKey] = JSON.stringify(checkpointRows)
  const headRows = JSON.parse(envelope.entries[headKey]!) as Record<string, { data: Record<string, unknown> }>
  headRows["s:current"]!.data.stateHash = stateHash
  envelope.entries[headKey] = JSON.stringify(headRows)
  envelope.entries[identityKey] = "{}"
  storage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify(envelope))

  const first = await open(storage)
  expect(first.session().codingProviderRequests).toEqual(requests)
  expect(first.collections.identitySessions.get("identity")?.state).toBe("unknown")
  expect((await first.verifyState()).valid).toBe(true)
  expect(storage.getItem(ENVELOPE_STORAGE_KEY)).toContain(secret)
  expect(readPrivacyRetirement(storage)).toBeUndefined()
  await first.dispose?.()
  opened.splice(opened.indexOf(first), 1)

  const second = await open(storage)
  expect(second.session().codingProviderRequests).toEqual(requests)
  expect((await second.eventHistory()).head.streamId).not.toBe(oldStream)
  expect(readPrivacyRetirement(storage)).toBeUndefined()
  await second.dispatch({ type: "identity.session.loaded", actor: "system", state: "unavailable", login: null,
    admin: false, scopesPlain: null }).isPersisted.promise
  expect(second.session().codingProviderRequests).toEqual(requests)
  await second.dispose?.()
  opened.splice(opened.indexOf(second), 1)

  const third = await open(storage)
  expect(third.session().codingProviderRequests).toEqual(requests)
  expect(readPrivacyRetirement(storage)).toBeUndefined()
  await third.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
    admin: false, scopesPlain: null }).isPersisted.promise
  expect(third.session().codingProviderRequests).toEqual(requests)
  expect((await third.verifyState()).valid).toBe(true)
  expect(storage.getItem(ENVELOPE_STORAGE_KEY)).toContain(secret)
})

test("older checkpoint keeps Alice's requests when a materialized identity falsely says signed out", async () => {
  const { storage } = memory()
  const first = await open(storage)
  await first.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
    admin: false, scopesPlain: null }).isPersisted.promise
  await first.dispatch({ type: "coding.provider.requests.changed", actor: "system", requests }).isPersisted.promise
  await first.compactEvents()
  const history = await first.eventHistory()
  expect(history.events).toHaveLength(0)
  expect(history.checkpoint.snapshot.sessions).toEqual(expect.arrayContaining([
    expect.objectContaining({ codingProviderRequests: requests })
  ]))
  await first.dispose?.()
  opened.splice(opened.indexOf(first), 1)

  const envelope = parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!
  const checkpointKey = "smithers-mvp.app-event-checkpoints"
  const headKey = "smithers-mvp.app-event-heads"
  const identityKey = "smithers-mvp.app-identity-sessions"
  const checkpointRows = JSON.parse(envelope.entries[checkpointKey]!) as Record<string, { data: Record<string, unknown> }>
  const checkpoint = checkpointRows["s:current"]!.data
  checkpoint.projectorVersion = APP_PROJECTOR_VERSION - 1
  const { hash: _hash, ...body } = checkpoint
  checkpoint.hash = digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body))
  envelope.entries[checkpointKey] = JSON.stringify(checkpointRows)
  const headRows = JSON.parse(envelope.entries[headKey]!) as Record<string, { data: Record<string, unknown> }>
  headRows["s:current"]!.data.projectorVersion = APP_PROJECTOR_VERSION - 1
  envelope.entries[headKey] = JSON.stringify(headRows)
  const correctIdentity = envelope.entries[identityKey]!
  const identityRows = JSON.parse(correctIdentity) as Record<string, { data: Record<string, unknown> }>
  Object.assign(identityRows["s:identity"]!.data, { state: "signed-out", login: null, accountOwnerLogin: null })
  envelope.entries[identityKey] = JSON.stringify(identityRows)
  storage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify(envelope))

  await expect(open(storage)).rejects.toMatchObject({ _tag: "PrivacyAuthorityMissing" })
  expect(readPrivacyRetirement(storage)).toBeUndefined()
  for (const marker of privateMetadata) expect(storage.getItem(ENVELOPE_STORAGE_KEY)).toContain(marker)

  const repaired = parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!
  repaired.entries[identityKey] = correctIdentity
  storage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify(repaired))
  const reopened = await open(storage)
  expect(reopened.session().codingProviderRequests).toEqual(requests)
  expect(reopened.collections.identitySessions.get("identity")?.accountOwnerLogin).toBe("alice")
  expect((await reopened.verifyState()).valid).toBe(true)
  expect(storage.getItem(ENVELOPE_STORAGE_KEY)).toContain(secret)
  expect(readPrivacyRetirement(storage)).toBeUndefined()
})

test("an older signed-out checkpoint with an uncovered event suffix is refused before cleanup", async () => {
  const { storage } = memory()
  const first = await open(storage)
  await first.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null,
    admin: false, scopesPlain: null }).isPersisted.promise
  await first.dispatch({ type: "coding.provider.requests.changed", actor: "system", requests }).isPersisted.promise
  await first.compactEvents()
  await first.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
  const history = await first.eventHistory()
  expect(history.events).toHaveLength(1)
  expect(history.checkpoint.snapshot.sessions).toEqual(expect.arrayContaining([
    expect.objectContaining({ codingProviderRequests: requests })
  ]))
  expect(history.head.sequence).toBe(history.checkpoint.sequence + 1)
  await first.dispose?.()
  opened.splice(opened.indexOf(first), 1)

  const envelope = parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!
  const checkpointKey = "smithers-mvp.app-event-checkpoints"
  const headKey = "smithers-mvp.app-event-heads"
  const eventKey = "smithers-mvp.app-events"
  const checkpointRows = JSON.parse(envelope.entries[checkpointKey]!) as Record<string, { data: Record<string, unknown> }>
  const checkpoint = checkpointRows["s:current"]!.data
  checkpoint.projectorVersion = APP_PROJECTOR_VERSION - 1
  const { hash: _checkpointHash, ...checkpointBody } = checkpoint
  checkpoint.hash = digest("smithers-app/checkpoint/v1:" + canonicalEventValue(checkpointBody))
  envelope.entries[checkpointKey] = JSON.stringify(checkpointRows)
  const eventRows = JSON.parse(envelope.entries[eventKey]!) as Record<string, { data: Record<string, unknown> }>
  const event = Object.values(eventRows)[0]!.data
  event.projectorVersion = APP_PROJECTOR_VERSION - 1
  const { hash: _eventHash, ...eventBody } = event
  event.hash = digest("smithers-app/event/v1:" + canonicalEventValue(eventBody))
  envelope.entries[eventKey] = JSON.stringify(eventRows)
  const headRows = JSON.parse(envelope.entries[headKey]!) as Record<string, { data: Record<string, unknown> }>
  headRows["s:current"]!.data.projectorVersion = APP_PROJECTOR_VERSION - 1
  headRows["s:current"]!.data.eventHash = event.hash
  envelope.entries[headKey] = JSON.stringify(headRows)
  storage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify(envelope))

  await expect(open(storage)).rejects.toMatchObject({ _tag: "PrivacyAuthorityMissing" })
  expect(readPrivacyRetirement(storage)).toBeUndefined()
  for (const marker of privateMetadata) expect(storage.getItem(ENVELOPE_STORAGE_KEY)).toContain(marker)
})
