import { CardSchema, type Card } from "@smthrs/rpc/Cards"
import { digest } from "@smthrs/core/Digest"
import { afterEach, expect, test } from "bun:test"
import { ENVELOPE_STORAGE_KEY, parseStorageEnvelope } from "../chain/TransactionalStorage"
import { APP_PROJECTOR_VERSION, appProjectionHash, normalizeAppProjection, replayAppEvents } from "./AppEventStream"
import { projectAppEvent, type AppProjectionSnapshot } from "./AppProjection"
import { createAppStore, type AppStore } from "./AppStore"
import type { AppTransition } from "./AppState"
import { validateAppTransition } from "./AppTransitionValidation"
import { cardAvailable } from "./CardAvailability"
import { canonicalEventValue, decodeEventValue, encodeEventValue } from "./EventValue"
import { memoryStorage } from "./TestFixtures"

const kinds = ["repository-setup", "admin-health", "registration", "notifications", "connect", "agent", "flow-form"] as const
const opened: AppStore[] = []
afterEach(async () => { for (const store of opened.splice(0)) await store.dispose?.() })
const open = async (storage: ReturnType<typeof memoryStorage>) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  opened.push(store)
  return store
}
const legacyCard = (kind: string, updated = false) => ({ id: "saved-cut-card", kind, title: "Old action", body: "Private old markup",
  status: "active", createdAt: 1, ordinal: 1, payload: kind === "flow-form"
    ? { flow: "wiki.ask", via: "user", fields: [], draft: { question: "Private old question" }, given: {} }
    : { secret: updated ? "Private updated payload" : "Private old payload", action: { flow: "signup.finish" } } })
const inert = (card: Card | undefined) => {
  expect(card).toMatchObject({ id: "saved-cut-card", kind: "retired", title: "", status: "acted", loading: false, payload: {} })
  expect(card).not.toHaveProperty("body")
  expect(cardAvailable(card!.kind)).toBe(false)
}
const seal = <T extends object>(domain: string, body: T) => ({ ...body,
  hash: digest(`smithers-app/${domain}/v1:` + canonicalEventValue(body)) })
const historicalSnapshot = (snapshot: AppProjectionSnapshot, kind: string, updated: boolean): AppProjectionSnapshot => ({
  ...snapshot, cards: snapshot.cards.map(card => card.id === "saved-cut-card" ? legacyCard(kind, updated) as unknown as Card : card)
})

for (const kind of kinds) test(`a version 32 ${kind} checkpoint and original update event reopen as inert history`, async () => {
  const storage = memoryStorage(), store = await open(storage)
  await store.dispatch({ type: "composer.changed", actor: "user", draft: "Keep my conversation" }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "system", card: { id: "saved-cut-card", kind: "file", title: "Old action",
    status: "active", createdAt: 1, ordinal: 1, payload: { repo: "org/repo", path: "a.ts", content: "Before", truncated: false } } }).isPersisted.promise
  await store.compactEvents()
  await store.dispatch({ type: "card.updated", actor: "system", id: "saved-cut-card",
    patch: { kind: "file", payload: { content: "After" } } }).isPersisted.promise
  const history = await store.eventHistory()
  const oldCheckpointSnapshot = historicalSnapshot(normalizeAppProjection(history.checkpoint.snapshot), kind, false)
  const oldFinalSnapshot = historicalSnapshot(replayAppEvents(history.checkpoint, history.events, history.head).snapshot, kind, true)
  const previousStateHash = appProjectionHash(oldCheckpointSnapshot), stateHash = appProjectionHash(oldFinalSnapshot)
  const { hash: _checkpointHash, ...checkpointBody } = history.checkpoint
  const checkpoint = seal("checkpoint", { ...checkpointBody, projectorVersion: 32, snapshot: oldCheckpointSnapshot, stateHash: previousStateHash })
  const original = { type: "card.updated", actor: "system", id: "saved-cut-card", patch: { kind,
    payload: legacyCard(kind, true).payload } }
  const actual = history.events.find(event => event.type === "card.updated")!
  expect(history.events).toHaveLength(1)
  const { hash: _eventHash, ...eventBody } = actual
  const event = seal("event", { ...eventBody, projectorVersion: 32, input: encodeEventValue(original), previousStateHash, stateHash })
  const head = { ...history.head, projectorVersion: 32, stateHash, eventHash: event.hash }
  await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
  const envelope = parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!
  const rows = (values: readonly { readonly id: string }[]) => JSON.stringify(Object.fromEntries(values.map(data =>
    [`s:${data.id}`, { versionKey: "legacy-fixture", data }])))
  for (const [id, values] of [["app-events", [event]], ["app-event-heads", [head]], ["app-event-checkpoints", [checkpoint]],
    ["app-cards", oldFinalSnapshot.cards]] as const) envelope.entries[`smithers-mvp.${id}`] = rows(values)
  storage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify(envelope))
  // Assert original historical tags/hashes were installed, not normalized by today's dispatch.
  expect(decodeEventValue(event.input)).toEqual(original)
  expect(JSON.parse(envelope.entries["smithers-mvp.app-events"]!)[`s:${event.id}`].data.hash).toBe(event.hash)
  expect(checkpoint.snapshot.cards.find(card => card.id === "saved-cut-card")?.kind as string).toBe(kind)
  const restored = await open(storage)
  inert(restored.collections.cards.get("saved-cut-card"))
  expect(restored.session().draft).toBe("Keep my conversation")
  const rotated = await restored.eventHistory()
  expect(rotated.checkpoint.reason).toBe("projector-upgrade")
  expect(rotated.head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
  expect(rotated.head.streamId).not.toBe(head.streamId)
  expect([...restored.collections.transitions.values()].some(row => row.type === "card.updated")).toBe(true)
  expect((await restored.verifyState()).valid).toBe(true)
  await restored.dispose?.(); opened.splice(opened.indexOf(restored), 1)
  const reopened = await open(storage)
  inert(reopened.collections.cards.get("saved-cut-card"))
  expect((await reopened.eventHistory()).head.streamId).toBe(rotated.head.streamId)
  expect((await reopened.verifyState()).valid).toBe(true)
})

