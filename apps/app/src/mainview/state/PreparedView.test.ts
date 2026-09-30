import { afterEach, expect, test } from "bun:test"
import { createAppStore, type AppStore } from "./AppStore"
import type { Card } from "./AppState"
import { preparedView, invalidatePreparedViews, disposePreparedViews, type ViewResult } from "./PreparedView"
import type { SeamContext } from "./seams/SeamContext"

// Controlled boundary units: Map storage and explicit read/HTTP doubles, not SQLite/network integration.
const closeStore = async (store: AppStore): Promise<void> => {
  if (store.dispose === undefined) throw new Error("Fixture store has no disposal contract")
  await store.dispose()
}
const stores: AppStore[] = []
const releaseReads: Array<() => void> = []
const work: Array<Promise<unknown>> = []
const tracked = <T>(promise: Promise<T>): Promise<T> => { work.push(promise); return promise }
const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Prepared-view fixture did not settle")), 3000)
    })])
  } finally { clearTimeout(timer) }
}
afterEach(async () => {
  const errors: unknown[] = []
  // Fence owners while they are open, then release and drain every pending read before storage closes.
  for (const store of stores) disposePreparedViews(store)
  for (const release of releaseReads.splice(0)) release()
  try {
    const results = await bounded(Promise.allSettled(work.splice(0)))
    for (const result of results) if (result.status === "rejected") errors.push(result.reason)
  } catch (error) { errors.push(error) }
  finally {
    for (const store of stores.splice(0)) {
      try { await closeStore(store) } catch (error) { errors.push(error) }
    }
  }
  if (errors.length) throw new AggregateError(errors, "Prepared-view fixture cleanup failed")
})
async function setup() {
  const values = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  } })
  stores.push(store)
  const ctx: SeamContext = { store, dispatch: store.dispatch, baseUrl: "", actor: () => "user", nextOrdinal: store.nextOrdinal, http: async () => { throw Error("Unexpected request") } }
  return { store, ctx }
}
const data = (id: string): ViewResult => ({ card: { id, kind: "status", title: id, status: "acted", createdAt: 1, ordinal: 1, payload: { note: id } }, value: id })
function deferred<T>(cleanup: T) {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  releaseReads.push(() => resolve(cleanup))
  return { promise, resolve }
}

test("hover and click share the whole read, with no card or history until activation", async () => {
  const { ctx, store } = await setup()
  const read = deferred<ViewResult>(data("cleanup"))
  let calls = 0
  const open = preparedView(ctx, () => ({ id: "a", title: "A", read: () => { calls++; return read.promise } }))
  const warming = tracked(open.preload())
  await Promise.resolve()
  expect(calls).toBe(1)
  expect(store.collections.cards.size).toBe(0)
  const pending = tracked(open())
  expect(store.collections.cards.get("a")?.loading).toBe(true)
  read.resolve(data("a"))
  await Promise.all([warming, pending])
  expect(calls).toBe(1)
  expect(store.collections.cards.get("a")).toMatchObject({ title: "a", loading: false })
  expect(store.collections.cards.size).toBe(1)
})

test("a later navigation wins and frame history retains loaded destinations", async () => {
  const { ctx, store } = await setup()
  const home: Card = { id: "home", kind: "issue-list", title: "Issues", status: "active", ordinal: 1, createdAt: 1, payload: { repo: "will/demo", filter: "open", issues: [] } }
  store.dispatch({ type: "card.upsert", actor: "user", card: home })
  const a = deferred<ViewResult>(data("cleanup")), b = deferred<ViewResult>(data("cleanup"))
  const open = preparedView(ctx, (id: string) => ({ id, title: id, pane: "will/demo", read: () => id === "a" ? a.promise : b.promise }))
  const first = tracked(open("a")), second = tracked(open("b"))
  expect(store.collections.cards.get("home")).toMatchObject({ title: "b", loading: true })
  b.resolve(data("b")); await second
  a.resolve(data("a")); await first
  expect(store.collections.cards.get("home")).toMatchObject({ title: "b", loading: false })
  expect(store.collections.cards.size).toBe(1)
  const entries = store.collections.cardHistories.get("home")!.entries
  expect(entries.at(-1)).toMatchObject({ title: "b", loading: false })
})

