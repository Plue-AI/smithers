import { AGENT_ROLES } from "@smthrs/rpc/AgentRoles"
import { initialSetup, setupActivationProblems, setupCandidate, storedSetupCandidate } from "@smthrs/rpc/RepositorySetup"
import type { StorageApi } from "@tanstack/db"
import { Database } from "bun:sqlite"
import { afterEach,describe,expect,test } from "bun:test"
import { mkdtempSync,rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { APP_SCHEMA_VERSION,SCHEMA_VERSION_STORAGE_KEY } from "../chain/SchemaVersion"
import { openSqliteRowStorage,ROW_TABLE_NAME } from "../chain/SqliteRowStorage"
import { PRIVACY_RETIREMENT_KEY, readPrivacyRetirement } from "../chain/PrivacyRetirement"
import { ENVELOPE_STORAGE_KEY,parseStorageEnvelope } from "../chain/TransactionalStorage"
import { digest } from "@smthrs/core/Digest"
import { APP_PROJECTOR_VERSION, AppProjectorVersionError, AppEventIntegrityError, appProjectionHash, retiredAppStreamKey, replayAppEvents } from "./AppEventStream"
import { APP_PROJECTION_COLLECTION_NAMES, appProjectionKey } from "./AppProjection"
import { initialSession, cardFrameId } from "./AppState"
import { createAppStore,PERSISTED_COLLECTION_SPECS,type AppStore } from "./AppStore"
import { canonicalEventValue, decodeEventValue, encodeEventValue } from "./EventValue"
import { memoryStorage } from "./TestFixtures"
import { MAX_TRANSITION_PAYLOAD_BYTES } from "./TransitionDiagnostics"
import { runtimeApprovalKey } from "./RuntimeProjection"
import { ENTITY_RECOVERY_STORAGE_KEY, readEntityRecoveries, writeEntityRecovery } from "./EntityRecovery"
import type { Signup } from "./Signup"

const opened: AppStore[] = []
const directories: string[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.dispose?.()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const open = async (storage: StorageApi) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  opened.push(store)
  return store
}
const editEnvelope = (storage: StorageApi, edit: (entries: Record<string, string>) => void) => {
  const envelope = parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!
  edit(envelope.entries)
  storage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify(envelope))
}
const envelopeRows = (storage: StorageApi) => Object.fromEntries(Object.entries(
  parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!.entries
).map(([key, value]) => [key, JSON.parse(value)]))
const privateKeys = new Set(["app-events", "app-event-heads", "app-event-checkpoints", "app-event-retirements"].map(id => `smithers-mvp.${id}`))

const sqliteStore = async (path: string, beforeCommit?: () => Promise<void>) => {
  const db = new Database(path)
  const adapter = await openSqliteRowStorage({
    execute: async <Row>(sql: string, params: ReadonlyArray<unknown> = []) => {
      if (/^\s*COMMIT\b/i.test(sql)) await beforeCommit?.()
      const statement = db.query(sql)
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<Row>
      statement.run(...params as []); return []
    }, close: () => db.close()
  }, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION })
  const store = await createAppStore({ kind: "opfs", ...adapter, storageEventApi: { addEventListener: () => {}, removeEventListener: () => {} } })
  return { store, db }
}

const installProjectorFixture = async (storage: StorageApi, version: number, retiredPresentation = false) => {
  const store = await open(storage)
  await store.dispatch({ type: "message.submitted", actor: "user", turnId: "kept", text: "Keep my work" }).isPersisted.promise
  await store.dispatch({ type: "message.response.completed", actor: "smithers", turnId: "kept" }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "user", card: {
    id: "kept", kind: "file", title: "kept.ts", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "org/repo", path: "kept.ts", content: "retained", truncated: false }
  } }).isPersisted.promise
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
    allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "world.document.upserted", actor: "user", document: {
    id: "kept", path: "kept.md", title: "Kept", body: "Retain wiki", links: [], tags: [], sources: [], confidence: 1
  } }).isPersisted.promise
  const builtIn = AGENT_ROLES[0]!
  const custom = { ...builtIn, id: "custom-reviewer", builtin: false, label: "Custom reviewer" }
  if (retiredPresentation) {
    await store.dispatch({ type: "card.upsert", actor: "user", card: {
      id: "kept-agents", kind: "agents", title: "Agents", status: "active", createdAt: 2, ordinal: 2,
      payload: { native: true, agents: [{ ...builtIn, harnessName: "Claude", available: true, reason: "", account: "" }] }
    } }).isPersisted.promise
    await store.dispatch({ type: "card.maximized", actor: "user", id: "kept" }).isPersisted.promise
  }
  await store.compactEvents()
  const history = await store.eventHistory()
  const snapshot = structuredClone(history.checkpoint.snapshot)
  Object.assign(snapshot.sessions![0]!, { guide: { version: 3, sequence: "practice-v4", step: 1,
    completed: [], autoPaused: false, conversationOpen: false }, guideVisible: false })
  const retireFixture = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(retireFixture)
    if (value === null || typeof value !== "object") return value
    const row = value as Record<string, unknown>
    if (row.kind === "file" && row.id === "kept") return { ...row, kind: "repo-home", payload: {
      repo: "org/repo", path: ".smithers/home.json", blocks: [{ type: "text", text: "Old home" }], featuredFlows: null
    } }
    if (row.kind === "agents") return { ...row, payload: { native: true, agents: [
      { ...builtIn, label: "Edited built-in", purpose: "Custom purpose", model: { provider: "custom", id: "custom-model", label: "Custom" },
        harnessName: "Claude", available: true, reason: "", account: "" },
      { ...custom, harnessName: "Claude", available: true, reason: "", account: "" }
    ] } }
    return Object.fromEntries(Object.entries(row).map(([key, field]) => [key, retireFixture(field)]))
  }
  if (retiredPresentation) {
    Object.assign(snapshot, retireFixture(snapshot))
    snapshot.agents = [{ ...builtIn, label: "Edited built-in" }, custom]
  }
  const stateHash = appProjectionHash(snapshot as unknown as Parameters<typeof appProjectionHash>[0])
  const head = { ...history.head, projectorVersion: version, stateHash }
  const eventBody = { formatVersion: 1, projectorVersion: version, id: "retired-guide-event", streamId: head.streamId,
    sequence: head.sequence + 1, revision: head.revision + 1, kind: "transition", type: "guide.visibility.changed",
    actor: "user", createdAt: 1, persistenceMode: "localStorage",
    input: encodeEventValue({ type: "guide.visibility.changed", actor: "user", visible: false }),
    previousEventHash: head.eventHash, previousStateHash: stateHash, stateHash }
  const event = { ...eventBody, hash: digest("smithers-app/event/v1:" + canonicalEventValue(eventBody)) }
  if (version === 1) Object.assign(head, { sequence: event.sequence, revision: event.revision, eventHash: event.hash })
  const { hash: _, ...body } = { ...history.checkpoint, projectorVersion: version, snapshot, stateHash }
  const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
  await store.dispose?.()
  opened.splice(opened.indexOf(store), 1)
  editEnvelope(storage, entries => {
    if (retiredPresentation) {
      entries["smithers-mvp.app-agents"] = JSON.stringify(Object.fromEntries(snapshot.agents!.map(row => {
        const agent = row as Record<string, unknown>
        return [`s:${agent.id}`, { versionKey: "fixture", data: agent }]
      })))
      for (const id of ["app-cards", "app-frames"]) {
        const key = `smithers-mvp.${id}`
        if (entries[key]) entries[key] = JSON.stringify(retireFixture(JSON.parse(entries[key]!)))
      }
    }
    if (version === 1) {
      entries["smithers-mvp.app-events"] = JSON.stringify({ "s:retired-guide-event": { versionKey: "fixture", data: event } })
      const sessions = JSON.parse(entries["smithers-mvp.app-sessions"]!)
      Object.assign(sessions["s:main"].data, { guide: (snapshot.sessions![0] as Record<string, unknown>).guide, guideVisible: false })
      entries["smithers-mvp.app-sessions"] = JSON.stringify(sessions)
    }
    for (const [id, data] of [["app-event-heads", head], ["app-event-checkpoints", checkpoint]] as const) {
      entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
    }
  })
  return history
}

