import { ENTITY_RECOVERY_STORAGE_KEY, readEntityRecoveries, writeEntityRecovery } from "./EntityRecovery"
import { WIKI_RECOVERY_STORAGE_KEY, writeWikiRecovery } from "./WikiRecovery"
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { APP_SCHEMA_VERSION } from "../chain/SchemaVersion"
import { openSqliteRowStorage, ROW_TABLE_NAME } from "../chain/SqliteRowStorage"
import { ENVELOPE_STORAGE_KEY } from "../chain/TransactionalStorage"
import type {  ToolCallRecord, TransitionRecord } from "./AppState"
import { createAppStore, MAX_TOOL_CALL_RECORDS, MAX_TRANSITION_RECORDS } from "./AppStore"
import { DRAFT_RECOVERY_STORAGE_KEY, readDraftRecovery, writeDraftRecovery } from "./DraftRecovery"
import { memoryStorage, writeLegacyCollection } from "./TestFixtures"

/*
 * Ruling A, store level (docs/persistence.md): a dispatch is one atomic
 * commit — every projection changes or none does — and the log collections
 * compact to their documented retention bounds inside the committing
 * transaction.
 */

/** A host whose envelope commit write can be made to crash mid-dispatch. */
const crashableStorage = (): StorageApi & { crashCommit: () => void; heal: () => void } => {
  const inner = memoryStorage()
  let armed = false
  return {
    crashCommit: () => {
      armed = true
    },
    heal: () => {
      armed = false
    },
    getItem: (key) => inner.getItem(key),
    setItem: (key, value) => {
      if (armed && key === ENVELOPE_STORAGE_KEY) throw new Error("crash at the commit point")
      inner.setItem(key, value)
    },
    removeItem: (key) => inner.removeItem(key)
  }
}