test("failed preloads are silent and activation retries", async () => {
  const { ctx, store } = await setup()
  let calls = 0
  const open = preparedView(ctx, () => ({ id: "a", title: "A", read: async () => ++calls === 1 ? "Offline" : data("a") }))
  await open.preload()
  expect(store.collections.cards.size).toBe(0)
  expect(await open()).toEqual({ value: "a" })
  expect(calls).toBe(2)
})

test("a failed pane destination stays visible and Back retains its source", async () => {
  const { ctx, store } = await setup()
  const home: Card = { id: "home", kind: "issue-list", title: "Issues", status: "active", ordinal: 1, createdAt: 1, payload: { repo: "will/demo", filter: "open", issues: [] } }
  store.dispatch({ type: "card.upsert", actor: "user", card: home })
  const open = preparedView(ctx, () => ({ id: "missing", title: "Missing", pane: "will/demo", read: async () => "Not found" }))

  expect(await open()).toBe("Not found")
  expect(store.collections.cards.get("home")).toMatchObject({ status: "error", body: "Not found", loading: false })
  expect(store.collections.cardHistories.get("home")).toMatchObject({ index: 1 })
  store.dispatch({ type: "card.history.moved", actor: "user", id: "home", delta: -1 })
  expect(store.collections.cards.get("home")).toMatchObject({ title: "Issues", kind: "issue-list" })
})

test("Back stays put while a pending destination finishes, and Forward shows its loaded content", async () => {
  const { ctx, store } = await setup()
  const home: Card = { id: "home", kind: "issue-list", title: "Issues", status: "active", ordinal: 1, createdAt: 1, payload: { repo: "will/demo", filter: "open", issues: [] } }
  store.dispatch({ type: "card.upsert", actor: "user", card: home })
  const read = deferred<ViewResult>(data("cleanup"))
  const open = preparedView(ctx, () => ({ id: "detail", title: "Detail", pane: "will/demo", read: () => read.promise }))
  const pending = tracked(open())
  store.dispatch({ type: "card.history.moved", actor: "user", id: "home", delta: -1 })
  expect(store.collections.cards.get("home")?.title).toBe("Issues")
  expect(store.collections.cards.get("home")?.loading).toBeUndefined()
  read.resolve(data("Detail"))
  await pending
  expect(store.collections.cards.get("home")?.title).toBe("Issues")
  store.dispatch({ type: "card.history.moved", actor: "user", id: "home", delta: 1 })
  expect(store.collections.cards.get("home")).toMatchObject({ title: "Detail", loading: false })
})

test("disposing a controller prevents its late result from updating a view", async () => {
  const { ctx, store } = await setup()
  const read = deferred<ViewResult>(data("cleanup"))
  const open = preparedView(ctx, () => ({ id: "a", title: "Loading", read: () => read.promise }))
  const pending = tracked(open())
  disposePreparedViews(store)
  read.resolve(data("old")); await pending
  expect(store.collections.cards.get("a")?.title).toBe("Loading")
})

test("speculative reads are bounded while a click can still load its destination", async () => {
  const { ctx } = await setup()
  const read = deferred<ViewResult>(data("cleanup"))
  let calls = 0
  const open = preparedView(ctx, (id: string) => ({ id, title: id, read: () => { calls++; return read.promise } }))
  const warming = ["a", "b", "c", "d", "e"].map(id => tracked(open.preload(id)))
  await Promise.resolve()
  expect(calls).toBe(4)
  const pending = tracked(open("e"))
  await Promise.resolve(); await Promise.resolve()
  expect(calls).toBe(5)
  read.resolve(data("loaded"))
  await Promise.all([...warming, pending])
})

