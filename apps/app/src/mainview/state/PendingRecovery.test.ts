import { afterEach, expect, test } from "bun:test"
import { admitsPendingRecovery, pendingRecoveryScope, sameRecoveryScope, type PendingRecoveryAuthority } from "./PendingRecovery"
import { createAppStore as openAppStore, type AppStore } from "./AppStore"
import { memoryStorage } from "./TestFixtures"
import { writeEntityRecovery, readEntityRecoveries, clearEntityRecovery, ENTITY_RECOVERY_STORAGE_KEY } from "./EntityRecovery"
import { writeWikiRecovery, WIKI_RECOVERY_STORAGE_KEY } from "./WikiRecovery"
import { writeDraftRecovery, DRAFT_RECOVERY_STORAGE_KEY } from "./DraftRecovery"
import type { Card } from "./AppState"

const stores = new Set<AppStore>()
const createAppStore: typeof openAppStore = async (...args) => {
  const store = await openAppStore(...args)
  stores.add(store)
  return store
}
const closeStores = async (): Promise<void> => {
  const errors: unknown[] = []
  for (const store of stores) {
    try {
      if (store.dispose === undefined) throw new Error("Fixture store has no disposal contract")
      await store.dispose()
    } catch (error) { errors.push(error) }
  }
  stores.clear()
  if (errors.length) throw new AggregateError(errors, "Pending recovery fixture cleanup failed")
}
afterEach(closeStores)

const card: Extract<Card, { kind: "flow-form" }> = { id: "form", kind: "flow-form", title: "Form", status: "active", createdAt: 1, ordinal: 1,
  payload: { flow: "wiki.open", via: "user", fields: [], draft: { path: "Pending.md" }, given: {} } }
const document = { id: "world-home", title: "World", path: "World.md", body: "Pending Wiki", links: [], tags: [], sources: ["user:world-editor"], confidence: 1 }
const bind = (head: Awaited<ReturnType<Awaited<ReturnType<typeof createAppStore>>["eventHistory"]>>["head"], scope: ReturnType<typeof pendingRecoveryScope>, intentId = "input"): PendingRecoveryAuthority => ({
  ...scope, streamId: head.streamId, baseSequence: head.sequence, baseEventHash: head.eventHash, actor: "user", intentId
})

test("recovery scope preserves all three owning identities, including the absence of a conversation tab", () => {
  const original = { workspaceId: "workspace-a", branchId: "branch-a", conversationTabId: null }
  expect(sameRecoveryScope(original, { ...original })).toBe(true)
  expect(sameRecoveryScope(original, { ...original, workspaceId: "workspace-b" })).toBe(false)
  expect(sameRecoveryScope(original, { ...original, branchId: "branch-b" })).toBe(false)
  expect(sameRecoveryScope(original, { ...original, conversationTabId: "chat-a" })).toBe(false)
  expect(sameRecoveryScope({ ...original, conversationTabId: "chat-a" }, { ...original, conversationTabId: "chat-a" })).toBe(true)
  expect(sameRecoveryScope({ ...original, conversationTabId: "chat-a" }, { ...original, conversationTabId: "chat-b" })).toBe(false)
})