describe("the live store's authoritative event path", () => {
  for (const stage of ["account", "poll", "ready", "done"] as const) for (const compact of stage === "account" ? [true, false] : [true])
    test(`a pre-v26 ${stage} signup with ${compact ? "compacted" : "live"} history retires once`, async () => {
    const storage = memoryStorage(), store = await open(storage)
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "new-owner",
      provider: "github", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "signup.changed", actor: "user", patch: {
      stage, name: "PRIVATE OLD NAME", account: "chosen-slug", question: 2,
      answers: { heard: "PRIVATE OLD ANSWER" }, repo: "private/repo",
      draft: { name: "PRIVATE OLD DRAFT", account: "chosen-slug" }
    } }).isPersisted.promise
    if (compact) await store.compactEvents()
    const old = await store.eventHistory()
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    const { hash: _, ...checkpointBody } = { ...old.checkpoint, projectorVersion: APP_PROJECTOR_VERSION - 1 }
    const checkpoint = { ...checkpointBody, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(checkpointBody)) }
    editEnvelope(storage, entries => {
      for (const [id, data] of [["app-event-heads", { ...old.head, projectorVersion: APP_PROJECTOR_VERSION - 1 }],
        ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    expect(JSON.stringify(envelopeRows(storage))).toContain("PRIVATE OLD")
    const upgraded = await open(storage)
    const expected: Signup = stage === "done" ? { stage: "done", question: 0, answers: {}, draft: {} }
      : { stage: "account", door: "github", account: "new-owner", question: 0, answers: {}, draft: { account: "new-owner" } }
    expect(upgraded.session().signup).toEqual(expected)
    expect((await upgraded.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect((await upgraded.eventHistory()).head.streamId).not.toBe(old.head.streamId)
    expect(JSON.stringify(envelopeRows(storage))).not.toContain("PRIVATE OLD")
    expect(JSON.stringify(envelopeRows(storage))).not.toContain("private/repo")
    expect((await upgraded.verifyState()).valid).toBe(true)
    await upgraded.dispose?.(); opened.splice(opened.indexOf(upgraded), 1)
    const reopened = await open(storage)
    expect(reopened.session().signup).toEqual(expected)
    expect((await reopened.verifyState()).valid).toBe(true)
  })

  test("current-version signup edits keep their chosen slug across same-owner reload", async () => {
    const storage = memoryStorage(), store = await open(storage)
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "new-owner",
      provider: "github", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "signup.changed", actor: "user", patch: { stage: "poll", name: "Chosen Name",
      account: "chosen-slug", answers: { size: "Just me" }, draft: { account: "chosen-slug" } } }).isPersisted.promise
    const saved = store.session().signup
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    const restored = await open(storage)
    expect(restored.session().signup).toEqual(saved)
    await restored.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "new-owner",
      provider: "github", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    expect(restored.session().signup).toEqual(saved)
    await restored.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other-owner",
      provider: "github", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    expect(restored.session().signup).toEqual({ stage: "account", door: "github", account: "other-owner",
      question: 0, answers: {}, draft: { account: "other-owner" } })
    expect((await restored.verifyState()).valid).toBe(true)
  })

  test("a signed-out legacy row has no account to claim its signup details", async () => {
    const storage = memoryStorage(), store = await open(storage)
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null,
      provider: "github", allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "signup.changed", actor: "user", patch: { stage: "poll", name: "PRIVATE NAME",
      account: "old-owner", answers: { size: "PRIVATE ANSWER" }, draft: { account: "old-owner" } } }).isPersisted.promise
    await store.compactEvents()
    const old = await store.eventHistory()
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: APP_PROJECTOR_VERSION - 1 }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    editEnvelope(storage, entries => {
      for (const [id, data] of [["app-event-heads", { ...old.head, projectorVersion: APP_PROJECTOR_VERSION - 1 }],
        ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    expect(JSON.stringify(envelopeRows(storage))).toContain("PRIVATE NAME")
    const upgraded = await open(storage)
    expect(upgraded.session().signup).toEqual({ stage: "sign-in", question: 0, answers: {}, draft: {} })
    expect(JSON.stringify(envelopeRows(storage))).not.toContain("PRIVATE")
    expect((await upgraded.verifyState()).valid).toBe(true)
  })

  test("a current stream purges an unscoped legacy signup edit after an interrupted prior boot", async () => {
    const storage = memoryStorage(), recovery = memoryStorage()
    const prior = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: recovery,
      matchMedia: () => ({ matches: false }) } })
    try {
      const store = await open(storage)
      await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "new-owner",
        provider: "github", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
      const saved = store.session().signup!
      expect(writeEntityRecovery(recovery, { key: "signup", revision: 1, value: { kind: "signup", signup: {
        ...saved, draft: { ...saved.draft, name: "PRIVATE STALE EDIT" }
      } } })).toBeDefined()
      await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
      expect(recovery.getItem(ENTITY_RECOVERY_STORAGE_KEY)).toContain("PRIVATE STALE EDIT")
      const restored = await open(storage)
      expect(restored.session().signup).toEqual(saved)
      expect(recovery.getItem(ENTITY_RECOVERY_STORAGE_KEY)).toBeNull()
      expect((await restored.verifyState()).valid).toBe(true)
    } finally {
      if (prior) Object.defineProperty(globalThis, "window", prior)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  for (const scoped of [true, false]) test(`a ${scoped ? "scoped" : "unscoped"} pending legacy signup edit cannot return from the retired stream`, async () => {
    const storage = memoryStorage(), recovery = memoryStorage()
    const prior = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: recovery,
      matchMedia: () => ({ matches: false }) } })
    try {
      const store = await open(storage)
      await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "new-owner",
        provider: "github", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
      await store.dispatch({ type: "signup.changed", actor: "user", patch: { stage: "account",
        name: "PRIVATE SUBMITTED", account: "chosen-slug", draft: { account: "chosen-slug" } } }).isPersisted.promise
      await store.compactEvents()
      if (scoped) expect(store.stagePendingSignupInput("name", "PRIVATE PENDING", "pending-edit")).toBeDefined()
      else expect(writeEntityRecovery(recovery, { key: "signup", revision: 1, value: { kind: "signup", signup: {
        ...store.session().signup!, draft: { ...store.session().signup!.draft, name: "PRIVATE PENDING" }
      } } })).toBeDefined()
      expect(readEntityRecoveries(recovery).some(row => row.value.kind === "signup" && row.value.signup.draft.name === "PRIVATE PENDING")).toBe(true)
      const old = await store.eventHistory()
      await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
      const { hash: _, ...checkpointBody } = { ...old.checkpoint, projectorVersion: APP_PROJECTOR_VERSION - 1 }
      const checkpoint = { ...checkpointBody, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(checkpointBody)) }
      editEnvelope(storage, entries => {
        for (const [id, data] of [["app-event-heads", { ...old.head, projectorVersion: APP_PROJECTOR_VERSION - 1 }],
          ["app-event-checkpoints", checkpoint]] as const) {
          entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
        }
      })
      expect(JSON.stringify(envelopeRows(storage))).toContain("PRIVATE SUBMITTED")
      expect(recovery.getItem(ENTITY_RECOVERY_STORAGE_KEY)).toContain("PRIVATE PENDING")
      const upgraded = await open(storage)
      expect(upgraded.session().signup).toEqual({ stage: "account", door: "github", account: "new-owner",
        question: 0, answers: {}, draft: { account: "new-owner" } })
      expect(readEntityRecoveries(recovery)).toEqual([])
      expect(recovery.getItem(ENTITY_RECOVERY_STORAGE_KEY)).toBeNull()
      expect(JSON.stringify(envelopeRows(storage))).not.toContain("PRIVATE")
      expect((await upgraded.verifyState()).valid).toBe(true)
    } finally {
      if (prior) Object.defineProperty(globalThis, "window", prior)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  test("version 6 upgrade retains setup policy and a later pending guide survives reopen", async () => {
    const storage = memoryStorage(), store = await open(storage)
    const payload = initialSetup("org/repo", "issues", "alice")
    payload.active = { revision: 1, digest: setupCandidate(payload), registrationId: "issues", sourceRevision: "source", enabled: false, owned: true }
    await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "setup", kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: 1, payload } }).isPersisted.promise
    await store.compactEvents()
    const old = await store.eventHistory()
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 6 }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      for (const [id, data] of [["app-event-heads", { ...old.head, projectorVersion: 6 }], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    const upgraded = await open(storage), card = upgraded.collections.cards.get("setup")!
    if (card.kind !== "repository-setup") throw Error("Missing setup")
    expect(card.payload).toEqual(payload)
    expect((await upgraded.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    const guidance = { id: "6405cbb6-c18f-452e-99db-adb1283ee18a", state: "requested" as const }
    await upgraded.dispatch({ type: "card.upsert", actor: "user", card: { ...card, payload: { ...card.payload, guidance } } }).isPersisted.promise
    await upgraded.dispose?.(); opened.splice(opened.indexOf(upgraded), 1)
    const reopened = await open(storage)
    expect(reopened.collections.cards.get("setup")).toMatchObject({ payload: { guidance, active: payload.active } })
    expect((await reopened.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect((await reopened.verifyState()).valid).toBe(true)
  })

  test("version 5 upgrade preserves a chore policy; its observed next execution survives reopen without granting evidence", async () => {
    const storage = memoryStorage(), store = await open(storage)
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    const payload = initialSetup("org/repo", "chores", "alice")
    payload.draft.schedule = "0 9 * * *"
    payload.active = { revision: 1, digest: setupCandidate(payload), registrationId: "chore", sourceRevision: "immutable-source", enabled: true, owned: true }
    payload.recovery = { id: "recover", baseRevision: 1, baseDigest: setupCandidate(payload), state: "completed", registrationState: "known" }
    await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "chore", kind: "repository-setup", title: "Automate a chore", status: "active", createdAt: 1, ordinal: 1, payload } }).isPersisted.promise
    await store.compactEvents()
    const old = await store.eventHistory()
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 5 }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      for (const [id, data] of [["app-event-heads", { ...old.head, projectorVersion: 5 }], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    const restored = await open(storage), card = restored.collections.cards.get("chore")!
    if (card.kind !== "repository-setup") throw Error("Chore was not retained")
    expect(card.payload).toEqual(payload)
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect((await restored.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    await restored.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...card.payload,
      active: { ...card.payload.active!, schedule: { expression: "0 9 * * *", nextFireAt: "2026-09-18T09:00:00Z" } }
    } } }).isPersisted.promise
    await restored.dispose?.(); opened.splice(opened.indexOf(restored), 1)
    const reopened = await open(storage), resumed = reopened.collections.cards.get("chore")!
    if (resumed.kind !== "repository-setup") throw Error("Chore was not retained")
    expect(resumed.payload.active?.schedule?.nextFireAt).toBe("2026-09-18T09:00:00Z")
    expect(resumed.payload.evaluation).toBeUndefined()
    expect(resumed.payload.trial).toBeUndefined()
    expect((await reopened.verifyState()).valid).toBe(true)
  })

  test("version 4 upgrade preserves setup cases and an unfinished receipt; recovery markers survive the next reopen", async () => {
    const storage = memoryStorage(), store = await open(storage)
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    const payload = initialSetup("org/repo", "issues", "alice")
    payload.draft.cases = [{ id: "retained-case", name: "Retained case", input: "An issue", expected: "A source-bound answer", required: true }]
    const candidate = setupCandidate(payload)
    payload.request = { id: "retained-request", operation: "evaluate", revision: 1, digest: candidate, state: "running" }
    payload.receipt = { requestId: "retained-request", operation: "evaluate", revision: 1, digest: candidate, runId: "retained-run", phase: "waiting", updatedAt: 1, results: [], evidence: ["run:retained-run"] }
    await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "setup", kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: 1, payload } }).isPersisted.promise
    await store.compactEvents()
    const old = await store.eventHistory()
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 4 }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      for (const [id, data] of [["app-event-heads", { ...old.head, projectorVersion: 4 }], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    const restored = await open(storage), card = restored.collections.cards.get("setup")!
    if (card.kind !== "repository-setup") throw Error("Setup was not retained")
    expect(card.payload).toEqual(payload)
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect((await restored.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    await restored.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...card.payload,
      request: { ...card.payload.request!, observeOnly: true }, recovery: { id: "recover", baseRevision: 1, baseDigest: candidate, state: "requested", registrationState: "unknown", adoptDraft: false }
    } } }).isPersisted.promise
    await restored.dispose?.(); opened.splice(opened.indexOf(restored), 1)
    const reopened = await open(storage), resumed = reopened.collections.cards.get("setup")!
    if (resumed.kind !== "repository-setup") throw Error("Setup was not retained")
    expect(resumed.payload.request?.observeOnly).toBe(true)
    expect(resumed.payload.recovery?.state).toBe("requested")
    expect(resumed.payload.receipt?.phase).toBe("waiting")
    expect(resumed.payload.trial).toBeUndefined()
    expect(resumed.payload.evaluation).toBeUndefined()
    expect((await reopened.verifyState()).valid).toBe(true)
  })

  test("version 7 upgrade decodes a chore draft stored before the chore event existed", async () => {
    const storage = memoryStorage(), store = await open(storage)
    const payload = initialSetup("org/repo", "chores", "alice")
    payload.draft.schedule = "0 9 * * *"
    payload.draft.steps = payload.draft.steps.map(step => ({ ...step, mode: "approved" as const }))
    payload.draft.cases = [{ id: "retained-chore", name: "Retained chore", input: "A weekly tidy", expected: "A scoped maintenance change", required: true }]
    // The digest the pre-stack code at 1f7d9b40bcc5 wrote into this card, not one this build recomputes.
    const digestBeforeChoreEvents = "4ae1937060bb181a4d1e1a910fab2b986e4139b8513c296f4c7279fd532686bd"
    const evidence = (operation: "evaluate" | "trial") => ({ requestId: `${operation}-request`, runId: `${operation}-run`,
      revision: 1, operation, phase: "completed" as const, digest: digestBeforeChoreEvents, updatedAt: 1,
      results: [{ caseId: "retained-chore", status: "passed" as const, observed: "A scoped maintenance change", evidence: ["execution:retained-chore"], executionId: "retained-chore" }],
      evidence: [`run:${operation}-run`], sourceRevision: "immutable-source" })
    payload.evaluation = evidence("evaluate")
    payload.trial = evidence("trial")
    payload.active = { revision: 1, digest: digestBeforeChoreEvents, registrationId: "chore", sourceRevision: "immutable-source", enabled: true, owned: true }
    await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "chore", kind: "repository-setup", title: "Automate a chore", status: "active", createdAt: 1, ordinal: 1, payload } }).isPersisted.promise
    await store.compactEvents()
    const old = await store.eventHistory()
    const withoutChoreEvent = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(withoutChoreEvent)
      if (value === null || typeof value !== "object") return value
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "choreEvent").map(([key, field]) => [key, withoutChoreEvent(field)]))
    }
    const snapshot = withoutChoreEvent(structuredClone(old.checkpoint.snapshot)) as typeof old.checkpoint.snapshot
    const stateHash = appProjectionHash(snapshot as unknown as Parameters<typeof appProjectionHash>[0])
    const head = { ...old.head, projectorVersion: 7, stateHash }
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 7, snapshot, stateHash }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      entries["smithers-mvp.app-cards"] = JSON.stringify(withoutChoreEvent(JSON.parse(entries["smithers-mvp.app-cards"]!)))
      for (const [id, data] of [["app-event-heads", head], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    const restored = await open(storage), card = restored.collections.cards.get("chore")!
    if (card.kind !== "repository-setup") throw Error("Chore was not retained")
    expect(card.payload.draft.choreEvent).toBe("none")
    expect(card.payload).toEqual(payload)
    expect(storedSetupCandidate(card.payload, card.payload.active!.digest)).toBe(true)
    expect(setupCandidate(card.payload)).not.toBe(card.payload.active!.digest)
    // The registration still names this draft. Its proof does not: a receipt
    // carries the digest it was issued at, so the card re-proves this candidate.
    expect(setupActivationProblems(card.payload)).toEqual(["Run evals for this draft.", "Complete the live trial for this draft."])
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect((await restored.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect((await restored.verifyState()).valid).toBe(true)
  })

  test("version 8 upgrade drops the retired sidebar state", async () => {
    const storage = memoryStorage(), store = await open(storage)
    await store.compactEvents()
    const old = await store.eventHistory()
    const snapshot = structuredClone(old.checkpoint.snapshot)
    Object.assign(snapshot.sessions![0]!, { sidebarOpen: false })
    const stateHash = appProjectionHash(snapshot as unknown as Parameters<typeof appProjectionHash>[0])
    const head = { ...old.head, projectorVersion: 8, stateHash }
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 8, snapshot, stateHash }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      const sessions = JSON.parse(entries["smithers-mvp.app-sessions"]!)
      sessions["s:main"].data.sidebarOpen = false
      entries["smithers-mvp.app-sessions"] = JSON.stringify(sessions)
      for (const [id, data] of [["app-event-heads", head], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    const restored = await open(storage)
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect((await restored.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect((await restored.verifyState()).valid).toBe(true)
    expect(restored.session()).not.toHaveProperty("sidebarOpen")
  })

  test("version 21 upgrade drops retired Librarian launch intents", async () => {
    const storage = memoryStorage(), store = await open(storage)
    await store.compactEvents()
    const old = await store.eventHistory()
    const launches = [{ kind: "history", repo: "owner/repo", scope: "old", phase: "started", startedAt: 1, runId: "run-1" }]
    const snapshot = structuredClone(old.checkpoint.snapshot)
    Object.assign(snapshot.sessions![0]!, { librarianLaunches: launches })
    const stateHash = appProjectionHash(snapshot as unknown as Parameters<typeof appProjectionHash>[0])
    const head = { ...old.head, projectorVersion: 21, stateHash }
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 21, snapshot, stateHash }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      const sessions = JSON.parse(entries["smithers-mvp.app-sessions"]!)
      sessions["s:main"].data.librarianLaunches = launches
      entries["smithers-mvp.app-sessions"] = JSON.stringify(sessions)
      for (const [id, data] of [["app-event-heads", head], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    const restored = await open(storage)
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect((await restored.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect((await restored.verifyState()).valid).toBe(true)
    expect(restored.session()).not.toHaveProperty("librarianLaunches")
  })

  test("version 9 upgrade rotates a store whose journal holds a front-door turn", async () => {
    /*
     * A front-door leg (apps/server frontDoor.ts) now projects differently:
     * the minted call id marks the turn as worked (`receivedText`) and its
     * act row as the turn's answer. Version 9 wrote those same events the
     * other way, so replaying them under this build would mismatch the saved
     * state hash and refuse the boot. The version moves instead, and the
     * rotation re-seeds from the rows already on disk.
     */
    const storage = memoryStorage(), store = await open(storage)
    const token = "b".repeat(64)
    await store.dispatch({ type: "http.turn.started", actor: "user", attemptId: "attempt", turnId: "turn", text: "show me my runs", retry: false,
      journal: { version: 1, legId: "leg", token } }).isPersisted.promise
    await store.dispatch({ type: "message.tool.executed", actor: "smithers", turnId: "turn", text: "Smithers ran /runs.list", answersTurn: true }).isPersisted.promise
    await store.compactEvents()
    const old = await store.eventHistory()
    const snapshot = structuredClone(old.checkpoint.snapshot)
    // What version 9 wrote for that leg: a worked turn read as an empty one.
    Object.assign(snapshot.httpTurns![0]!, { receivedText: false })
    const stateHash = appProjectionHash(snapshot as unknown as Parameters<typeof appProjectionHash>[0])
    const head = { ...old.head, projectorVersion: 9, stateHash }
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 9, snapshot, stateHash }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      for (const [id, data] of [["app-event-heads", head], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    const restored = await open(storage)
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect((await restored.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect((await restored.verifyState()).valid).toBe(true)
    // The routed turn's one line survives the rotation, answer mark and all.
    const act = [...restored.collections.messages.values()].find(message => message.act !== undefined)
    expect(act).toMatchObject({ text: "Smithers ran /runs.list", answersTurn: true })
  })

  test("version 10 upgrade rotates a checkpoint written before models and seats existed", async () => {
    /*
     * Version 10 checkpointed 42 collections. This build names 44, and a
     * snapshot whose roster differs is refused outright, so the version moves
     * and the rotation re-seeds from the rows on disk. Nothing is seeded into
     * the two new collections.
     */
    const storage = memoryStorage(), store = await open(storage)
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "kept" }).isPersisted.promise
    await store.compactEvents()
    const old = await store.eventHistory()
    const { models: _models, seats: _seats, ...snapshot } = structuredClone(old.checkpoint.snapshot)
    const head = { ...old.head, projectorVersion: 10 }
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 10, snapshot }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      for (const [id, data] of [["app-event-heads", head], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    const restored = await open(storage)
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect((await restored.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect((await restored.verifyState()).valid).toBe(true)
    expect(restored.session().draft).toBe("kept")
    expect([restored.collections.models.size, restored.collections.seats.size]).toEqual([0, 0])
    await restored.dispatch({ type: "model.saved", actor: "user", model: { id: "mine", protocol: "anthropic-messages", modelId: "claude-fable-5", credential: "ANTHROPIC_API_KEY" } }).isPersisted.promise
    expect((await restored.verifyState()).valid).toBe(true)
  })

  test("version 15 chain projections retire while account data stays readable", async () => {
    const storage = memoryStorage()
    await installProjectorFixture(storage, 15)
    editEnvelope(storage, entries => {
      const checkpointRows = JSON.parse(entries["smithers-mvp.app-event-checkpoints"]!)
      const checkpoint = checkpointRows["s:current"].data
      checkpoint.snapshot.chainEvents = []
      checkpoint.snapshot.retiredChainLineages = []
      const { hash: _, ...body } = checkpoint
      checkpoint.hash = digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body))
      entries["smithers-mvp.app-event-checkpoints"] = JSON.stringify(checkpointRows)
    })
    const restored = await open(storage)
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect((await restored.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect(restored.collections.cards.get("kept")?.title).toBe("kept.ts")
    expect(restored.collections.identitySessions.get("identity")?.login).toBe("alice")
    expect((await restored.verifyState()).valid).toBe(true)
    expect(Object.keys(restored.collections)).not.toContain("chainEvents")
    expect(Object.keys(restored.collections)).not.toContain("retiredChainLineages")
  })

  test("version 16 upgrade rotates a stream whose journal holds a retired email signup", async () => {
    /*
     * Version 16 accepted the email door: a signup.changed at the verify stage
     * with door "email". This build's SignupSchema refuses both, so replaying
     * that event would fail validation and lock the app out. The version moves
     * instead, and the rotation re-seeds; the session row that holds the
     * retired signup no longer parses, so the session starts fresh. No host
     * ever answered those doors, so no saved stream reached this state.
     */
    const storage = memoryStorage(), store = await open(storage)
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "kept" }).isPersisted.promise
    await store.compactEvents()
    const old = await store.eventHistory()
    const head = { ...old.head, projectorVersion: 16 }
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 16 }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    const patch = { stage: "verify", door: "email", email: "ada@acme.dev" }
    const transition = { type: "signup.changed", actor: "user", patch }
    // Version 16's SignupSchema key order, which the state hash reads.
    const signup = { ...patch, question: 0, answers: {}, draft: {} }
    // What version 16's projector made of that event; this build's schema refuses to project it.
    const after = structuredClone(old.checkpoint.snapshot)
    after.sessions![0] = { signup, ...after.sessions![0] as object, revision: head.revision + 1 } as never
    after.transitions!.push({ id: `transition-${head.revision + 1}`, revision: head.revision + 1, actor: "user", type: transition.type,
      payload: JSON.stringify({ patch }), createdAt: 1 })
    const stateHash = appProjectionHash(after as unknown as Parameters<typeof appProjectionHash>[0])
    const eventBody = { formatVersion: 1, projectorVersion: 16, id: "retired-email-signup", streamId: head.streamId,
      sequence: head.sequence + 1, revision: head.revision + 1, kind: "transition", type: transition.type,
      actor: "user", createdAt: 1, persistenceMode: "localStorage", input: encodeEventValue(transition),
      previousEventHash: head.eventHash, previousStateHash: head.stateHash, stateHash }
    const event = { ...eventBody, hash: digest("smithers-app/event/v1:" + canonicalEventValue(eventBody)) }
    Object.assign(head, { sequence: event.sequence, revision: event.revision, eventHash: event.hash, stateHash })
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      const sessions = JSON.parse(entries["smithers-mvp.app-sessions"]!)
      Object.assign(sessions["s:main"].data, { signup })
      entries["smithers-mvp.app-sessions"] = JSON.stringify(sessions)
      entries["smithers-mvp.app-events"] = JSON.stringify({ "s:retired-email-signup": { versionKey: "fixture", data: event } })
      for (const [id, data] of [["app-event-heads", head], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    const restored = await open(storage)
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect((await restored.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect((await restored.verifyState()).valid).toBe(true)
    expect(restored.session().signup?.stage ?? "sign-in").toBe("sign-in")
    await restored.dispatch({ type: "signup.changed", actor: "user", patch: { stage: "account", door: "github" } }).isPersisted.promise
    expect((await restored.verifyState()).valid).toBe(true)
  })

  test("the collection roster is pinned to the projector version", () => {
    /*
     * A checkpoint naming another roster is refused at boot, so a collection
     * added or removed without moving the version locks every saved stream
     * out. Changing this list owes a bump and an upgrade test like the ones
     * below.
     */
    expect({ version: APP_PROJECTOR_VERSION, roster: [...APP_PROJECTION_COLLECTION_NAMES].sort() }).toEqual({ version: 26, roster: [
      "agents", "approvalRequests", "billingAccounts", "branches", "cardHistories", "cards", "changes",
      "cloudSessions", "cloudWorkspaces", "commandIntents", "connectorOperations", "connectors", "flowDurations", "frames",
      "githubAppStatuses", "httpTurnLegs", "httpTurns", "identitySessions", "messages", "models",
      "notificationReceipts", "recommendations", "repoTree", "repositories",
      "repositoryContexts", "repositoryFlows", "repositoryJobObservations", "repositoryNotifications", "runtimeApprovals",
      "runtimeRuns", "seats", "sessions", "starredTargets", "tabs", "toasts", "toolCalls", "transitions", "workingCopies",
      "workspaces", "worldDocuments"
    ] })
  })

  test("version 19 upgrade drops a saved toast whose action names a renamed workspace.* flow", async () => {
    const storage = memoryStorage(), store = await open(storage)
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "kept" }).isPersisted.promise
    await store.compactEvents()
    const old = await store.eventHistory()
    const toast = { id: "toast-desktop", key: "box.desktop.open:ws-1", title: "Starting the desktop box", status: "running",
      detail: "", action: { flow: "workspace.view", args: "ws-1", label: "Open details" }, createdAt: 1, updatedAt: 1 }
    const snapshot = { ...structuredClone(old.checkpoint.snapshot), toasts: [...old.checkpoint.snapshot.toasts!, toast] }
    const head = { ...old.head, projectorVersion: 19 }
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 19, snapshot }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      for (const [id, data] of [["app-event-heads", head], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
      const toasts = JSON.parse(entries["smithers-mvp.app-toasts"] ?? "{}")
      toasts["s:toast-desktop"] = { versionKey: "fixture", data: toast }
      entries["smithers-mvp.app-toasts"] = JSON.stringify(toasts)
    })
    const restored = await open(storage)
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect((await restored.verifyState()).valid).toBe(true)
    expect(restored.session().draft).toBe("kept")
    expect(restored.collections.toasts.has("toast-desktop")).toBe(false)
  })

  test("version 18 upgrade retires the untouched World starter note and keeps a person's notes", async () => {
    const storage = memoryStorage(), store = await open(storage)
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "kept" }).isPersisted.promise
    await store.dispatch({ type: "world.document.upserted", actor: "user", select: false, document: {
      id: "plans", path: "Plans.md", title: "Plans", body: "# Plans", links: [], tags: [], sources: [], confidence: 1
    } }).isPersisted.promise
    await store.compactEvents()
    const old = await store.eventHistory()
    const stub = { id: "world-home", path: "World.md", title: "World", body: "# World\n\n", links: [], tags: [],
      sources: ["system:bootstrap"], confidence: 1, updatedAt: 1, updatedBy: "system", revision: 0 }
    const snapshot = { ...structuredClone(old.checkpoint.snapshot), worldDocuments: [...old.checkpoint.snapshot.worldDocuments!, stub] }
    const head = { ...old.head, projectorVersion: 18 }
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 18, snapshot }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      for (const [id, data] of [["app-event-heads", head], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
      const notes = JSON.parse(entries["smithers-mvp.world-documents"]!)
      notes["s:world-home"] = { versionKey: "fixture", data: stub }
      entries["smithers-mvp.world-documents"] = JSON.stringify(notes)
    })
    const restored = await open(storage)
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect((await restored.verifyState()).valid).toBe(true)
    expect(restored.session().draft).toBe("kept")
    expect([...restored.collections.worldDocuments.keys()]).toEqual(["plans"])
  })

  test("version 12 upgrade preserves a signed-in stream recorded before identity advanced signup", async () => {
    /*
     * Version 12 originally projected identity without changing signup. The
     * later signup projection reused version 12, so replaying a saved identity
     * event produced a different state hash and refused the whole profile.
     */
    const storage = memoryStorage(), store = await open(storage)
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "kept" }).isPersisted.promise
    await store.compactEvents()
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
      allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    const old = await store.eventHistory()
    const current = replayAppEvents(old.checkpoint, old.events, old.head).snapshot
    const legacy = structuredClone(current)
    delete (legacy.sessions[0] as Record<string, unknown>).signup
    const legacyStateHash = appProjectionHash(legacy)
    const sourceEvent = old.events.at(-1)!
    const { hash: _eventHash, ...eventBody } = { ...sourceEvent, projectorVersion: 12, stateHash: legacyStateHash }
    const event = { ...eventBody, hash: digest("smithers-app/event/v1:" + canonicalEventValue(eventBody)) }
    const head = { ...old.head, projectorVersion: 12, stateHash: legacyStateHash, eventHash: event.hash }
    const { hash: _checkpointHash, ...checkpointBody } = { ...old.checkpoint, projectorVersion: 12 }
    const checkpoint = { ...checkpointBody, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(checkpointBody)) }
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      for (const [id, data] of [["app-event-heads", head], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
      entries["smithers-mvp.app-events"] = JSON.stringify({ [`s:${event.id}`]: { versionKey: "fixture", data: event } })
      const sessions = JSON.parse(entries["smithers-mvp.app-sessions"]!)
      delete sessions["s:main"].data.signup
      entries["smithers-mvp.app-sessions"] = JSON.stringify(sessions)
    })
    const restored = await open(storage)
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect((await restored.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect((await restored.verifyState()).valid).toBe(true)
    expect(restored.session().draft).toBe("kept")
  })

  test("version 24 checkpoint upgrades without job observations and preserves the conversation and setup draft", async () => {
    const storage = memoryStorage(), store = await open(storage)
    const setup = initialSetup("org/repo", "issues", "maintainer")
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "Keep this conversation" }).isPersisted.promise
    await store.dispatch({ type: "card.upsert", actor: "user", card: {
      id: "kept-setup", kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: 1, payload: setup
    } }).isPersisted.promise
    await store.compactEvents()
    const old = await store.eventHistory()
    const { repositoryJobObservations: _observations, ...snapshot } = structuredClone(old.checkpoint.snapshot)
    // Version 24 hashes its 39-table roster, with no observation table.
    const normalized = Object.fromEntries(APP_PROJECTION_COLLECTION_NAMES.filter(name => name !== "repositoryJobObservations").sort().map(name => [name,
      snapshot[name].map(row => [appProjectionKey(name, row), JSON.parse(JSON.stringify(row))] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    ]))
    const stateHash = digest("smithers-app/projection/v1:" + canonicalEventValue(normalized))
    const head = { ...old.head, projectorVersion: 24, stateHash }
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 24, snapshot, stateHash }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      for (const [id, data] of [["app-event-heads", head], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    const restored = await open(storage)
    const history = await restored.eventHistory()
    expect(history.checkpoint.reason).toBe("projector-upgrade")
    expect(history.head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect(history.head.streamId).not.toBe(old.head.streamId)
    expect(restored.session().draft).toBe("Keep this conversation")
    expect(restored.collections.cards.get("kept-setup")).toMatchObject({ payload: setup })
    expect(restored.collections.repositoryJobObservations.size).toBe(0)
    expect((await restored.verifyState()).valid).toBe(true)
    await restored.dispatch({ type: "composer.changed", actor: "user", draft: "Still usable" }).isPersisted.promise
    await restored.dispose?.(); opened.splice(opened.indexOf(restored), 1)
    const again = await open(storage)
    expect(again.session().draft).toBe("Still usable")
    expect(again.collections.cards.get("kept-setup")).toMatchObject({ payload: setup })
    expect((await again.verifyState()).valid).toBe(true)
  })

  test("version 11 upgrade rotates a checkpoint written before flow durations existed", async () => {
    /*
     * Version 11 checkpointed 44 collections. The flow builder added
     * `flowDurations` without moving the version, so every saved version 11
     * stream was refused at boot (projection). The version moves and the
     * rotation re-seeds from the rows on disk.
     */
    const storage = memoryStorage(), store = await open(storage)
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "kept" }).isPersisted.promise
    await store.compactEvents()
    const old = await store.eventHistory()
    const { flowDurations: _flowDurations, ...snapshot } = structuredClone(old.checkpoint.snapshot)
    const head = { ...old.head, projectorVersion: 11 }
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 11, snapshot }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      for (const [id, data] of [["app-event-heads", head], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    const restored = await open(storage)
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect((await restored.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect((await restored.verifyState()).valid).toBe(true)
    expect(restored.session().draft).toBe("kept")
    expect(restored.collections.flowDurations.size).toBe(0)
  })

  test("version 3 upgrade preserves a deferred repository command and its route receipt", async () => {
    const storage = memoryStorage()
    const store = await open(storage)
    await store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "saved-url", repo: "alpha/one", phase: "pending" } }).isPersisted.promise
    await store.dispatch({ type: "command.deferred", actor: "user", name: "files.list", args: JSON.stringify({ path: "docs", repo: "alpha/one" }), requirement: "repository-ready" }).isPersisted.promise
    await store.dispatch({ type: "card.upsert", actor: "user", card: {
      id: "kept", kind: "file", title: "kept.ts", status: "active", createdAt: 1, ordinal: 1,
      payload: { repo: "alpha/one", path: "kept.ts", content: "retained", truncated: false }
    } }).isPersisted.promise
    await store.compactEvents()
    const old = await store.eventHistory()
    const pending = structuredClone(store.session().pendingCommand)
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 3 }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.()
    opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      for (const [id, data] of [["app-event-heads", { ...old.head, projectorVersion: 3 }], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    const restored = await open(storage)
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect(restored.session().repositoryEntry).toEqual({ requestId: "saved-url", repo: "alpha/one", phase: "pending" })
    expect(restored.session().pendingCommand).toEqual(pending)
    expect(restored.session().repositoryCommandEntry).toBeUndefined()
    expect(restored.collections.cards.get("kept")?.payload).toEqual({ repo: "alpha/one", path: "kept.ts", content: "retained", truncated: false })
    expect((await restored.verifyState()).valid).toBe(true)
    const reopened = await open(storage)
    expect(reopened.session().pendingCommand).toEqual(pending)
    expect((await reopened.verifyState()).valid).toBe(true)
  })

  test("version 2 cards retire across reopening while historical frames and conversations survive", async () => {
    const storage = memoryStorage()
    const old = await installProjectorFixture(storage, 2, true)
    const restored = await open(storage)
    const history = await restored.eventHistory()
    expect(history.checkpoint.reason).toBe("projector-upgrade")
    expect(history.head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect(history.head.streamId).not.toBe(old.head.streamId)
    expect(restored.collections.cards.get("kept")).toMatchObject({ id: "kept", kind: "retired", payload: {}, title: "" })
    const branch = restored.session().activeBranchId!
    const frame = restored.collections.frames.get(cardFrameId(branch, "kept"))!
    expect(frame.id).toBe(cardFrameId(branch, "kept"))
    expect(frame.snapshot?.cards.find(card => card.id === "kept")).toMatchObject({ kind: "retired", payload: {} })
    expect(restored.collections.messages.get("message-kept-user")?.text).toBe("Keep my work")
    expect([...restored.collections.agents.keys()].sort()).toEqual(AGENT_ROLES.map(role => role.id).sort())
    for (const role of AGENT_ROLES) expect(restored.collections.agents.get(role.id)).toMatchObject(role)
    const agentsCard = restored.collections.cards.get("kept-agents")!
    expect(agentsCard.kind).toBe("agents")
    if (agentsCard.kind !== "agents" || !("agents" in agentsCard.payload)) throw new Error("Missing built-in roster")
    // A built-in row reads its facts back from the table; a configured profile the table does not know keeps its own
    // (smithers-ui-DESIGN.md §3.3: Will's roles and hired specialists are configured profiles, not built-ins).
    expect(agentsCard.payload.agents).toHaveLength(2)
    expect(agentsCard.payload.agents[0]).toMatchObject({ id: AGENT_ROLES[0]!.id, label: AGENT_ROLES[0]!.label, model: AGENT_ROLES[0]!.model })
    expect(agentsCard.payload.agents[1]).toMatchObject({ id: "custom-reviewer", builtin: false })
    expect(frame.snapshot?.cards.find(card => card.id === "kept-agents")).toMatchObject({ kind: "agents", payload: agentsCard.payload })
    expect((await restored.verifyState()).valid).toBe(true)
    const reopened = await open(storage)
    expect(reopened.collections.frames.get(frame.id)).toEqual(frame)
    expect(reopened.collections.cards.get("kept")?.kind).toBe("retired")
    expect(reopened.collections.agents.has("custom-reviewer")).toBe(false)
    expect(reopened.collections.cards.get("kept-agents")).toEqual(agentsCard)
    expect((await reopened.verifyState()).valid).toBe(true)
  })

  test("rotates retired guide checkpoints without losing materialized rows", async () => {
    const storage = memoryStorage()
    const old = await installProjectorFixture(storage, 1)
    const restored = await open(storage)
    const next = await restored.eventHistory()
    expect(next.head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect(next.checkpoint.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect(next.checkpoint.reason).toBe("projector-upgrade")
    expect(next.head.streamId).not.toBe(old.head.streamId)
    expect(next.events).toHaveLength(0)
    expect(storage.getItem(ENVELOPE_STORAGE_KEY)).toContain(retiredAppStreamKey(old.head.streamId))
    expect(restored.session()).not.toHaveProperty("guide")
    expect(restored.session()).not.toHaveProperty("guideVisible")
    expect(next.checkpoint.snapshot.workingCopies).toEqual([])
    for (const name of ["sessions", "cards", "messages", "worldDocuments", "identitySessions"]) {
      expect(next.checkpoint.snapshot[name]!.length).toBeGreaterThan(0)
    }
    expect((await restored.verifyState()).valid).toBe(true)
    const reopened = await open(storage)
    expect((await reopened.eventHistory()).head.streamId).toBe(next.head.streamId)
  })

  for (const phase of ["complete", "pending"] as const) test(`upgrade resumes a failed ${phase} privacy marker update`, async () => {
    const bytes = new Map<string, string>()
    const inner = { get length() { return bytes.size }, key: (index: number) => [...bytes.keys()][index] ?? null,
      getItem: (key: string) => bytes.get(key) ?? null, setItem: (key: string, value: string) => { bytes.set(key, value) },
      removeItem: (key: string) => { bytes.delete(key) } }
    const old = await installProjectorFixture(inner, 1)
    inner.setItem(PRIVACY_RETIREMENT_KEY, JSON.stringify({ version: 2, id: "previous-signout", mode: "account",
      backend: "localStorage", targetStreamId: old.head.streamId, phase, erasures: [] }))
    let failMarker = true
    const storage = { ...inner, get length() { return inner.length }, setItem: (key: string, value: string) => {
      if (failMarker && key === PRIVACY_RETIREMENT_KEY) throw new Error("marker unavailable")
      inner.setItem(key, value)
    } }
    const boot = () => createAppStore({ backend: { kind: "localStorage", storage }, mode: "localStorage", degraded: false,
      privacy: { record: storage, eraseInactiveDatabase: async () => {} } })
    await expect(boot()).rejects.toThrow("marker unavailable")
    failMarker = false
    const restored = await boot(); opened.push(restored)
    expect(readPrivacyRetirement(storage)?.targetStreamId).toBe((await restored.eventHistory()).head.streamId)
    expect(restored.collections.messages.get("message-kept-user")?.text).toBe("Keep my work")
    const reopened = await boot(); opened.push(reopened)
    expect((await reopened.verifyState()).valid).toBe(true)
  })

  test("newer projectors refuse boot and preserve history", async () => {
    const storage = memoryStorage()
    await installProjectorFixture(storage, APP_PROJECTOR_VERSION + 1)
    const before = storage.getItem(ENVELOPE_STORAGE_KEY)
    await expect(open(storage)).rejects.toEqual(new AppProjectorVersionError(APP_PROJECTOR_VERSION + 1))
    expect(storage.getItem(ENVELOPE_STORAGE_KEY)).toBe(before)
  })

  test("row shape changes without a projector bump still fail checkpoint verification", async () => {
    const storage = memoryStorage()
    await installProjectorFixture(storage, APP_PROJECTOR_VERSION)
    const before = envelopeRows(storage)
    await expect(open(storage)).rejects.toEqual(new AppEventIntegrityError("checkpoint"))
    expect(envelopeRows(storage)).toEqual(before)
  })

  test("a dispatcher row persisted before slug joined it replays on this projector, unchanged and unupgraded", async () => {
    const storage = memoryStorage()
    const before = await open(storage)
    const triggers = [{ id: "trg-1", flowId: "review", cron: "0 * * * *", timezone: "UTC", enabled: true }]
    await before.dispatch({ type: "card.upsert", actor: "system", card: {
      id: "trigger-list", kind: "trigger-list", title: "Dispatcher", status: "active", createdAt: 1, ordinal: 1,
      payload: { repo: "alpha/one", live: true, triggers }
    } }).isPersisted.promise
    const written = await before.eventHistory()
    expect((await before.verifyState()).valid).toBe(true)
    await before.dispose?.()
    opened.splice(opened.indexOf(before), 1)
    const restored = await open(storage)
    const replayed = await restored.eventHistory()
    expect(replayed.checkpoint.reason).not.toBe("projector-upgrade")
    expect(replayed.head.streamId).toBe(written.head.streamId)
    expect(replayed.head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect((await restored.verifyState()).valid).toBe(true)
    const card = restored.collections.cards.get("trigger-list")!
    if (card.kind !== "trigger-list") throw new Error("Missing dispatcher card")
    expect(card.payload.triggers).toEqual(triggers)
    expect(card.payload.triggers[0]).not.toHaveProperty("slug")
  })

  test("a failed upgrade commit preserves the old authority for retry", async () => {
    const inner = memoryStorage()
    await installProjectorFixture(inner, 1)
    const before = inner.getItem(ENVELOPE_STORAGE_KEY)
    let writes = 0
    const storage: StorageApi = { ...inner, setItem: (key, value) => {
      if (key === ENVELOPE_STORAGE_KEY && ++writes === 2) throw new Error("disk full")
      inner.setItem(key, value)
    } }
    await expect(open(storage)).rejects.toThrow("disk full")
    const prior = parseStorageEnvelope(before!)!.entries
    const retained = parseStorageEnvelope(inner.getItem(ENVELOPE_STORAGE_KEY)!)!.entries
    for (const key of privateKeys) expect(JSON.parse(retained[key] ?? "null")).toEqual(JSON.parse(prior[key] ?? "null"))
    expect((await (await open(inner)).eventHistory()).checkpoint.reason).toBe("projector-upgrade")
  })

  test("billing plan observations replay and erase with their account owner", async () => {
    const storage = memoryStorage()
    const first = await open(storage)
    await first.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
      allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    const sandbox = { concurrentSandboxes: 2, concurrentInUse: 1, idleTimeoutSecs: 60, hoursPerDay: 3,
      secondsUsedToday: 120, dayResetsAt: "2026-09-16T00:00:00Z" }
    const plans = [{ key: "pro" as const, display_name: "Observed plan", price_cents: 1234, interval: "month",
      limits: { concurrent_sandboxes: 2, idle_timeout_secs: 60, hours_per_day: 3, private_repos: 1,
        storage_bytes: 100, ci_minutes: 2, agent_runs: 3, seats: 1 }, checkout_available: true }]
    await first.dispatch({ type: "billing.plans.loaded", actor: "user", planKey: "pro", sandbox, plans }).isPersisted.promise
    const history = await first.eventHistory()
    expect(replayAppEvents(history.checkpoint, history.events, history.head).snapshot.billingAccounts[0]).toMatchObject({ planKey: "pro", sandbox, plans })
    const restored = await open(storage)
    expect(restored.collections.billingAccounts.get("billing")).toMatchObject({ planKey: "pro", sandbox, plans })
    expect((await restored.verifyState()).valid).toBe(true)
    await restored.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    expect(restored.collections.billingAccounts.get("billing")).toMatchObject({ planKey: null, sandbox: null, plans: [] })
    expect(storage.getItem(ENVELOPE_STORAGE_KEY)).not.toContain("Observed plan")
    expect((await restored.verifyState()).valid).toBe(true)
  })

  test("diagnostic elision preserves full Unicode facts and replayed content", async () => {
    const storage = memoryStorage()
    const first = await open(storage)
    const content = "日本語🙂".repeat(500)
    const transition = { type: "card.upsert", actor: "user", card: {
      id: "large-file", kind: "file", title: "source.ts", status: "active", createdAt: 1, ordinal: 3,
      payload: { repo: "org/repo", path: "source.ts", content, truncated: false }
    } } as const
    await first.dispatch(transition).isPersisted.promise
    const history = await first.eventHistory()
    expect(decodeEventValue(history.events[0]!.input)).toEqual(transition)
    const diagnostic = [...first.collections.transitions.values()].at(-1)!
    expect(new TextEncoder().encode(diagnostic.payload).byteLength).toBeLessThanOrEqual(MAX_TRANSITION_PAYLOAD_BYTES)
    expect(diagnostic.payload).not.toContain(content)
    expect(first.collections.cards.get("large-file")?.payload).toHaveProperty("content", content)
    const restored = await open(storage)
    expect(restored.collections.cards.get("large-file")?.payload).toHaveProperty("content", content)
    expect(replayAppEvents(history.checkpoint, history.events, history.head).snapshot.cards[0]?.payload).toHaveProperty("content", content)
    expect((await restored.verifyState()).valid).toBe(true)
  })

  test("accepted facts rebuild erased projections and retain draft clears through actual reload", async () => {
    const storage = memoryStorage()
    const first = await open(storage)
    await first.dispatch({ type: "message.submitted", actor: "user", turnId: "t", text: "Keep the original question" }).isPersisted.promise
    await first.dispatch({ type: "message.response.delta", actor: "smithers", turnId: "t", channel: "text", delta: "An answer" }).isPersisted.promise
    await first.dispatch({ type: "message.response.completed", actor: "smithers", turnId: "t" }).isPersisted.promise
    await first.dispatch({ type: "card.upsert", actor: "user", card: {
      id: "file", kind: "file", title: "source.ts", status: "active", createdAt: 1, ordinal: 3,
      payload: { repo: "org/repo", path: "source.ts", content: "export {}", truncated: false, line: 7 }
    } }).isPersisted.promise
    await first.dispatch({ type: "card.updated", actor: "user", id: "file", patch: { payload: { line: undefined } } }).isPersisted.promise
    const before = await first.eventHistory()
    expect((await first.verifyState()).valid).toBe(true)
    editEnvelope(storage, entries => {
      for (const key of Object.keys(entries)) if (!privateKeys.has(key)) delete entries[key]
    })
    const restored = await open(storage)
    expect(restored.collections.messages.get("message-t-user")?.text).toBe("Keep the original question")
    expect(restored.collections.messages.get("message-t-smithers")?.text).toBe("An answer")
    expect(restored.collections.cards.get("file")?.payload).not.toHaveProperty("line", 7)
    expect((await restored.verifyState()).valid).toBe(true)
    expect((await restored.eventHistory()).head.streamId).toBe(before.head.streamId)
  })

  test("draft coalescing commits one immutable fact with the final input", async () => {
    const store = await open(memoryStorage())
    const one = store.dispatch({ type: "composer.changed", actor: "user", draft: "a" })
    const two = store.dispatch({ type: "composer.changed", actor: "user", draft: "abc" })
    expect(one).toBe(two)
    await one.isPersisted.promise
    const history = await store.eventHistory()
    expect(history.events).toHaveLength(1)
    expect(decodeEventValue(history.events[0]!.input)).toEqual({ type: "composer.changed", actor: "user", draft: "abc" })
    expect((await store.verifyState()).valid).toBe(true)
  })

  test("legacy rows gain an honest baseline and new facts start after it", async () => {
    const storage = memoryStorage()
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, "11")
    storage.setItem("smithers-mvp.app-sessions", JSON.stringify({ "s:main": {
      versionKey: "legacy", data: { ...initialSession("dark"), draft: "Existing work", revision: 28 }
    } }))
    const store = await open(storage)
    const migrated = await store.eventHistory()
    expect(migrated.checkpoint.reason).toBe("legacy-baseline")
    expect(migrated.head.sequence).toBe(0)
    expect(migrated.events).toHaveLength(0)
    await store.dispatch({ type: "theme.changed", actor: "user", theme: "light" }).isPersisted.promise
    const next = await store.eventHistory()
    expect(next.events[0]?.sequence).toBe(1)
    expect(next.events[0]?.revision).toBe(29)
    expect((await store.verifyState()).valid).toBe(true)
  })

  test("checkpoints cover removed history and suffix replay still equals served state", async () => {
    const storage = memoryStorage()
    const store = await open(storage)
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "Covered by checkpoint" }).isPersisted.promise
    const full = await store.eventHistory()
    await store.compactEvents()
    const compacted = await store.eventHistory()
    expect(compacted.events).toHaveLength(0)
    expect(compacted.checkpoint.sequence).toBe(full.head.sequence)
    expect(compacted.checkpoint.stateHash).toBe(full.head.stateHash)
    await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const suffix = await store.eventHistory()
    expect(suffix.events).toHaveLength(1)
    expect(replayAppEvents(suffix.checkpoint, suffix.events, suffix.head).snapshot.sessions[0]?.draft).toBe("Covered by checkpoint")
    const restored = await open(storage)
    expect((await restored.verifyState()).valid).toBe(true)
  })

  test("unknown event versions and missing history refuse boot without adopting the cached rows", async () => {
    for (const corrupt of ["version", "missing"] as const) {
      const storage = memoryStorage()
      const store = await open(storage)
      await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
      editEnvelope(storage, entries => {
        const key = "smithers-mvp.app-events"
        const rows = JSON.parse(entries[key]!) as Record<string, { data: Record<string, unknown> }>
        if (corrupt === "missing") delete rows[Object.keys(rows)[0]!]
        else Object.values(rows)[0]!.data.formatVersion = 999
        entries[key] = JSON.stringify(rows)
      })
      const preserved = storage.getItem(ENVELOPE_STORAGE_KEY)
      await expect(open(storage)).rejects.toThrow()
      expect(storage.getItem(ENVELOPE_STORAGE_KEY)).toBe(preserved)
    }
  })

  test("signout erases private event and historical payloads and retires their stream", async () => {
    const storage = memoryStorage()
    const store = await open(storage)
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
      allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "message.submitted", actor: "user", turnId: "private", text: "secret-before-signout" }).isPersisted.promise
    const old = await store.eventHistory()
    await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    const current = await store.eventHistory()
    expect(current.head.streamId).not.toBe(old.head.streamId)
    expect(current.checkpoint.reason).toBe("privacy-reset")
    expect(current.events).toHaveLength(0)
    expect(storage.getItem(ENVELOPE_STORAGE_KEY)).not.toContain("secret-before-signout")
    expect(() => replayAppEvents(current.checkpoint, old.events, current.head)).toThrow()
    expect((await store.verifyState()).valid).toBe(true)
  })

  test("concurrent accepted writes are not reported as projection corruption", async () => {
    const store = await open(memoryStorage())
    const before = store.verifyState()
    const accepted = store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const during = store.verifyState()
    const next = store.dispatch({ type: "composer.changed", actor: "user", draft: "Arrived during verification" }).isPersisted.promise
    const after = store.verifyState()
    const proofs = await Promise.all([before, during, after])
    await Promise.all([accepted, next])
    expect(proofs.every(proof => proof.valid)).toBe(true)
    expect(proofs[2]?.sequence).toBe(2)
  })

  test("failed commits reject their events and every optimistic dependent", async () => {
    const inner = memoryStorage()
    let broken = false
    const storage: StorageApi = { ...inner, setItem: (key, value) => {
      if (broken && key === ENVELOPE_STORAGE_KEY) throw new Error("disk full")
      inner.setItem(key, value)
    } }
    const store = await open(storage)
    const before = await store.eventHistory()
    broken = true
    const first = store.dispatch({ type: "composer.changed", actor: "user", draft: "Not accepted" }).isPersisted.promise
    const dependent = store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const outcomes = await Promise.allSettled([first, dependent])
    expect(outcomes.map(row => row.status)).toEqual(["rejected", "rejected"])
    expect((await store.eventHistory()).head).toEqual(before.head)
    expect((await store.verifyState()).valid).toBe(true)
    broken = false
    await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const restored = await open(storage)
    expect(restored.session().draft).toBe("")
    expect((await restored.verifyState()).valid).toBe(true)
  })

  test("a stale SQLite owner cannot compact against a newer committed head", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-app-event-cas-")); directories.push(directory)
    const path = join(directory, "state.sqlite")
    const stale = await sqliteStore(path)
    const first = await sqliteStore(path)
    await first.store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const accepted = await first.store.eventHistory()
    await expect(stale.store.compactEvents()).rejects.toThrow()
    const head = JSON.parse((first.db.query(`SELECT value FROM ${ROW_TABLE_NAME} WHERE collection_id = 'app-event-heads'`).get() as { value: string }).value)
    expect(head).toEqual(accepted.head)
    const checkpoint = JSON.parse((first.db.query(`SELECT value FROM ${ROW_TABLE_NAME} WHERE collection_id = 'app-event-checkpoints'`).get() as { value: string }).value)
    expect(checkpoint.reason).toBe("created")
    await Promise.resolve(stale.store.dispose?.()).catch(() => {})
    await first.store.dispose?.()
    const restored = await sqliteStore(path); opened.push(restored.store)
    expect(restored.store.session().theme).toBe("dark")
    expect((await restored.store.verifyState()).valid).toBe(true)
  })

  test("real SQLite close/reopen rebuilds deleted materializations from committed authority", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-app-events-")); directories.push(directory)
    const path = join(directory, "state.sqlite")

    const first = await sqliteStore(path)
    await first.store.dispatch({ type: "composer.changed", actor: "user", draft: "SQLite authority" }).isPersisted.promise
    await first.store.dispatch({ type: "message.submitted", actor: "user", turnId: "long-turn", text: "A retained question" }).isPersisted.promise
    for (let index = 0; index < 505; index += 1) {
      await first.store.dispatch({ type: "message.response.delta", actor: "smithers", turnId: "long-turn", channel: "text", delta: `${index},` }).isPersisted.promise
    }
    await first.store.dispatch({ type: "message.response.completed", actor: "smithers", turnId: "long-turn" }).isPersisted.promise
    await first.store.dispatch({ type: "composer.changed", actor: "user", draft: "SQLite authority" }).isPersisted.promise
    const accepted = await first.store.eventHistory()
    expect(accepted.events.length).toBeGreaterThan(500)
    expect(first.store.collections.transitions.size).toBe(500)
    expect([...first.store.collections.transitions.values()].some(row => row.type === "message.submitted")).toBe(false)
    await first.store.dispose?.()
    const tamper = new Database(path)
    tamper.run(`DELETE FROM ${ROW_TABLE_NAME} WHERE collection_id NOT IN ('app-events', 'app-event-heads', 'app-event-checkpoints', 'app-event-retirements')`)
    tamper.close()
    const restored = await sqliteStore(path); opened.push(restored.store)
    expect(restored.store.session().draft).toBe("SQLite authority")
    expect(restored.store.collections.messages.get("message-long-turn-user")?.text).toBe("A retained question")
    expect(restored.store.collections.messages.get("message-long-turn-smithers")?.text).toEndWith("504,")
    expect((await restored.store.eventHistory()).head.streamId).toBe(accepted.head.streamId)
    expect((await restored.store.verifyState()).valid).toBe(true)
  }, 120_000)
})

// Collection observers can see an optimistic row before its transaction is
// queued for storage. The settled barrier must include that accepted write.
test("settled from a collection observer includes its committed runtime receipt", async () => {
  const store = await open(memoryStorage())
  const observed = Promise.withResolvers<string | undefined>()
  const subscription = store.collections.runtimeRuns.subscribeChanges(() => {
    void store.settled!().then(() => {
      const row = [...store.collections.runtimeRuns.values()][0]
      observed.resolve(row && store.committedRuntimeRun(row.id)?.summary?.status)
    }, observed.reject)
  })
  try {
    const write = store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
      scope: { repo: "owner/repo", runId: "run-1" }, summary: {
        runId: "run-1", flowId: "review", status: "completed", createdAt: 1, updatedAt: 2,
        turns: 0, calls: 0, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0,
        inputTokens: 0, outputTokens: 0, verdict: "completed", diagnosis: "completed"
      }
    } })
    expect(await observed.promise).toBe("completed")
    await write.isPersisted.promise
  } finally { subscription.unsubscribe() }
})


