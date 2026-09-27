import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import type { StorageApi } from "@tanstack/db"
import { Database } from "bun:sqlite"
import { describe,expect,test } from "bun:test"
import { APP_SCHEMA_VERSION } from "../../chain/SchemaVersion"
import { openSqliteRowStorage,ROW_TABLE_NAME } from "../../chain/SqliteRowStorage"
import { ENVELOPE_STORAGE_KEY } from "../../chain/TransactionalStorage"
import type { FrameHistoryPort } from "../../runtime/FrameHistory"
import { parseFramePath } from "../../runtime/FrameHistory"
import { DEFAULT_BRANCH_ID,DEFAULT_WORKSPACE_ID,MessageSchema,rootFrameId,WorldDocumentSchema } from "../AppState"
import type { AppStore } from "../AppStore"
import { createAppStore, PERSISTED_COLLECTION_SPECS } from "../AppStore"
import { archiveNotice } from "../ConversationArchive"
import { writeLegacyCollection } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createFailureController } from "./failures"
import { createWorldController } from "./world"

const host = () => {
  const rows = new Map<string, string>()
  let fail = false
  return {
    arm: () => {
      fail = true
    },
    heal: () => {
      fail = false
    },
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (fail && key === ENVELOPE_STORAGE_KEY) throw new Error("injected commit failure")
      rows.set(key, value)
    },
    removeItem: (key: string) => {
      rows.delete(key)
    }
  } satisfies StorageApi & { arm: () => void; heal: () => void }
}
const note = { title: "A/B", body: "New fact linking [[Other]].", confidence: 0.7 }
const response = (notes: unknown = [note]) =>
  new Response(
    [
      { type: "delta", kind: "text", text: JSON.stringify({ notes }) },
      { type: "done", reason: "stop" }
    ].map((frame) => JSON.stringify(frame)).join("\n") + "\n"
  )

/* Summarizing into Wiki notes is the opt-in half of chat.clear (state/KnowledgeFeatures.ts), so the fixture turns it on. */
const attachWorld = (
  store: AppStore,
  fetchImpl: FetchLike,
  cancelTurn: (id: string) => Promise<void> = async () => {},
  frameHistory?: FrameHistoryPort
) => {
  const ctx = createControllerContext(store, {
    available: false,
    startTurn: async () => ({ status: "error", message: "unavailable" }),
    cancelTurn,
    subscribe: () => () => {}
  }, { fetchImpl, frameHistory })
  ctx.withToast = createFailureController(ctx).withToast
  ctx.contextMessages = () =>
    [...store.collections.messages.values()].map((message) => ({
      role: message.role === "smithers" ? "assistant" : "user",
      content: message.text
    }))
  const world = createWorldController(ctx, { nextOrdinal: () => 0 })
  return { ctx, world }
}

const fixture = async (
  fetchImpl: FetchLike = async () => {
    throw new Error("No network allowed")
  },
  cancelTurn: (id: string) => Promise<void> = async () => {},
  frameHistory?: FrameHistoryPort
) => {
  const storage = host()
  const store = await createAppStore({ kind: "localStorage", storage })
  const { ctx, world } = attachWorld(store, fetchImpl, cancelTurn, frameHistory)
  await store.dispatch({ type: "message.appended", actor: "system", text: "Keep this original conversation" })
    .isPersisted.promise
  return { storage, store, ctx, world }
}
const signIn = (store: AppStore) =>
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  }).isPersisted.promise
const state = (store: AppStore) => ({
  session: store.session(),
  messages: [...store.collections.messages.values()],
  cards: [...store.collections.cards.values()],
  notes: [...store.collections.worldDocuments.values()],
  branches: [...store.collections.branches.values()],
  frames: [...store.collections.frames.values()]
})