for (const kind of ["form", "signup"] as const) {
  for (const actor of ["user", "smithers", "system"] as const) {
    for (const settled of [false, true]) {
      test(`${kind} prepared input admits ${actor} acceptance with settled=${settled} only while human-owned and pending`, async () => {
        const recovery = memoryStorage(), storage = memoryStorage(), prior = Object.getOwnPropertyDescriptor(globalThis, "window")
        Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: recovery, matchMedia: () => ({ matches: false }) } })
        try {
          const store = await createAppStore({ kind: "localStorage", storage })
          if (kind === "form") {
            const form: typeof card = { ...card, payload: { ...card.payload, fields: [{ name: "path", label: "Path", kind: "text", required: true }] } }
            await store.dispatch({ type: "card.upsert", actor: "user", card: form }).isPersisted.promise
            expect(store.stagePendingCardInput(form.id, { ...form, payload: { ...form.payload, draft: { path: "Recovered.md" } } }, "prepared-input", "path")).toBeDefined()
          } else {
            await store.dispatch({ type: "signup.changed", actor: "user", patch: { stage: "account", draft: { name: "Committed name" } } }).isPersisted.promise
            expect(store.stagePendingSignupInput("name", "Recovered name", "prepared-input")).toBeDefined()
          }
          const pending = readEntityRecoveries(recovery)
          expect(pending).toHaveLength(1)
          expect(pending[0]?.preparedCommandId).toBe("prepared-input")
          expect(pending[0]?.authority?.actor).toBe("user")
          await store.dispatch({ type: "command.intent.accepted", actor, id: "prepared-input", name: kind === "signup" ? "signup.set" : "form.set", source: "command" }).isPersisted.promise
          if (settled) await store.dispatch({ type: "command.intent.settled", actor, id: "prepared-input", outcome: "failed" }).isPersisted.promise
          await store.dispose?.()
          const restored = await createAppStore({ kind: "localStorage", storage })
          const accepted = actor === "user" && !settled
          if (kind === "form") expect(restored.collections.cards.get(card.id)).toMatchObject({ payload: { draft: { path: accepted ? "Recovered.md" : "Pending.md" } } })
          else expect(restored.session().signup?.draft).toEqual({ name: accepted ? "Recovered name" : "Committed name" })
          expect(readEntityRecoveries(recovery)).toEqual([])
          expect((await restored.verifyState()).valid).toBe(true)
        } finally {
          try { await closeStores() } finally {
            if (prior) Object.defineProperty(globalThis, "window", prior); else Reflect.deleteProperty(globalThis, "window")
          }
        }
      })
    }
  }
}

for (const kind of ["form", "signup"] as const) {
  test(`${kind} prepared input refuses an accepted command for the other editing door`, async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const boundary = await store.eventHistory(), authority = bind(boundary.head, pendingRecoveryScope(store.session()), "wrong-door")
    await store.dispatch({ type: "command.intent.accepted", actor: "user", id: "wrong-door", name: kind === "signup" ? "form.set" : "signup.set", source: "command" }).isPersisted.promise
    expect(admitsPendingRecovery({ revision: boundary.head.revision + 1, authority, preparedCommandId: "wrong-door",
      value: { kind: kind === "signup" ? "signup" : "card" } }, { ...await store.eventHistory(), commands: [...store.collections.commandIntents.values()] })).toBe(false)
  })
}

test("all pending recovery admission uses the same verified ancestor, not the moving replay revision", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const boundary = await store.eventHistory(), authority = bind(boundary.head, pendingRecoveryScope(store.session()))
  expect(admitsPendingRecovery({ revision: boundary.head.revision + 1, authority }, boundary)).toBe(true)
  expect(admitsPendingRecovery({ revision: boundary.head.revision + 2, authority }, boundary)).toBe(true)
  for (const changed of [{ streamId: "retired" }, { baseEventHash: "0".repeat(64) }, { baseSequence: boundary.head.sequence + 1 }]) {
    expect(admitsPendingRecovery({ revision: boundary.head.revision + 1, authority: { ...authority, ...changed } }, boundary)).toBe(false)
  }
  expect(admitsPendingRecovery({ revision: boundary.head.revision, authority }, boundary)).toBe(false)
  expect(admitsPendingRecovery({ revision: boundary.head.revision + 1 }, boundary)).toBe(false)
  await store.dispose?.()
})

test("an equal revision from another stream cannot clear a newer pending entity", () => {
  const storage = memoryStorage()
  const authority: PendingRecoveryAuthority = { streamId: "first", baseSequence: 0, baseEventHash: "a".repeat(64), actor: "user",
    intentId: "first", workspaceId: "workspace-main", branchId: "branch-main", conversationTabId: null }
  const first = { key: "card:workspace-main:branch-main:form", revision: 1, authority,
    value: { kind: "card" as const, workspaceId: "workspace-main", branchId: "branch-main", id: card.id, card } }
  writeEntityRecovery(storage, first)
  const second = { ...first, authority: { ...authority, streamId: "second", intentId: "second" } }
  writeEntityRecovery(storage, second)
  clearEntityRecovery(storage, first)
  expect(readEntityRecoveries(storage)).toEqual([second])
  clearEntityRecovery(storage, second)
  expect(storage.getItem(ENTITY_RECOVERY_STORAGE_KEY)).toBeNull()
})