test("invalidating an in-flight preload prevents reuse after a mutation", async () => {
  const { ctx, store } = await setup()
  const old = deferred<ViewResult>(data("cleanup"))
  let calls = 0
  const open = preparedView(ctx, () => ({ id: "a", title: "A", read: () => ++calls === 1 ? old.promise : Promise.resolve(data("new")) }))
  const warming = tracked(open.preload())
  await Promise.resolve()
  invalidatePreparedViews(store)
  await open()
  old.resolve(data("old")); await warming
  expect(store.collections.cards.get("a")?.title).toBe("new")
  expect(calls).toBe(2)
})

test("changing repository while loading never publishes the old result", async () => {
  const { ctx, store } = await setup()
  const read = deferred<ViewResult>(data("cleanup"))
  const open = preparedView(ctx, () => ({ id: "a", title: "A", read: () => read.promise }))
  const pending = tracked(open())
  store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "will/other", org: "will", ownerKind: "user", name: "other", head: null }] })
  store.dispatch({ type: "repo.selected", actor: "user", id: "will/other" })
  read.resolve(data("old")); await pending
  expect(store.collections.cards.get("a")?.title).not.toBe("old")
  expect(store.collections.cards.get("a")).toMatchObject({ loading: false, status: "error" })
})

test("preloading never provisions a workspace, and an error remains retryable", async () => {
  const { ctx, store } = await setup()
  let provisions = 0, reads = 0
  const open = preparedView(ctx, () => ({ id: "a", title: "A", before: async () => { provisions++ }, read: async () => ++reads < 2 ? "Offline" : data("a") }))
  await open.preload()
  expect(provisions).toBe(0)
  expect(await open()).toEqual({ value: "a" })
  expect(provisions).toBe(1)
  expect(store.collections.cards.get("a")?.loading).toBe(false)
})


test("a late view result cannot read a closed owner or restart disposed preloads", async () => {
  const { ctx, store } = await setup()
  const read = deferred<ViewResult>(data("cleanup"))
  const started = deferred<void>(undefined)
  let resolves = 0, reads = 0
  const open = preparedView(ctx, () => {
    resolves++
    return { id: "a", title: "Loading", read: () => { reads++; started.resolve(undefined); return read.promise } }
  })
  const pending = tracked(open())
  await bounded(started.promise)
  expect(reads).toBe(1)
  disposePreparedViews(store)
  await closeStore(store)
  read.resolve(data("late"))
  await expect(pending).resolves.toBeUndefined()
  await expect(open.preload()).resolves.toBeUndefined()
  await expect(open()).resolves.toBeUndefined()
  expect(resolves).toBe(1)
  expect(reads).toBe(1)
})

test("a cloud session change retires a held prepared view", async () => {
  const { ctx, store } = await setup()
  store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "alice", expiresAt: null, scopes: null })
  const read = deferred<ViewResult>(data("cleanup"))
  const open = preparedView(ctx, () => ({ id: "private", title: "Loading", read: () => read.promise }))
  const pending = tracked(open())
  store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "bob", expiresAt: null, scopes: null })
  read.resolve(data("old private card"))
  await pending
  expect(store.collections.cards.get("private")?.title).not.toBe("old private card")
})

test("same-owner session refresh preserves a held prepared view", async () => {
  const { ctx, store } = await setup()
  const identity = { type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", allowlisted: true, admin: false, scopesPlain: null } as const
  const cloud = { type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "alice", expiresAt: null, scopes: null } as const
  await store.dispatch(identity).isPersisted.promise
  await store.dispatch(cloud).isPersisted.promise
  const read = deferred<ViewResult>(data("cleanup"))
  const open = preparedView(ctx, () => ({ id: "private", title: "Loading", read: () => read.promise }))
  const pending = tracked(open())
  await store.dispatch(identity).isPersisted.promise
  await store.dispatch(cloud).isPersisted.promise
  read.resolve(data("private"))
  await pending
  expect(store.collections.cards.get("private")?.title).toBe("private")
})