describe("local archive and append-only summary notes", () => {
  test("a browser-history failure cannot turn a committed archive into a reported save failure", async () => {
    const { store, world, ctx } = await fixture(undefined, undefined, {
      current: () => undefined,
      replace: () => {
        throw new Error("history unavailable")
      },
      push: () => {},
      back: () => {},
      forward: () => {},
      subscribe: () => () => {}
    })
    expect(await world.clearConversation()).toBeUndefined()
    expect(store.collections.branches.size).toBe(2)
    expect(
      [...store.collections.messages.values()].some((row) =>
        row.text.includes("archive was saved, but browser history")
      )
    ).toBe(true)
    ctx.dispose()
  })

  test("memory-only archive notices explicitly disclose their lifetime", () => {
    expect(archiveNotice(0, "/old-conversation", true)).toContain("only available until this session closes")
    expect(archiveNotice(0, "/old-conversation", false)).not.toContain("local storage is unavailable")
  })

  for (const hasResponse of [false, true]) {
    test(`an archived live turn is marked interrupted with hasResponse=${hasResponse}`, async () => {
      const cancelled: string[] = []
      const { store, world, ctx } = await fixture(undefined, async (id) => {
        cancelled.push(id)
      })
      await store.dispatch({ type: "message.submitted", actor: "user", text: "In progress", turnId: "old" }).isPersisted
        .promise
      if (hasResponse) {
        await store.dispatch({
          type: "message.response.delta",
          actor: "smithers",
          turnId: "old",
          channel: "text",
          delta: "Partial answer"
        }).isPersisted.promise
      }
      ctx.activeTurn = {
        id: "old",
        receivedText: hasResponse,
        toolLegs: 0,
        toolItems: [],
        pendingCall: undefined,
        runLaunch: undefined,
        askClass: undefined,
        claimBuffer: ""
      }
      expect(await world.clearConversation()).toBeUndefined()
      expect(cancelled).toEqual(["old"])
      expect(ctx.activeTurn).toBeUndefined()
      const archived = store.collections.branches.get(DEFAULT_BRANCH_ID)?.snapshot?.messages.find((row) =>
        row.id === "message-old-smithers"
      )
      expect(archived?.status).toBe("interrupted")
      if (hasResponse) expect(archived?.text).toBe("Partial answer")
      expect(store.session().phase).toBe("idle")
      expect([...store.collections.messages.values()]).toHaveLength(1)
      ctx.dispose()
    })
  }

  test("settling an archive cannot detach a newer turn or stop its observers", async () => {
    let duringCancel = async () => {}
    const { store, world, ctx } = await fixture(undefined, async () => duringCancel())
    const old = {
      id: "old",
      receivedText: false,
      toolLegs: 0,
      toolItems: [],
      pendingCall: undefined,
      runLaunch: undefined,
      askClass: undefined,
      claimBuffer: ""
    }
    ctx.activeTurn = old
    const oldPump = { stopped: false }
    const newPump = { stopped: false }
    ctx.runPumps.set("old-card", oldPump)
    let newCommit: Promise<unknown> | undefined
    duringCancel = async () => {
      ctx.activeTurn = { ...old, id: "new" }
      ctx.runPumps.set("new-card", newPump)
      newCommit = store.dispatch({ type: "message.submitted", actor: "user", turnId: "new", text: "Next conversation" })
        .isPersisted.promise
      await newCommit
    }
    expect(await world.clearConversation()).toBeUndefined()
    await newCommit
    expect(ctx.activeTurn?.id).toBe("new")
    expect(store.session().phase).toBe("responding")
    expect(ctx.runPumps.get("new-card")).toBe(newPump)
    expect(newPump.stopped).toBe(false)
    expect(oldPump.stopped).toBe(true)
    ctx.dispose()
  })

  test("oversized summaries name the limit and leave plain clear available", async () => {
    const { store, world, ctx } = await fixture()
    await signIn(store)
    await store.dispatch({ type: "message.appended", actor: "system", text: "x".repeat(800_000) }).isPersisted.promise
    expect(await world.clearConversation({ summarize: true })).toContain("768 KiB request limit")
    expect(store.collections.branches.size).toBe(1)
    expect(await world.clearConversation()).toBeUndefined()
    ctx.dispose()
  })

  for (const signedIn of [false, true]) {
    test(`clear is local with signedIn=${signedIn}, even for a huge transcript`, async () => {
      let calls = 0
      const { store, world, ctx, storage } = await fixture(async () => {
        calls++
        throw new Error("offline")
      })
      if (signedIn) await signIn(store)
      await store.dispatch({ type: "message.appended", actor: "system", text: "x".repeat(1_100_000) }).isPersisted
        .promise
      await store.dispatch({ type: "composer.changed", actor: "user", draft: "Unsent draft" }).isPersisted.promise
      const before = state(store)
      expect(await world.clearConversation()).toBeUndefined()
      expect(calls).toBe(0)
      const message = [...store.collections.messages.values()][0]!
      const location = parseFramePath(/\]\(([^)]+)\)/.exec(message.text)![1]!)!
      expect(location.branchId).toBe(DEFAULT_BRANCH_ID)
      expect(store.collections.branches.get(DEFAULT_BRANCH_ID)?.snapshot?.messages).toEqual(
        before.messages.map((row) => MessageSchema.parse(row))
      )
      expect(store.collections.branches.get(DEFAULT_BRANCH_ID)?.snapshot?.draft).toBe("Unsent draft")
      const reopened = await createAppStore({ kind: "localStorage", storage })
      await reopened.dispatch({ type: "frame.navigated", actor: "user", ...location }).isPersisted.promise
      expect([...reopened.collections.messages.values()]).toEqual(before.messages)
      expect(reopened.session().draft).toBe("Unsent draft")
      ctx.dispose()
    })
  }

  test("colliding titles preserve original bodies, identities, attribution and revisions", async () => {
    const { store, world, ctx } = await fixture(async () =>
      response([note, { ...note, title: "A:B" }, { ...note, title: "a-b" }])
    )
    await signIn(store)
    await store.dispatch({
      type: "world.document.upserted",
      actor: "user",
      document: {
        id: "user-note",
        path: "Chat notes/Note - A-B.md",
        title: "A-B",
        body: "Do not overwrite",
        links: [],
        tags: ["mine"],
        sources: ["user:world-editor"],
        confidence: 1
      }
    }).isPersisted.promise
    const before = store.collections.worldDocuments.get("user-note")
    expect(await world.clearConversation({ summarize: true })).toBeUndefined()
    expect(store.collections.worldDocuments.get("user-note")).toEqual(before)
    const notes = [...store.collections.worldDocuments.values()].filter((row) => row.sources.includes("chat-sweep"))
    expect(notes).toHaveLength(3)
    expect(new Set(notes.map((row) => row.path.toLowerCase())).size).toBe(3)
    expect(notes.every((row) => row.path !== before?.path)).toBe(true)
    expect(notes.every((row) => !row.sources.includes("user:world-editor") && row.updatedBy === "smithers")).toBe(true)
    expect(notes.every((row) => row.links.includes("Other"))).toBe(true)
    const commit = [...store.collections.transitions.values()].find((row) => row.type === "conversation.cleared")!
    expect(notes.every((row) => row.revision === commit.revision)).toBe(true)
    expect(
      store.collections.branches.get(DEFAULT_BRANCH_ID)?.snapshot?.worldDocuments.find((row) => row.id === "user-note")
    ).toEqual(WorldDocumentSchema.parse(before))
    ctx.dispose()
  })

  test("a concurrent user note edit is preserved, and a toast does not invalidate the summary", async () => {
    let finish!: (response: Response) => void
    const { store, world, ctx } = await fixture(async () =>
      new Promise<Response>((resolve) => {
        finish = resolve
      })
    )
    await signIn(store)
    const pending = world.clearConversation({ summarize: true })
    await store.dispatch({
      type: "world.document.upserted",
      actor: "user",
      document: {
        id: "concurrent",
        path: "Chat notes/Note - A-B.md",
        title: "A-B",
        body: "New user edit",
        links: [],
        tags: [],
        sources: ["user:world-editor"],
        confidence: 1
      }
    }).isPersisted.promise
    await store.dispatch({ type: "toast.shown", actor: "system", key: "chat.clear", title: "Summarizing" }).isPersisted
      .promise
    finish(response())
    expect(await pending).toBeUndefined()
    expect(store.collections.worldDocuments.get("concurrent")?.body).toBe("New user edit")
    ctx.dispose()
  })

  for (const change of ["message", "draft", "identity", "dispose"] as const) {
    test(`${change} while summarizing prevents a stale clear`, async () => {
      let finish!: (response: Response) => void
      const { store, world, ctx } = await fixture(async () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        })
      )
      await signIn(store)
      const pending = world.clearConversation({ summarize: true })
      if (change === "message") {
        await store.dispatch({ type: "message.appended", actor: "system", text: "New message" }).isPersisted.promise
      }
      if (change === "draft") {
        await store.dispatch({ type: "composer.changed", actor: "user", draft: "New draft" }).isPersisted.promise
      }
      if (change === "identity") {
        await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other",
          allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
      }
      if (change === "dispose") ctx.dispose()
      const before = state(store)
      finish(response())
      expect(typeof await pending).toBe("string")
      // A failed request is visible even when it settles before debounce;
      // only its toast transitions may advance the session revision.
      expect(state(store)).toEqual({ ...before, session: { ...before.session,
        revision: before.session.revision + (change === "dispose" ? 0 : 2) } })
      if (change !== "dispose") expect(store.collections.toasts.get("toast-chat.clear")?.status).toBe("failed")
      ctx.dispose()
    })
  }

  test("a re-probe naming the same owner while summarizing still clears", async () => {
    let finish!: (response: Response) => void
    const { store, world, ctx } = await fixture(async () => new Promise<Response>((resolve) => { finish = resolve }))
    await signIn(store)
    const pending = world.clearConversation({ summarize: true })
    await signIn(store)
    finish(response())
    expect(await pending).toBeUndefined()
    ctx.dispose()
  })

  test("local clear supersedes a hanging summary without waiting for the provider", async () => {
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const { store, world, ctx } = await fixture(async () => {
      started()
      return new Promise<Response>(() => {})
    })
    await signIn(store)
    const summary = world.clearConversation({ summarize: true })
    await ready
    expect(await world.clearConversation()).toBeUndefined()
    expect(typeof await summary).toBe("string")
    expect(store.collections.branches.size).toBe(2)
    expect([...store.collections.worldDocuments.values()].some((row) => row.sources.includes("chat-sweep"))).toBe(false)
    ctx.dispose()
  })

  test("invalid partial summary saves nothing and local clear remains available", async () => {
    const { store, world, ctx } = await fixture(async () => response([note, { title: "partial" }]))
    await signIn(store)
    const before = state(store)
    expect(await world.clearConversation({ summarize: true })).toContain("nothing was cleared or saved")
    expect(state(store)).toEqual({ ...before, session: { ...before.session, revision: before.session.revision + 2 } })
    expect(store.collections.toasts.get("toast-chat.clear")?.status).toBe("failed")
    expect(await world.clearConversation()).toBeUndefined()
    ctx.dispose()
  })
})