test("an approval stays pending through a held SQLite commit and survives immediate reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-approval-commit-")); directories.push(directory)
  const path = join(directory, "app.sqlite")
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let hold = false
  const { store } = await sqliteStore(path, async () => {
    if (hold) { entered.resolve(); await release.promise }
  })
  opened.push(store)
  const scope = { repo: "owner/repo", runId: "run" }
  const id = runtimeApprovalKey(scope, "question", "sha256:reviewed")
  await store.dispatch({ type: "gateway.approvals.observed", actor: "system", scope, rows: [{
    runId: scope.runId, requestId: "question", title: "Owner?", request: { kind: "ask", prompt: "Owner?" },
    requestedAt: 1, status: "pending", payload: { target: { _tag: "Node", runId: scope.runId, requestId: "question",
      digest: "sha256:reviewed", envelope: { capabilities: [], flows: [], budget: {} } }, scope: "once", idempotencyKey: "question" }
  }] }).isPersisted.promise
  await store.dispatch({ type: "gateway.approval.submission.changed", actor: "user",
    submission: { id, submissionId: "answer", state: "pending" } }).isPersisted.promise
  hold = true
  const receipt = store.dispatch({ type: "gateway.approval.submission.changed", actor: "user",
    submission: { id, submissionId: "answer", state: "approved", decidedAt: 2 } })
  try {
    await entered.promise
    expect(store.collections.runtimeApprovals.get(id)?.row.status).toBe("pending")
    expect(store.collections.runtimeApprovals.get(id)?.pending).toBe(true)
    const chat = store.dispatch({ type: "composer.changed", actor: "user", draft: "Chat remains usable" })
    expect(store.session().draft).toBe("Chat remains usable")
    expect(store.collections.runtimeApprovals.get(id)?.row.status).toBe("pending")
    release.resolve()
    await receipt.isPersisted.promise
    expect(store.collections.runtimeApprovals.get(id)?.row.status).toBe("approved")
    await chat.isPersisted.promise
  } finally { hold = false; release.resolve(); await store.dispose?.() }
  const restored = await sqliteStore(path); opened.push(restored.store)
  expect(restored.store.collections.runtimeApprovals.get(id)?.row.status).toBe("approved")
  expect((await restored.store.verifyState()).valid).toBe(true)
})