test("pending card, Wiki and composer inputs retain their inactive branch without changing the current conversation", async () => {
  const recovery = memoryStorage(), storage = memoryStorage(), prior = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: recovery, matchMedia: () => ({ matches: false }) } })
  try {
    const original = await createAppStore({ kind: "localStorage", storage })
    const scope = pendingRecoveryScope(original.session())
    await original.dispatch({ type: "card.upsert", actor: "user", card }).isPersisted.promise
    await original.dispatch({ type: "conversation.cleared", actor: "user", branchId: "current-branch", notes: [] }).isPersisted.promise
    const boundary = await original.eventHistory(), authority = bind(boundary.head, scope)
    const current = original.session()
    await original.dispose?.()
    writeEntityRecovery(recovery, { key: `card:${scope.workspaceId}:${scope.branchId}:${card.id}`, revision: boundary.head.revision + 1, authority,
      value: { kind: "card", workspaceId: scope.workspaceId, branchId: scope.branchId, id: card.id, card: { ...card, title: "Recovered old branch" } } })
    writeWikiRecovery(recovery, boundary.head.revision + 2, document, { ...authority, intentId: "wiki" })
    writeDraftRecovery(recovery, boundary.head.revision + 3, "old branch draft", { ...authority, intentId: "draft" })
    const reopened = await createAppStore({ kind: "localStorage", storage })
    expect(reopened.session().activeBranchId).toBe(current.activeBranchId)
    expect(reopened.session().draft).toBe(current.draft)
    expect(reopened.collections.cards.get(card.id)).toBeUndefined()
    expect(reopened.collections.worldDocuments.get(document.id)?.body).not.toBe(document.body)
    const snapshot = reopened.collections.branches.get(scope.branchId)!.snapshot!
    expect(snapshot.cards.find(row => row.id === card.id)?.title).toBe("Recovered old branch")
    expect(snapshot.worldDocuments.find(row => row.id === document.id)?.body).toBe(document.body)
    expect(snapshot.draft).toBe("old branch draft")
    expect((await reopened.verifyState()).valid).toBe(true)
    await reopened.dispose?.()
  } finally {
    try { await closeStores() } finally {
      if (prior) Object.defineProperty(globalThis, "window", prior); else Reflect.deleteProperty(globalThis, "window")
    }
  }
})

for (const reset of [false, true]) test(`${reset ? "reset" : "account retirement"} erases every pending input slot`, async () => {
  const recovery = memoryStorage(), storage = memoryStorage(), prior = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: recovery, matchMedia: () => ({ matches: false }) } })
  try {
    const store = await createAppStore({ kind: "localStorage", storage })
    const { head } = await store.eventHistory(), scope = pendingRecoveryScope(store.session()), authority = bind(head, scope)
    writeEntityRecovery(recovery, { key: `card:${scope.workspaceId}:${scope.branchId}:${card.id}`, revision: head.revision + 1, authority,
      value: { kind: "card", workspaceId: scope.workspaceId, branchId: scope.branchId, id: card.id, card } })
    writeWikiRecovery(recovery, head.revision + 2, document, authority)
    writeDraftRecovery(recovery, head.revision + 3, "private draft", authority)
    writeEntityRecovery(recovery, { key: "hint-dismissed:chat", revision: head.revision + 4, authority,
      value: { kind: "hint-dismissed", id: "chat" } })
    await store.dispatch(reset ? { type: "app.reset", actor: "user" } : { type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    for (const key of [ENTITY_RECOVERY_STORAGE_KEY, WIKI_RECOVERY_STORAGE_KEY, DRAFT_RECOVERY_STORAGE_KEY]) expect(recovery.getItem(key)).toBeNull()
    await store.dispose?.()
  } finally {
    try { await closeStores() } finally {
      if (prior) Object.defineProperty(globalThis, "window", prior); else Reflect.deleteProperty(globalThis, "window")
    }
  }
})