describe("one archive transaction across SQLite projections", () => {
  for (const fails of [false, true]) {
    test(`notes, archive, frames and clear ${fails ? "roll back" : "commit"} together`, async () => {
      const specs = PERSISTED_COLLECTION_SPECS
      const sqlite = new Database(":memory:")
      const adapter = await openSqliteRowStorage({
        execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<TRow>> => {
          const query = sqlite.query(sql)
          if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return query.all(...params as []) as ReadonlyArray<TRow>
          query.run(...params as [])
          return []
        },
        close: () => sqlite.close()
      }, { collections: specs, schemaVersion: APP_SCHEMA_VERSION })
      const source = {
        kind: "opfs" as const,
        ...adapter,
        storageEventApi: { addEventListener: () => {}, removeEventListener: () => {} }
      }
      // This row belongs to a pre-journal conversation tab. Import it before
      // opening the authority, rather than bypassing a live transition stream.
      writeLegacyCollection(adapter.storage, "app-messages", [MessageSchema.parse({
        id: "legacy",
        role: "user",
        text: "Legacy conversation",
        status: "complete",
        createdAt: 0,
        ordinal: 0,
        tabId: "legacy-tab"
      })])
      await adapter.flush()
      const store = await createAppStore(source)
      await store.dispatch({ type: "message.appended", actor: "system", text: "Original" }).isPersisted.promise
      await store.dispatch({
        type: "card.upsert",
        actor: "user",
        card: {
          id: "original-card",
          kind: "status",
          title: "Original",
          status: "active",
          ordinal: 1,
          createdAt: 1,
          payload: {}
        }
      }).isPersisted.promise
      const before = state(store)
      const persistedBefore = sqlite.query(`SELECT * FROM ${ROW_TABLE_NAME} ORDER BY collection_id, row_key`).all()
      if (fails) {
        sqlite.exec(
          `CREATE TEMP TRIGGER fail_clear BEFORE DELETE ON ${ROW_TABLE_NAME} WHEN OLD.collection_id = 'app-messages' BEGIN SELECT RAISE(ABORT, 'injected clear failure'); END`
        )
      }
      const commit =
        store.dispatch({ type: "conversation.cleared", actor: "user", branchId: "new-conversation", notes: [note] })
          .isPersisted.promise
      if (fails) {
        await expect(commit).rejects.toThrow()
        expect(state(store)).toEqual(before)
        expect(sqlite.query(`SELECT * FROM ${ROW_TABLE_NAME} ORDER BY collection_id, row_key`).all()).toEqual(
          persistedBefore
        )
      } else {
        await commit
        expect(store.collections.messages.get("legacy")?.text).toBe("Legacy conversation")
        const reopened = await createAppStore(source)
        expect(reopened.session().activeBranchId).toBe("new-conversation")
        await reopened.dispatch({
          type: "frame.navigated",
          actor: "user",
          workspaceId: DEFAULT_WORKSPACE_ID,
          branchId: DEFAULT_BRANCH_ID,
          frameId: rootFrameId(DEFAULT_BRANCH_ID)
        }).isPersisted.promise
        expect([...reopened.collections.messages.values()]).toEqual(before.messages)
        expect([...reopened.collections.cards.values()]).toEqual(before.cards)
        expect([...reopened.collections.worldDocuments.values()]).toEqual(before.notes)
      }
      if (fails) await expect(adapter.close()).rejects.toThrow("injected clear failure")
      else await adapter.close()
    })
  }
})