describe("an atomic commit point per logical transition", () => {
  test("hint dismissals recover from the exact bytes present before their commits", async () => {
    const recovery = memoryStorage(), durable = memoryStorage(), crashed = memoryStorage(), crashedRecovery = memoryStorage()
    const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: recovery, matchMedia: () => ({ matches: false }) } })
    let store: Awaited<ReturnType<typeof createAppStore>> | undefined
    let reopened: Awaited<ReturnType<typeof createAppStore>> | undefined
    try {
      store = await createAppStore({ kind: "localStorage", storage: durable })
      await store.settled?.()
      crashed.setItem(ENVELOPE_STORAGE_KEY, durable.getItem(ENVELOPE_STORAGE_KEY)!)
      const first = store.dispatch({ type: "hint.dismissed", actor: "user", id: "chat" })
      const second = store.dispatch({ type: "hint.dismissed", actor: "user", id: "first-run" })
      const raw = recovery.getItem(ENTITY_RECOVERY_STORAGE_KEY)
      if (raw !== null) crashedRecovery.setItem(ENTITY_RECOVERY_STORAGE_KEY, raw)
      expect(store.session().hintsSeen).toEqual(["chat", "first-run"])
      await Promise.all([first.isPersisted.promise, second.isPersisted.promise])
      expect(recovery.getItem(ENTITY_RECOVERY_STORAGE_KEY)).toBeNull()
      await store.dispose?.(); store = undefined
      Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: crashedRecovery, matchMedia: () => ({ matches: false }) } })
      reopened = await createAppStore({ kind: "localStorage", storage: crashed })
      expect(reopened.session().hintsSeen).toEqual(["chat", "first-run"])
      expect(crashedRecovery.getItem(ENTITY_RECOVERY_STORAGE_KEY)).toBeNull()
      expect((await reopened.verifyState()).valid).toBe(true)
    } finally {
      await reopened?.dispose?.(); await store?.dispose?.()
      if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow); else Reflect.deleteProperty(globalThis, "window")
    }
  })

  test("boot replays a pending card, Wiki edit, and later draft against the original durable revision", async () => {
    const recovery = memoryStorage(), durableStorage = memoryStorage()
    const original = await createAppStore({ kind: "localStorage", storage: durableStorage })
    const { head } = await original.eventHistory()
    await original.dispose?.()
    const authority = { streamId: head.streamId, baseSequence: head.sequence, baseEventHash: head.eventHash, actor: "user" as const,
      intentId: "pending-input", workspaceId: "workspace-main", branchId: "branch-main", conversationTabId: null }
    const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    let store: Awaited<ReturnType<typeof createAppStore>> | undefined
    const card = {
      id: "pending-card", kind: "flow-form" as const, title: "Pending form", status: "active" as const, createdAt: 1, ordinal: 1,
      payload: { flow: "wiki.open", via: "user" as const, fields: [], draft: { path: "Recovered.md" }, given: {} }
    }
    writeEntityRecovery(recovery, { key: `card:workspace-main:branch-main:${card.id}`, revision: head.revision + 1, authority,
      value: { kind: "card", workspaceId: "workspace-main", branchId: "branch-main", id: card.id, card } })
    writeWikiRecovery(recovery, head.revision + 2, {
      id: "world-home", path: "World.md", title: "World", body: "# Recovered Wiki\n", links: [], tags: [],
      sources: ["user:world-editor"], confidence: 1
    }, { ...authority, intentId: "pending-wiki" })
    writeDraftRecovery(recovery, head.revision + 3, "recovered later draft", { ...authority, intentId: "pending-draft" })
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: recovery, matchMedia: () => ({ matches: false })
    } })
    try {
      store = await createAppStore({ kind: "localStorage", storage: durableStorage })
      const recoveredCard = store.collections.cards.get(card.id)
      expect(recoveredCard?.kind).toBe("flow-form")
      if (recoveredCard?.kind !== "flow-form") throw new Error("Recovered card did not retain its form projection")
      expect(recoveredCard.payload.draft).toEqual({ path: "Recovered.md" })
      expect(store.collections.worldDocuments.get("world-home")?.body).toBe("# Recovered Wiki\n")
      expect(store.session().draft).toBe("recovered later draft")
      expect(recovery.getItem(ENTITY_RECOVERY_STORAGE_KEY)).toBeNull()
      expect(recovery.getItem(WIKI_RECOVERY_STORAGE_KEY)).toBeNull()
      expect(recovery.getItem(DRAFT_RECOVERY_STORAGE_KEY)).toBeNull()
    } finally {
      await store?.dispose?.()
      if (priorWindow !== undefined) Object.defineProperty(globalThis, "window", priorWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  test("a signup answer and a first-run dismissal are recoverable from dispatch and replay on boot", async () => {
    const recovery = memoryStorage(), durableStorage = memoryStorage()
    const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: recovery, matchMedia: () => ({ matches: false })
    } })
    let store: Awaited<ReturnType<typeof createAppStore>> | undefined
    let reopened: Awaited<ReturnType<typeof createAppStore>> | undefined
    try {
      store = await createAppStore({ kind: "localStorage", storage: durableStorage })
      const signup = { stage: "poll" as const, question: 5, answers: { models: ["Claude"] }, draft: {} }
      const answered = store.dispatch({ type: "signup.changed", actor: "user", patch: signup })
      const dismissed = store.dispatch({ type: "first-run.dismissed", actor: "user" })
      // The page may leave before the durable commit settles: the answers are already recoverable.
      expect(readEntityRecoveries(recovery).map(record => record.value)).toEqual([{ kind: "signup", signup }, { kind: "first-run-dismissed" }])
      await answered.isPersisted.promise
      await dismissed.isPersisted.promise
      expect(recovery.getItem(ENTITY_RECOVERY_STORAGE_KEY)).toBeNull()
      await store.dispose?.()
      store = undefined

      // A departure before the commit: the durable stream is still at `head`, the record is not.
      const lost = memoryStorage()
      const before = await createAppStore({ kind: "localStorage", storage: lost })
      const lostHead = (await before.eventHistory()).head
      await before.dispose?.()
      writeEntityRecovery(recovery, { key: "signup", revision: lostHead.revision + 1, value: { kind: "signup", signup }, authority: {
        streamId: lostHead.streamId, baseSequence: lostHead.sequence, baseEventHash: lostHead.eventHash, actor: "user",
        intentId: "pending-signup", workspaceId: "workspace-main", branchId: "branch-main", conversationTabId: null } })
      writeEntityRecovery(recovery, { key: "first-run-dismissed", revision: lostHead.revision + 2, value: { kind: "first-run-dismissed" }, authority: {
        streamId: lostHead.streamId, baseSequence: lostHead.sequence, baseEventHash: lostHead.eventHash, actor: "user",
        intentId: "pending-dismissal", workspaceId: "workspace-main", branchId: "branch-main", conversationTabId: null } })
      reopened = await createAppStore({ kind: "localStorage", storage: lost })
      expect(reopened.session().signup).toEqual(signup)
      expect(reopened.session().firstRunDismissed).toBe(true)
      expect(recovery.getItem(ENTITY_RECOVERY_STORAGE_KEY)).toBeNull()
    } finally {
      await reopened?.dispose?.()
      await store?.dispose?.()
      if (priorWindow !== undefined) Object.defineProperty(globalThis, "window", priorWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  for (const kind of ["card", "hint"] as const) test(`a rejected ${kind} mutation rolls back its crash record instead of resurrecting on boot`, async () => {
    const recovery = memoryStorage()
    const host = crashableStorage()
    const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    let store: Awaited<ReturnType<typeof createAppStore>> | undefined
    let reopened: Awaited<ReturnType<typeof createAppStore>> | undefined
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: recovery, matchMedia: () => ({ matches: false })
    } })
    try {
      store = await createAppStore({ kind: "localStorage", storage: host })
      host.crashCommit()
      await expect(store.dispatch(kind === "hint" ? { type: "hint.dismissed", actor: "user", id: "chat" } : {
        type: "card.upsert", actor: "user",
        card: {
          id: "rejected-card", kind: "flow-form", title: "Rejected form", status: "active", createdAt: 1, ordinal: 1,
          payload: { flow: "wiki.open", via: "user", fields: [], draft: {}, given: {} }
        }
      }).isPersisted.promise).rejects.toThrow("crash at the commit point")
      expect(recovery.getItem(ENTITY_RECOVERY_STORAGE_KEY)).toBeNull()
      host.heal()
      reopened = await createAppStore({ kind: "localStorage", storage: host })
      expect(reopened.collections.cards.get("rejected-card")).toBeUndefined()
      expect(reopened.session().hintsSeen ?? []).not.toContain("chat")
    } finally {
      await reopened?.dispose?.()
      await store?.dispose?.()
      if (priorWindow !== undefined) Object.defineProperty(globalThis, "window", priorWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  test("reopening releases an interrupted form submission and preserves its inputs", async () => {
    const host = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    await store.dispatch({
      type: "card.upsert", actor: "user",
      card: {
        id: "form-tab.harness", kind: "flow-form", title: "/tab.harness", status: "active", createdAt: 1, ordinal: 1,
        payload: { flow: "tab.harness", via: "user", fields: [], draft: { harnessId: "codex" }, given: {}, submitting: true }
      }
    }).isPersisted.promise
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    const card = reopened.collections.cards.get("form-tab.harness")
    expect(card?.status).toBe("error")
    expect(card?.payload).toMatchObject({ submitting: false, draft: { harnessId: "codex" }, error: expect.stringContaining("Check the result") })
    expect([...reopened.collections.transitions.values()].some((row) => row.type === "card.updated" && row.actor === "system")).toBe(true)
    const again = await createAppStore({ kind: "localStorage", storage: host })
    expect(again.collections.cards.get("form-tab.harness")?.payload).toMatchObject({ submitting: false })
  })

  test("a dispatch commits every projection or none", async () => {
    const host = crashableStorage()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    const transitionsBefore = store.collections.transitions.size
    const draftBefore = store.session().draft

    host.crashCommit()
    await expect(
      store.dispatch({ type: "composer.changed", actor: "user", draft: "half-written" }).isPersisted
        .promise
    ).rejects.toThrow()
    expect(store.session().draft).toBe(draftBefore)
    expect(store.collections.transitions.size).toBe(transitionsBefore)
    host.heal()

    // Reopening recovers by rolling the interrupted commit back: neither
    // the session projection (the draft) nor the transition record survived.
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    expect(reopened.session().draft).toBe(draftBefore)
    expect(reopened.collections.transitions.size).toBe(transitionsBefore)
  })

  test("a later successful dispatch cannot persist a failed transition from live state or an adapter cache", async () => {
    const host = crashableStorage()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    const initialRevision = store.session().revision
    const initialTransitions = store.collections.transitions.size
    host.crashCommit()
    await expect(store.dispatch({ type: "composer.changed", actor: "user", draft: "failed draft" }).isPersisted.promise).rejects.toThrow()
    expect(store.session().draft).toBe("")
    expect(store.session().revision).toBe(initialRevision)
    expect(store.collections.transitions.size).toBe(initialTransitions)
    host.heal()
    await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    expect(reopened.session().draft).toBe("")
    expect(reopened.session().theme).toBe("dark")
    expect([...reopened.collections.transitions.values()].slice(initialTransitions).map((row) => row.type)).toEqual(["theme.changed"])
  })

  test("a dispatch inside a failure handler cannot adopt a queued transaction still rolling back", async () => {
    const host = crashableStorage()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    const initialRevision = store.session().revision
    const initialTransitions = store.collections.transitions.size
    host.crashCommit()
    const first = store.dispatch({ type: "composer.changed", actor: "user", draft: "failed first" }).isPersisted.promise
    // A second keystroke would join the first draft's commit; a different transition queues its own.
    const second = store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const secondResult = second.catch(() => "rejected")
    const reentrant = first.catch(async () => {
      // The second optimistic projection has not rolled back yet.
      expect(store.session().theme).toBe("dark")
      host.heal()
      return store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    })
    await expect(reentrant).rejects.toThrow("state that did not persist")
    await secondResult
    expect(store.session().draft).toBe("")
    expect(store.session().revision).toBe(initialRevision)
    await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    expect(reopened.session().draft).toBe("")
    expect([...reopened.collections.transitions.values()].slice(initialTransitions).map((row) => row.type)).toEqual(["theme.changed"])
  })

  test("a dispatch whose commit lands persists every projection", async () => {
    const host = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "kept" }).isPersisted.promise
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    expect(reopened.session().draft).toBe("kept")
    expect(
      [...reopened.collections.transitions.values()].some((record) => record.type === "composer.changed")
    ).toBe(true)
  })
})