test("prepared form input can survive missing acceptance but never a settled or foreign command", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const original = await store.eventHistory(), authority = bind(original.head, pendingRecoveryScope(store.session()), "command-input")
  const record = { revision: original.head.revision + 1, authority, preparedCommandId: authority.intentId }
  const boundary = async () => ({ ...await store.eventHistory(), commands: [...store.collections.commandIntents.values()] })
  expect(admitsPendingRecovery(record, await boundary())).toBe(true)
  await store.dispatch({ type: "command.intent.accepted", actor: "user", id: authority.intentId, name: "form.set", source: "command" }).isPersisted.promise
  expect(admitsPendingRecovery(record, await boundary())).toBe(true)
  await store.dispatch({ type: "command.intent.settled", actor: "user", id: authority.intentId, outcome: "failed" }).isPersisted.promise
  expect(admitsPendingRecovery(record, await boundary())).toBe(false)
  expect(admitsPendingRecovery({ ...record, preparedCommandId: "other" }, await boundary())).toBe(false)
  await store.dispose?.()
})

test("a cleared form field replaces pending text without mutating accepted draft or losing another prepared field", async () => {
  const recovery = memoryStorage(), prior = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: recovery, matchMedia: () => ({ matches: false }) } })
  try {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const form = { ...card, kind: "flow-form" as const, payload: { ...card.payload as Extract<Card, { kind: "flow-form" }>["payload"],
      fields: [{ name: "path", label: "Path", kind: "text" as const, required: true }, { name: "title", label: "Title", kind: "text" as const, required: false }], draft: {} } }
    await store.dispatch({ type: "card.upsert", actor: "user", card: form }).isPersisted.promise
    const first = store.stagePendingCardInput(form.id, { ...form, payload: { ...form.payload, draft: { path: "pending" } } }, "first", "path")!
    store.stagePendingCardInput(form.id, { ...form, payload: { ...form.payload, draft: { title: "retained" } } }, "second", "title")
    store.stagePendingCardInput(form.id, form, "third", "path")
    first.clear()
    const pending = readEntityRecoveries(recovery)[0]!
    expect(pending.value.kind === "card" && pending.value.card?.kind === "flow-form" && pending.value.card.payload.draft).toEqual({ title: "retained" })
    expect(store.collections.cards.get(form.id)).toMatchObject({ payload: { draft: {} } })
    expect(store.stagePendingCardInput(form.id, { ...form, payload: { ...form.payload, draft: { path: "forged", title: "unrelated" } } }, "forged", "path")).toBeUndefined()
    await store.dispose?.()
  } finally {
    try { await closeStores() } finally {
      if (prior) Object.defineProperty(globalThis, "window", prior); else Reflect.deleteProperty(globalThis, "window")
    }
  }
})

for (const compact of [false, true]) test(`a prepared edit of an errored form survives reload${compact ? " with explicit compaction deferred" : ""}`, async () => {
  const recovery = memoryStorage(), storage = memoryStorage(), prior = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: recovery, matchMedia: () => ({ matches: false }) } })
  try {
    const store = await createAppStore({ kind: "localStorage", storage })
    const form: Extract<Card, { kind: "flow-form" }> = { ...card as Extract<Card, { kind: "flow-form" }>, status: "error",
      payload: { ...(card as Extract<Card, { kind: "flow-form" }>).payload,
        fields: [{ name: "path", label: "Path", kind: "text", required: true }], draft: { path: "old" }, error: "Submission failed" } }
    await store.dispatch({ type: "card.upsert", actor: "user", card: form }).isPersisted.promise
    const { error: _error, ...payload } = form.payload
    const next = { ...form, status: "active" as const, payload: { ...payload, draft: { path: "corrected" } } }
    const prepared = store.stagePendingCardInput(form.id, next, "error-edit", "path")
    expect(prepared).toBeDefined()
    expect(store.stagePendingCardInput(form.id, { ...next, status: "acted" }, "forged", "path")).toBeUndefined()
    const before = readEntityRecoveries(recovery)[0]!
    if (compact) {
      await store.dispatch({ type: "command.intent.accepted", actor: "user", id: "error-edit", name: "form.set", source: "command" }).isPersisted.promise
      await expect(store.compactEvents()).rejects.toThrow("compaction is deferred")
      expect(readEntityRecoveries(recovery)).toEqual([before])
      const history = await store.eventHistory()
      expect(history.events.some(event => event.sequence === before.authority!.baseSequence)).toBe(true)
    }
    expect(store.collections.cards.get(form.id)).toMatchObject({ status: "error", payload: { draft: { path: "old" }, error: "Submission failed" } })
    await store.dispose?.()
    const reopened = await createAppStore({ kind: "localStorage", storage })
    expect(reopened.collections.cards.get(form.id)).toMatchObject({ status: "active", payload: { draft: { path: "corrected" } } })
    expect(reopened.collections.cards.get(form.id)?.payload).not.toHaveProperty("error")
    expect(readEntityRecoveries(recovery)).toEqual([])
    await reopened.compactEvents()
    expect((await reopened.verifyState()).valid).toBe(true)
    await reopened.dispose?.()
  } finally {
    try { await closeStores() } finally {
      if (prior) Object.defineProperty(globalThis, "window", prior); else Reflect.deleteProperty(globalThis, "window")
    }
  }
})