test("a Cut flow-form update stays inert after its upsert already decoded as retired", async () => {
  const storage = memoryStorage(), store = await open(storage)
  await store.dispatch({ type: "card.upsert", actor: "system", card: CardSchema.parse(legacyCard("flow-form")) }).isPersisted.promise
  const history = await store.eventHistory()
  const snapshot = replayAppEvents(history.checkpoint, history.events, history.head).snapshot
  const original = { type: "card.updated", actor: "system", id: "saved-cut-card", patch: { kind: "flow-form", payload: legacyCard("flow-form", true).payload } }
  const decoded = validateAppTransition(snapshot, original)
  expect(decoded).toEqual(original as AppTransition)
  expect(projectAppEvent(snapshot, { transition: decoded, revision: history.head.revision + 1, createdAt: 2, persistenceMode: "localStorage" })).toBe(snapshot)
  inert(store.collections.cards.get("saved-cut-card"))
})

test("unknown kinds and invalid live card patches remain rejected while valid live updates work", async () => {
  const storage = memoryStorage(), store = await open(storage)
  await store.dispatch({ type: "card.upsert", actor: "system", card: { id: "file", kind: "file", title: "File", status: "active",
    createdAt: 1, ordinal: 1, payload: { repo: "org/repo", path: "a.ts", content: "Keep", truncated: false, line: 2 } } }).isPersisted.promise
  const history = await store.eventHistory()
  const current = replayAppEvents(history.checkpoint, history.events, history.head).snapshot
  const valid = { type: "card.updated", actor: "system", id: "file", patch: { kind: "file", payload: { line: 3 } } } as const
  expect(validateAppTransition(current, valid)).toEqual(valid)
  for (const patch of [{ kind: "unknown-kind", payload: {} }, { kind: "file", payload: { line: "three" } },
    { kind: "file", status: "unknown" }, { kind: 12 }, { kind: "file", injected: true }]) {
    expect(() => validateAppTransition(current, { type: "card.updated", actor: "system", id: "file", patch })).toThrow("event contract")
  }
  await store.dispatch(valid).isPersisted.promise
  expect(store.collections.cards.get("file")?.payload).toMatchObject({ content: "Keep", line: 3 })
  expect((await store.verifyState()).valid).toBe(true)
})