/** Counts localStorage commits: the backend writes the whole envelope once per durable transaction. */
const countingStorage = (): StorageApi & { readonly commits: () => number } => {
  const inner = memoryStorage()
  let commits = 0
  return {
    commits: () => commits,
    getItem: (key) => inner.getItem(key),
    setItem: (key, value) => {
      if (key === ENVELOPE_STORAGE_KEY) commits += 1
      inner.setItem(key, value)
    },
    removeItem: (key) => inner.removeItem(key)
  }
}

describe("composer drafts", () => {
  test("a pending draft with a verified prefix is admitted as a new event before boot exposure", async () => {
    const recovery = memoryStorage(), storage = memoryStorage()
    ;(globalThis as any).window = { localStorage: recovery, matchMedia: () => ({ matches: false }) }
    try {
      const first = await createAppStore({ kind: "localStorage", storage })
      const { head } = await first.eventHistory()
      await first.dispose?.()
      writeDraftRecovery(recovery, head.revision + 1, "pending input", {
        streamId: head.streamId, baseSequence: head.sequence, baseEventHash: head.eventHash, actor: "user",
        intentId: "pending-test", workspaceId: "workspace-main", branchId: "branch-main", conversationTabId: null
      })
      const reopened = await createAppStore({ kind: "localStorage", storage })
      expect(reopened.session().draft).toBe("pending input")
      const history = await reopened.eventHistory()
      expect(history.events.at(-1)).toMatchObject({ type: "composer.changed", actor: "user", streamId: head.streamId })
      expect((await reopened.verifyState()).valid).toBe(true)
      expect(recovery.getItem(DRAFT_RECOVERY_STORAGE_KEY)).toBeNull()
      await reopened.dispose?.()
    } finally { delete (globalThis as any).window }
  })

  for (const mismatch of ["stream", "prefix", "unscoped", "already-committed"] as const) test(`draft recovery refuses ${mismatch} input`, async () => {
    const recovery = memoryStorage(), storage = memoryStorage()
    ;(globalThis as any).window = { localStorage: recovery, matchMedia: () => ({ matches: false }) }
    try {
      const first = await createAppStore({ kind: "localStorage", storage })
      await first.dispatch({ type: "composer.changed", actor: "user", draft: "verified input" }).isPersisted.promise
      const { head } = await first.eventHistory()
      await first.dispose?.()
      writeDraftRecovery(recovery, head.revision + (mismatch === "already-committed" ? 0 : 1), "stale private input", mismatch === "unscoped" ? undefined : {
        streamId: mismatch === "stream" ? "retired-stream" : head.streamId, baseSequence: head.sequence,
        baseEventHash: mismatch === "prefix" ? "0".repeat(64) : head.eventHash, actor: "user",
        intentId: "pending-test", workspaceId: "workspace-main", branchId: "branch-main", conversationTabId: null
      })
      const reopened = await createAppStore({ kind: "localStorage", storage })
      expect(reopened.session().draft).toBe("verified input")
      expect((await reopened.eventHistory()).events.some(event => JSON.stringify(event.input).includes("stale private input"))).toBe(false)
      await reopened.dispose?.()
    } finally { delete (globalThis as any).window }
  })

  test("an explicitly refused draft commit clears its pending recovery input", async () => {
    const recovery = memoryStorage(), storage = crashableStorage()
    ;(globalThis as any).window = { localStorage: recovery, matchMedia: () => ({ matches: false }) }
    try {
      const store = await createAppStore({ kind: "localStorage", storage })
      storage.crashCommit()
      const transaction = store.dispatch({ type: "composer.changed", actor: "user", draft: "refused input" })
      expect(readDraftRecovery(recovery)?.draft).toBe("refused input")
      await expect(transaction.isPersisted.promise).rejects.toThrow()
      expect(recovery.getItem(DRAFT_RECOVERY_STORAGE_KEY)).toBeNull()
      storage.heal()
      await store.dispose?.()
    } finally { delete (globalThis as any).window }
  })

  test("the fallback recovery slot follows every edit in a coalesced batch", async () => {
    const recovery = memoryStorage()
    ;(globalThis as unknown as { window?: { readonly localStorage: StorageApi; readonly matchMedia: () => { readonly matches: boolean } } }).window = {
      localStorage: recovery,
      matchMedia: () => ({ matches: false })
    }
    try {
      const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
      const receipt = store.dispatch({ type: "composer.changed", actor: "user", draft: "first" }).isPersisted.promise
      expect(readDraftRecovery(recovery)?.draft).toBe("first")

      store.dispatch({ type: "composer.changed", actor: "user", draft: "first line\nsecond line" })
      expect(readDraftRecovery(recovery)?.draft).toBe("first line\nsecond line")
      store.dispatch({ type: "composer.changed", actor: "user", draft: "first line\nsecond line" })
      expect(readDraftRecovery(recovery)?.draft).toBe("first line\nsecond line")
      store.dispatch({ type: "composer.changed", actor: "user", draft: "" })
      expect(readDraftRecovery(recovery)?.draft).toBe("")

      await receipt
      expect(recovery.getItem(DRAFT_RECOVERY_STORAGE_KEY)).toBeNull()
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window
    }
  })

  test("a burst of keystrokes commits one envelope and journals only the final draft", async () => {
    const host = countingStorage()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    const before = host.commits()
    const text = "hello from a burst of keystrokes"
    const receipts = [...text].map((_, index) => {
      const receipt = store.dispatch({ type: "composer.changed", actor: "user", draft: text.slice(0, index + 1) }).isPersisted.promise
      // The draft is live at once; only its durable write waits.
      expect(store.session().draft).toBe(text.slice(0, index + 1))
      return receipt
    })
    await Promise.all(receipts)
    expect(host.commits() - before).toBe(1)
    const journaled = [...store.collections.transitions.values()].filter((record) => record.type === "composer.changed")
    expect(journaled.map((record) => JSON.parse(record.payload))).toEqual([{ draft: text }])
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    expect(reopened.session().draft).toBe(text)
  })

  test("the next dispatch commits a pending draft first", async () => {
    const host = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    const initialTransitions = store.collections.transitions.size
    store.dispatch({ type: "composer.changed", actor: "user", draft: "typed before the next act" })
    await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    expect(reopened.session().draft).toBe("typed before the next act")
    expect(reopened.session().theme).toBe("dark")
    expect([...reopened.collections.transitions.values()].slice(initialTransitions).map((record) => record.type)).toEqual(["composer.changed", "theme.changed"])
  })

  test("dispose commits a pending draft before releasing the store", async () => {
    const host = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    store.dispatch({ type: "composer.changed", actor: "user", draft: "typed just before closing" })
    await store.dispose?.()
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    expect(reopened.session().draft).toBe("typed just before closing")
  })
})