test("an invalid prepared prefix cannot be rebound by a later field edit or hide a current recovery write", async () => {
  const recovery = memoryStorage(), prior = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: recovery, matchMedia: () => ({ matches: false }) } })
  try {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const form: Extract<Card, { kind: "flow-form" }> = { ...card as Extract<Card, { kind: "flow-form" }>,
      payload: { ...(card as Extract<Card, { kind: "flow-form" }>).payload, draft: {},
        fields: [{ name: "path", label: "Path", kind: "text", required: true }, { name: "title", label: "Title", kind: "text", required: false }] } }
    await store.dispatch({ type: "card.upsert", actor: "user", card: form }).isPersisted.promise
    store.stagePendingCardInput(form.id, { ...form, payload: { ...form.payload, draft: { path: "unproven" } } }, "unproven", "path")
    const corruptPrefix = () => {
      const pending = readEntityRecoveries(recovery)[0]!
      writeEntityRecovery(recovery, { ...pending, authority: { ...pending.authority!, baseEventHash: "0".repeat(64) } })
    }
    corruptPrefix()
    store.stagePendingCardInput(form.id, { ...form, payload: { ...form.payload, draft: { title: "valid" } } }, "valid", "title")
    const next = readEntityRecoveries(recovery)[0]!
    expect(next.value.kind === "card" && next.value.card?.kind === "flow-form" && next.value.card.payload.draft).toEqual({ title: "valid" })
    corruptPrefix()
    const transaction = store.dispatch({ type: "card.updated", actor: "user", id: form.id, patch: { payload: { ...form.payload, draft: { path: "accepted" } } } })
    const replacement = readEntityRecoveries(recovery)[0]!
    expect(replacement.preparedCommandId).toBeUndefined()
    expect(replacement.authority?.baseEventHash).not.toBe("0".repeat(64))
    expect(replacement.value.kind === "card" && replacement.value.card?.kind === "flow-form" && replacement.value.card.payload.draft).toEqual({ path: "accepted" })
    await transaction.isPersisted.promise
    expect(readEntityRecoveries(recovery)).toEqual([])
    await store.dispose?.()
  } finally {
    try { await closeStores() } finally {
      if (prior) Object.defineProperty(globalThis, "window", prior); else Reflect.deleteProperty(globalThis, "window")
    }
  }
})

/* A persisted unsaved Wiki note edit is replayed on the next load. */
test("a persisted Wiki edit is replayed", async () => {
  const recovery = memoryStorage(), storage = memoryStorage(), prior = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: recovery, matchMedia: () => ({ matches: false }) } })
  try {
    const original = await createAppStore({ kind: "localStorage", storage })
    const { head } = await original.eventHistory(), authority = bind(head, pendingRecoveryScope(original.session()), "wiki")
    await original.dispose?.()
    writeWikiRecovery(recovery, head.revision + 1, document, authority)
    const reopened = await createAppStore({ kind: "localStorage", storage })
    expect(reopened.collections.worldDocuments.get(document.id)?.body).toBe(document.body)
    expect(recovery.getItem(WIKI_RECOVERY_STORAGE_KEY)).toBeNull()
    expect((await reopened.verifyState()).valid).toBe(true)
    await reopened.dispose?.()
  } finally {
    try { await closeStores() } finally {
      if (prior) Object.defineProperty(globalThis, "window", prior); else Reflect.deleteProperty(globalThis, "window")
    }
  }
})