test("an uncompacted version 32 journal preserves its original legacy upsert and update bytes for rotation", async () => {
  const storage = memoryStorage(), store = await open(storage)
  await store.dispatch({ type: "composer.changed", actor: "user", draft: "Keep the uncompacted conversation" }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "system", card: { id: "saved-cut-card", kind: "file", title: "Old action",
    status: "active", createdAt: 1, ordinal: 1, payload: { repo: "org/repo", path: "a.ts", content: "Before", truncated: false } } }).isPersisted.promise
  await store.dispatch({ type: "card.updated", actor: "system", id: "saved-cut-card",
    patch: { kind: "file", payload: { content: "After" } } }).isPersisted.promise
  const history = await store.eventHistory()
  const { hash: _hash, ...checkpointBody } = history.checkpoint
  const checkpoint = seal("checkpoint", { ...checkpointBody, projectorVersion: 32 })
  let previousStateHash = checkpoint.stateHash, previousEventHash = checkpoint.eventHash
  const events = history.events.map((record, index) => {
    const originalHead = { ...history.head, sequence: record.sequence, revision: record.revision,
      stateHash: record.stateHash, eventHash: record.hash }
    const snapshot = replayAppEvents(history.checkpoint, history.events.slice(0, index + 1), originalHead).snapshot
    const stateHash = appProjectionHash(historicalSnapshot(snapshot, "admin-health", record.type === "card.updated"))
    const input = record.type === "card.upsert" ? { type: "card.upsert", actor: "system", card: legacyCard("admin-health") }
      : record.type === "card.updated" ? { type: "card.updated", actor: "system", id: "saved-cut-card",
        patch: { kind: "admin-health", payload: legacyCard("admin-health", true).payload } }
      : decodeEventValue(record.input)
    const { hash: _recordHash, ...body } = record
    const event = seal("event", { ...body, projectorVersion: 32, input: encodeEventValue(input), stateHash, previousStateHash, previousEventHash })
    previousStateHash = stateHash; previousEventHash = event.hash
    return event
  })
  const head = { ...history.head, projectorVersion: 32, stateHash: previousStateHash, eventHash: previousEventHash }
  const finalSnapshot = historicalSnapshot(replayAppEvents(history.checkpoint, history.events, history.head).snapshot, "admin-health", true)
  await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
  const envelope = parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!
  const rows = (values: readonly { readonly id: string }[]) => JSON.stringify(Object.fromEntries(values.map(data =>
    [`s:${data.id}`, { versionKey: "legacy-fixture", data }])))
  for (const [id, values] of [["app-events", events], ["app-event-heads", [head]], ["app-event-checkpoints", [checkpoint]],
    ["app-cards", finalSnapshot.cards]] as const) envelope.entries[`smithers-mvp.${id}`] = rows(values)
  storage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify(envelope))
  const savedBytes = envelope.entries["smithers-mvp.app-events"]!
  expect(JSON.parse(savedBytes)[`s:${events.find(event => event.type === "card.upsert")!.id}`].data.input.value.card.kind).toBe("admin-health")
  expect(JSON.parse(savedBytes)[`s:${events.find(event => event.type === "card.updated")!.id}`].data.input.value.patch.kind).toBe("admin-health")
  const restored = await open(storage)
  inert(restored.collections.cards.get("saved-cut-card"))
  expect(restored.session().draft).toBe("Keep the uncompacted conversation")
  expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
  expect((await restored.verifyState()).valid).toBe(true)
  // The fixture's sealed bytes remain an archive; migration seeds sanitized rows, never rewrites old event hashes.
  expect(savedBytes).toBe(rows(events))
})

test("reload retires a selected retained card tab without losing its card or conversation", async () => {
  // T-CUT-01 / Appendix B cuts tab.*, while saved cards/history stay readable.
  const storage = memoryStorage(), store = await open(storage)
  const card = { id: "saved-status", kind: "status", title: "Saved", status: "active", createdAt: 1, ordinal: 1, payload: { note: "Keep" } } as const
  await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
  await store.dispatch({ type: "composer.changed", actor: "user", draft: "Keep conversation" }).isPersisted.promise
  await store.dispatch({ type: "tab.opened", actor: "user", tab: { id: "card-saved-status", kind: "card", title: "Saved", cardId: card.id } }).isPersisted.promise
  expect(store.session().activeTabId).toBe("card-saved-status")
  await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
  const restored = await open(storage)
  expect(restored.session().activeTabId).toBe("main")
  expect(restored.collections.tabs.has("card-saved-status")).toBe(false)
  expect(restored.collections.cards.get(card.id)).toMatchObject(card)
  expect(restored.session().draft).toBe("Keep conversation")
  expect((await restored.verifyState()).valid).toBe(true)
})

test("retained grant confirmation bindings report removed command refusals through the real controller", async () => {
  // Ticket Out retains GrantConfirm; a saved action must never silently no-op.
  const { cardActions } = await import("../cards/CardActions")
  const { createAppController } = await import("./AppController")
  const { silentAgent, json } = await import("./TestFixtures")
  const store = await open(memoryStorage())
  const controller = createAppController(store, silentAgent, { fetchImpl: async () => json(404, {}) })
  try {
    for (const phase of ["confirm", "failed"] as const) {
      const card = { id: `grant-${phase}`, kind: "grant-confirm", title: "Grant", status: "active", createdAt: 1, ordinal: 1,
        payload: { login: "alice", amountUsd: 1, phase } } as const
      await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
      const bindings = cardActions(controller, card)
      for (const action of [bindings.onGrantConfirm, bindings.onGrantCancel]) {
        action(card.id)
        const command = action === bindings.onGrantConfirm ? "confirm" : "cancel"
        expect([...store.collections.toasts.values()]).toContainEqual(expect.objectContaining({
          key: `command.unavailable.admin.grant.${command}`, title: "This action is no longer available", status: "failed"
        }))
      }
    }
  } finally { await controller.dispose() }
})