describe("overlapping OPFS dispatches", () => {
  for (const fails of [false, true]) {
    test(fails ? "a disk failure rejects overlapping dependent transitions and rolls back live state" : "each dispatch waits for its own separate SQLite commit", async () => {
      const template = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
      const specs = Object.values(template.collections).map((collection) => ({ id: collection.id, schema: collection.config.schema! }))
      const sqlite = new Database(":memory:")
      let pause = false
      let entered!: () => void
      let release!: () => void
      const blocked = new Promise<void>((resolve) => { entered = resolve })
      const gate = new Promise<void>((resolve) => { release = resolve })
      const committedRevisions: number[] = []
      const durableSession = () => JSON.parse((sqlite.query(`SELECT value FROM ${ROW_TABLE_NAME} WHERE collection_id = 'app-sessions'`).get() as { value: string }).value) as { revision: number; draft: string }
      const adapter = await openSqliteRowStorage({
        execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<TRow>> => {
          if (pause && sql === "BEGIN IMMEDIATE") {
            pause = false
            entered()
            await gate
            if (fails) throw new Error("disk unavailable")
          }
          const statement = sqlite.query(sql)
          if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<TRow>
          statement.run(...params as [])
          if (sql === "COMMIT" && sqlite.query(`SELECT value FROM ${ROW_TABLE_NAME} WHERE collection_id = 'app-sessions'`).get() !== null) committedRevisions.push(durableSession().revision)
          return []
        },
        close: () => sqlite.close()
      }, { collections: specs, schemaVersion: APP_SCHEMA_VERSION })
      const store = await createAppStore({ kind: "opfs", ...adapter, storageEventApi: { addEventListener: () => {}, removeEventListener: () => {} } })
      const initialRevision = durableSession().revision
      committedRevisions.length = 0
      pause = true
      let first = "pending", second = "pending"
      const firstPromise = store.dispatch({ type: "composer.changed", actor: "user", draft: "overlap" }).isPersisted.promise.then(() => { first = "resolved" }, () => { first = "rejected" })
      const secondPromise = store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise.then(() => { second = "resolved" }, () => { second = "rejected" })
      await blocked
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect([first, second]).toEqual(["pending", "pending"])
      expect(durableSession().revision).toBe(initialRevision)
      release()
      await Promise.all([firstPromise, secondPromise])
      expect([first, second]).toEqual(fails ? ["rejected", "rejected"] : ["resolved", "resolved"])
      expect(committedRevisions).toEqual(fails ? [] : [initialRevision + 1, initialRevision + 2])
      expect(store.session().revision).toBe(fails ? initialRevision : initialRevision + 2)
      expect(store.session().draft).toBe(fails ? "" : "overlap")
      expect(durableSession().revision).toBe(fails ? initialRevision : initialRevision + 2)
      await adapter.close().catch(() => {})
    })
  }
})

describe("retention bounds", () => {
  test("transitions compact to the newest 500 inside the appending transaction", async () => {
    const storage = memoryStorage()
    const seeded: TransitionRecord[] = Array.from({ length: MAX_TRANSITION_RECORDS + 10 }, (_, index) => ({
      id: `transition-seed-${index}`,
      revision: index + 1,
      actor: "user",
      type: "composer.changed",
      payload: "{}",
      createdAt: index + 1
    }))
    writeLegacyCollection(storage, "app-transitions", seeded)
    const store = await createAppStore({ kind: "localStorage", storage })
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "x" }).isPersisted.promise
    const remaining = [...store.collections.transitions.values()]
    expect(remaining.length).toBe(MAX_TRANSITION_RECORDS)
    expect(remaining.some((record) => record.id === "transition-seed-0")).toBe(false)
    expect(remaining.some((record) => record.id === `transition-seed-${MAX_TRANSITION_RECORDS + 9}`)).toBe(true)
  })

  test("tool-call records compact to the newest 250", async () => {
    const storage = memoryStorage()
    const seeded: ToolCallRecord[] = Array.from({ length: MAX_TOOL_CALL_RECORDS + 5 }, (_, index) => ({
      id: `toolcall-seed-${index}`,
      turnId: "turn",
      name: "tool",
      arguments: "{}",
      result: "ok",
      createdAt: index + 1
    }))
    writeLegacyCollection(storage, "app-tool-calls", seeded)
    const store = await createAppStore({ kind: "localStorage", storage })
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "x" }).isPersisted.promise
    const remaining = [...store.collections.toolCalls.values()]
    expect(remaining.length).toBe(MAX_TOOL_CALL_RECORDS)
    expect(remaining.some((record) => record.id === "toolcall-seed-0")).toBe(false)
    expect(remaining.some((record) => record.id === `toolcall-seed-${MAX_TOOL_CALL_RECORDS + 4}`)).toBe(true)
  })
})
