import { nameOf } from "../flows/registry"
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import type { MythicalItem, MythicalStack, MythicalWiki } from "@smthrs/rpc/Mythical"
import { createAppStore, PERSISTED_COLLECTION_SPECS } from "./AppStore"
import type { AppStore } from "./AppStore"
import { APP_SCHEMA_VERSION } from "../chain/SchemaVersion"
import { openSqliteRowStorage } from "../chain/SqliteRowStorage"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, signupProfileFetch, unavailableAgent, waitFor } from "./TestFixtures"

/*
 * The Stack card through the controller (#1745, #1760): the snapshot read and
 * its live hints, the lane notices, and the admin writes, each acknowledged
 * before its request resolves and settled only by the real answer.
 */

const createAppController = scopedControllers()
const REPO = "smithersai/smithers"
const BASE = "/api/repos/smithersai/smithers/mythical"
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

const item = (id: string, state: MythicalItem["state"], extra: Partial<MythicalItem> = {}): MythicalItem => ({
  id, state, attempt: 1, runs: {}, dependsOn: [], updatedAt: "2026-09-25T10:00:00Z",
  issue: { number: Number(id.replace(/\D/g, "")) || 1, title: `Issue ${id}`, url: `https://github.com/${REPO}/issues/${id}` },
  ...extra
})
const snapshot = (generation: number, items: MythicalItem[], extra: Partial<MythicalStack> = {}): MythicalStack => ({
  repository: REPO, state: "active", generation, mainBehind: false, changes: [], items,
  lanes: [{ index: 0, state: items.some(row => row.lane === 0) ? "busy" : "idle" }, { index: 1, state: "idle" }],
  limits: { maxParallel: 2 }, ...extra
})

/** A fake Smithers Cloud: the snapshot it serves, an event stream the test pushes hints into, and a log of writes. */
const cloud = () => {
  let current: MythicalStack = snapshot(1, [])
  const writes: Array<{ method: string; path: string; body: string }> = []
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const handlers = new Map<string, (body: string) => Promise<Response>>()
  let reads = 0
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url), "https://test.invalid").pathname
    const method = init?.method ?? "GET"
    if (path === `${BASE}/events`) {
      const body = new ReadableStream<Uint8Array>({ start: controller => { streams.add(controller) } })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    if (path === BASE && method === "GET") { reads += 1; return Response.json(current) }
    if (path.startsWith(BASE)) {
      const body = typeof init?.body === "string" ? init.body : ""
      writes.push({ method, path, body })
      const handler = handlers.get(`${method} ${path}`)
      if (handler) return handler(body)
      return Response.json(current, { status: 202 })
    }
    return Response.json([])
  }
  // The sign-in's signup-profile read answers as the backend does for a new account.
  const profile = signupProfileFetch(fetchImpl)
  return {
    fetchImpl: profile.fetchImpl,
    profileReads: profile.reads,
    writes,
    handlers,
    reads: () => reads,
    set: (next: MythicalStack) => { current = next },
    hint: (generation: number) => {
      const frame = new TextEncoder().encode(`event: mythical\ndata: {"generation":${generation},"kind":"item"}\n\n`)
      for (const stream of streams) stream.enqueue(frame)
    },
    streams: () => streams.size
  }
}

const signIn = (store: AppStore) =>
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise

const setup = async (fake = cloud(), store?: AppStore, toastDebounceMs = 20) => {
  const opened = store ?? await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(opened, unavailableAgent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
    fetchImpl: fake.fetchImpl,
    toastDebounceMs
  })
  await signIn(opened)
  return { store: opened, controller, fake }
}
const itemKey = (id: string) => `stack.item.${encodeURIComponent(REPO)}#${id}`
const toast = (store: AppStore, key: string) => store.collections.toasts.get(`toast-${key}`)
const stackCard = (store: AppStore) => {
  const card = store.collections.cards.get(`stack:${REPO}`)
  return card?.kind === "stack" ? card : undefined
}

test("history.show embeds the live stack and every hint re-reads the snapshot", async () => {
  const { store, controller, fake } = await setup()
  fake.set(snapshot(3, [item("i7", "queued")]))
  const shown = await controller.commands.run("history.show", REPO)
  expect(shown).toMatchObject({ status: "executed" })
  expect(shown.status === "executed" && shown.value).toContain("0/2 lanes busy, 1 queued")
  expect(stackCard(store)?.payload).toEqual({ repo: REPO, failure: null })
  expect(controller.stackSnapshots.get(REPO)?.stack?.generation).toBe(3)
  // The card holds no snapshot: the journal never carries the stack itself.
  expect(JSON.stringify([...store.collections.transitions.values()])).not.toContain("dependsOn")

  await waitFor(() => fake.streams() === 1)
  fake.set(snapshot(3, [item("i7", "running", { lane: 0 })]))
  fake.hint(3)
  await waitFor(() => controller.stackSnapshots.get(REPO)?.stack?.items[0]?.state === "running")

  // An older generation is a stale answer and never replaces a newer one.
  fake.set(snapshot(2, [item("i7", "queued")]))
  const reads = fake.reads()
  fake.hint(2)
  await waitFor(() => fake.reads() > reads, 3_000)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(controller.stackSnapshots.get(REPO)?.stack?.items[0]?.state).toBe("running")
})


test("lane notices start after the debounce, follow rebases and legacy retry data, and settle only on a real outcome", async () => {
  const { store, controller, fake } = await setup()
  fake.set(snapshot(1, [item("i1", "queued"), item("i2", "queued")]))
  await controller.commands.run("history.show", REPO)
  await waitFor(() => fake.streams() === 1)
  const one = itemKey("i1")
  const two = itemKey("i2")

  fake.set(snapshot(1, [item("i1", "running", { lane: 0 }), item("i2", "running", { lane: 1 })]))
  fake.hint(1)
  await waitFor(() => toast(store, one)?.status === "running" && toast(store, two)?.status === "running")
  expect(toast(store, one)).toMatchObject({ title: "#1 Issue i1", detail: "implementing" })

  fake.set(snapshot(1, [item("i1", "integrating", { lane: 0 }),
    item("i2", "retrying", { lane: 1, integration: { conflict: { paths: ["src/a.ts"] } } })]))
  fake.hint(1)
  await waitFor(() => toast(store, one)?.detail === "rebasing" && toast(store, two)?.detail === "retrying · src/a.ts")
  expect(toast(store, two)?.status).toBe("running")

  fake.set(snapshot(2, [
    item("i1", "proposed", { checks: { state: "passed", failed: [] }, pullRequest: { number: 40, url: "https://github.com/pr/40", state: "open" } }),
    item("i2", "blocked", { reason: "3 attempts conflicted" })
  ]))
  fake.hint(2)
  await waitFor(() => toast(store, one)?.status === "ok" && toast(store, two)?.status === "failed")
  expect(toast(store, one)).toMatchObject({ title: "#1 Issue i1", detail: "PR #40" })
  expect(toast(store, two)).toMatchObject({ detail: "blocked · 3 attempts conflicted" })
})

test("an item that leaves its lane inside the debounce never flashes a notice", async () => {
  // Reads are at least a second apart, so the debounce here outlasts one.
  const { store, controller, fake } = await setup(cloud(), undefined, 5_000)
  await controller.commands.run("history.show", REPO)
  await waitFor(() => fake.streams() === 1)
  fake.set(snapshot(1, [item("i3", "running", { lane: 0 })]))
  fake.hint(1)
  await waitFor(() => controller.stackSnapshots.get(REPO)?.stack?.items[0]?.state === "running")
  fake.set(snapshot(2, [item("i3", "skipped", { reason: "not actionable" })]))
  fake.hint(2)
  await waitFor(() => controller.stackSnapshots.get(REPO)?.stack?.items[0]?.state === "skipped", 3_000)
  await new Promise(resolve => setTimeout(resolve, 60))
  expect(toast(store, itemKey("i3"))).toBeUndefined()
})

test("the removed sweep sends no request; lane count still changes", async () => {
  const { controller, fake } = await setup()
  await controller.commands.run("history.show", REPO)
  const [first, second] = await Promise.all([controller.commands.run("history.backfill", REPO), controller.commands.run("history.backfill", REPO)])
  expect(first.status).toBe("unknown-command")
  expect(second.status).toBe("unknown-command")
  expect(fake.writes).toHaveLength(0)

  expect(await controller.commands.run("history.parallel", `4 ${REPO}`)).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => fake.writes.some(write => write.method === "PUT"))
  expect(fake.writes.find(write => write.method === "PUT")).toEqual({ method: "PUT", path: `${BASE}/config`, body: JSON.stringify({ maxParallel: 4 }) })
  // Nine lanes is outside the API's range: the grammar refuses it, so no request is made.
  expect(await controller.commands.run("history.parallel", `9 ${REPO}`)).not.toMatchObject({ status: "executed" })
  expect(fake.writes.filter(write => write.method === "PUT")).toHaveLength(1)
})

test("the historical retry door refuses without writing", async () => {
  const { controller, fake } = await setup()
  expect(await controller.retryStackItem("i5", REPO)).toBe("Use Retry on the TODO.")
  expect(await controller.commands.run("history.retry", `i5 ${REPO}`)).not.toMatchObject({ status: "executed" })
  expect(fake.writes).toEqual([])
})

test("Create (history.bootstrap) asks the server and its notice runs until the stack reads active (#1760)", async () => {
  const { store, controller, fake } = await setup()
  fake.set(snapshot(0, [], { state: "absent", lanes: [] }))
  const held = deferred<Response>()
  fake.handlers.set(`POST ${BASE}/bootstrap`, () => held.promise)
  expect(await controller.commands.run("history.bootstrap", REPO)).toMatchObject({ status: "executed", value: "Requested" })
  // Durable before the network answers.
  expect(stackCard(store)?.payload.bootstrap).toBeDefined()
  await waitFor(() => toast(store, `stack.bootstrap.${REPO}`)?.status === "running")
  const bootstrapping = snapshot(1, [], { state: "bootstrapping", lanes: [] })
  fake.set(bootstrapping)
  held.resolve(Response.json(bootstrapping, { status: 202 }))
  await waitFor(() => fake.streams() === 1)
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(toast(store, `stack.bootstrap.${REPO}`)?.status).toBe("running")

  fake.set(snapshot(2, []))
  fake.hint(2)
  await waitFor(() => toast(store, `stack.bootstrap.${REPO}`)?.status === "ok")
  await waitFor(() => stackCard(store)?.payload.bootstrap === undefined)
  expect(fake.writes.filter(write => write.path.endsWith("/bootstrap"))).toHaveLength(1)
})

test("a failing bootstrap settles failed with the worker's error and a Retry on the card", async () => {
  const { store, controller, fake } = await setup()
  fake.set(snapshot(0, [], { state: "absent", lanes: [] }))
  await controller.commands.run("history.bootstrap", REPO)
  await waitFor(() => fake.writes.length === 1)
  await waitFor(() => fake.streams() === 1)
  fake.set(snapshot(1, [], { state: "bootstrapping", lanes: [], lastError: "main has no commits" }))
  fake.hint(1)
  await waitFor(() => toast(store, `stack.bootstrap.${REPO}`)?.status === "failed")
  expect(toast(store, `stack.bootstrap.${REPO}`)?.detail).toContain("main has no commits")
  await waitFor(() => stackCard(store)?.payload.failure?.act === "bootstrap")
  expect(stackCard(store)?.payload.bootstrap).toBeUndefined()
})

test("a reload reconnects a pending bootstrap without sending it again", async () => {
  const storage = new Map<string, string>()
  const local = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) }, removeItem: (key: string) => { storage.delete(key) } }
  const first = await createAppStore({ kind: "localStorage", storage: local })
  await first.dispatch({ type: "card.upsert", actor: "system", card: {
    id: `stack:${REPO}`, kind: "stack", title: `History · ${REPO}`, status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: REPO, failure: null, bootstrap: { requestedAt: 1 } }
  } }).isPersisted.promise
  await first.dispose?.()
  const fake = cloud()
  fake.set(snapshot(1, [], { state: "bootstrapping", lanes: [] }))
  const { store } = await setup(fake, await createAppStore({ kind: "localStorage", storage: local }))
  await waitFor(() => toast(store, `stack.bootstrap.${REPO}`)?.status === "running")
  await waitFor(() => fake.streams() === 1)
  fake.set(snapshot(2, []))
  fake.hint(2)
  await waitFor(() => toast(store, `stack.bootstrap.${REPO}`)?.status === "ok")
  expect(fake.writes).toEqual([])
})

test("an unreadable stack shows its refusal and stops asking", async () => {
  const fake = cloud()
  const { controller } = await setup({ ...fake, fetchImpl: async (url, init) =>
    new URL(String(url), "https://test.invalid").pathname.startsWith(BASE)
      ? Response.json({ message: "Not found" }, { status: 404 })
      : fake.fetchImpl(url, init) })
  const shown = await controller.commands.run("history.show", REPO)
  expect(shown.status).toBe("failed")
  expect(controller.stackSnapshots.get(REPO)?.error).toBeTruthy()
})

test("retrying a failed bootstrap waits for the new pass, not the last one's error", async () => {
  const { store, controller, fake } = await setup()
  fake.set(snapshot(1, [], { state: "bootstrapping", lanes: [], lastError: "mirror unreachable" }))
  fake.handlers.set(`POST ${BASE}/bootstrap`, async () => Response.json(snapshot(1, [], { state: "bootstrapping", lanes: [], lastError: "mirror unreachable" }), { status: 202 }))
  await controller.commands.run("history.bootstrap", REPO)
  await waitFor(() => stackCard(store)?.payload.failure?.act === "bootstrap")
  // The server clears lastError when a new request lands.
  fake.handlers.set(`POST ${BASE}/bootstrap`, async () => {
    fake.set(snapshot(1, [], { state: "bootstrapping", lanes: [] }))
    return Response.json(snapshot(1, [], { state: "bootstrapping", lanes: [] }), { status: 202 })
  })
  expect(await controller.commands.run("history.bootstrap", REPO)).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => toast(store, `stack.bootstrap.${REPO}`)?.status === "running")
  await waitFor(() => fake.streams() >= 1)
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(toast(store, `stack.bootstrap.${REPO}`)?.status).toBe("running")
  fake.set(snapshot(2, []))
  fake.hint(2)
  await waitFor(() => toast(store, `stack.bootstrap.${REPO}`)?.status === "ok", 3_000)
  expect(stackCard(store)?.payload.failure).toBeNull()
})

test("a dismissed lane notice stays dismissed while the item is in its lane", async () => {
  const { store, controller, fake } = await setup()
  fake.set(snapshot(1, [item("i4", "running", { lane: 0 })]))
  await controller.commands.run("history.show", REPO)
  await waitFor(() => toast(store, itemKey("i4"))?.status === "running")
  await store.dispatch({ type: "toast.dismissed", actor: "user", id: `toast-${itemKey("i4")}` }).isPersisted.promise
  await waitFor(() => fake.streams() === 1)
  fake.set(snapshot(1, [item("i4", "verifying", { lane: 0 })]))
  const reads = fake.reads()
  fake.hint(1)
  await waitFor(() => fake.reads() > reads, 3_000)
  await new Promise(resolve => setTimeout(resolve, 60))
  expect(toast(store, itemKey("i4"))).toBeUndefined()
})

/* ---- the Wiki the stack keeps current (wiki.create) ---- */

const WIKI_KEY = `stack.wiki.${REPO}`
const wiki = (state: MythicalWiki["state"], extra: Partial<MythicalWiki> = {}): MythicalWiki =>
  ({ state, commit: "c2", pages: 12, edited: 0, attempt: 1, ...extra })

test("wiki.create answers before its request does, deduplicates, and settles only when the Wiki reads current", async () => {
  const { store, controller, fake } = await setup()
  fake.set(snapshot(1, [], { wiki: wiki("stale") }))
  const held = deferred<Response>()
  fake.handlers.set(`POST ${BASE}/wiki`, () => held.promise)
  // A double press: both doors answer at once and one request goes out.
  const [first, second] = await Promise.all([controller.commands.run("wiki.create", REPO), controller.commands.run("wiki.create", REPO)])
  expect(first).toMatchObject({ status: "executed", value: "Requested" })
  expect(second).toMatchObject({ status: "executed", value: "Requested" })
  expect(stackCard(store)?.payload).toEqual({ repo: REPO, failure: null })
  // Durable before the network answers.
  expect(store.session().wikiRequests).toMatchObject([{ repo: REPO, owner: "alice" }])
  await waitFor(() => toast(store, WIKI_KEY)?.status === "running")
  expect(fake.writes.filter(write => write.path === `${BASE}/wiki`)).toHaveLength(1)
  // Chat and other acts stay usable while the launch is unresolved.
  expect(await controller.commands.run("history.show", REPO)).toMatchObject({ status: "executed" })

  const refreshing = snapshot(2, [], { wiki: wiki("refreshing") })
  fake.set(refreshing)
  held.resolve(Response.json(refreshing, { status: 202 }))
  await waitFor(() => controller.stackSnapshots.get(REPO)?.stack?.wiki?.state === "refreshing")
  await waitFor(() => fake.streams() === 1)
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(toast(store, WIKI_KEY)?.status).toBe("running")

  fake.set(snapshot(3, [], { wiki: wiki("current", { publishedCommit: "c2", pages: 14 }) }))
  fake.hint(3)
  await waitFor(() => toast(store, WIKI_KEY)?.status === "ok")
  expect(toast(store, WIKI_KEY)?.title).toBe("Wiki current")
  expect(fake.writes.filter(write => write.path === `${BASE}/wiki`)).toHaveLength(1)
  await waitFor(() => (store.session().wikiRequests ?? []).length === 0)
})

test("a failed refresh settles failed with Retry, and Retry waits for the next attempt, not the last one's error", async () => {
  const { store, controller, fake } = await setup()
  fake.handlers.set(`POST ${BASE}/wiki`, async () => Response.json(snapshot(2, [], { wiki: wiki("refreshing") }), { status: 202 }))
  fake.set(snapshot(2, [], { wiki: wiki("refreshing") }))
  await controller.commands.run("wiki.create", REPO)
  await waitFor(() => fake.streams() === 1)
  const failed = snapshot(3, [], { wiki: wiki("failed", { error: "2 pages failed review" }) })
  fake.set(failed)
  fake.hint(3)
  await waitFor(() => toast(store, WIKI_KEY)?.status === "failed")
  expect(toast(store, WIKI_KEY)).toMatchObject({ detail: "2 pages failed review", action: { flow: "wiki.create", args: REPO, label: "Retry" } })
  // The card has no failure row for the Wiki: its own row shows the error and Retry.
  expect(stackCard(store)?.payload.failure).toBeNull()

  // The retry is acknowledged with the failure it was asked about.
  fake.handlers.set(`POST ${BASE}/wiki`, async () => Response.json(failed, { status: 202 }))
  expect(await controller.commands.run("wiki.create", REPO)).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => toast(store, WIKI_KEY)?.status === "running")
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(toast(store, WIKI_KEY)?.status).toBe("running")
  fake.set(snapshot(4, [], { wiki: wiki("refreshing", { attempt: 2 }) }))
  fake.hint(4)
  await waitFor(() => controller.stackSnapshots.get(REPO)?.stack?.wiki?.attempt === 2, 3_000)
  expect(toast(store, WIKI_KEY)?.status).toBe("running")
  fake.set(snapshot(5, [], { wiki: wiki("current", { attempt: 2, publishedCommit: "c2" }) }))
  fake.hint(5)
  await waitFor(() => toast(store, WIKI_KEY)?.status === "ok", 3_000)
})

test("a refused Wiki request fails on its notice with Retry", async () => {
  const { store, controller, fake } = await setup()
  fake.handlers.set(`POST ${BASE}/wiki`, async () => Response.json({ message: "Only a repository writer can refresh the Wiki." }, { status: 403 }))
  expect(await controller.commands.run("wiki.create", REPO)).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => toast(store, WIKI_KEY)?.status === "failed")
  expect(toast(store, WIKI_KEY)?.action).toEqual({ flow: "wiki.create", args: REPO, label: "Retry" })
  expect(stackCard(store)?.payload.failure).toBeNull()
})

test("rapid refused Wiki attempts retain a healthy real SQLite writer and settle each notice", async () => {
  const db = new Database(":memory:")
  const adapter = await openSqliteRowStorage({
    execute: async <Row>(sql: string, params: ReadonlyArray<unknown> = []) => {
      const statement = db.query(sql)
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<Row>
      statement.run(...params as []); return []
    }, close: () => db.close()
  }, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION })
  const store = await createAppStore({ kind: "opfs", ...adapter,
    storageEventApi: { addEventListener() {}, removeEventListener() {} }
  })
  const fake = cloud()
  fake.handlers.set(`POST ${BASE}/wiki`, async () => Response.json({
    code: "conflict", message: "create the history first; the stack keeps the wiki current"
  }, { status: 409 }))
  const failures: Error[] = []
  store.onStorageFailure(error => { failures.push(error) })
  const { controller } = await setup(fake, store)
  try {
    const results = await Promise.all([
      controller.commands.run("wiki.create", REPO), controller.commands.run("wiki.create", REPO)
    ])
    expect(results.every(result => result.status === "executed")).toBe(true)
    await waitFor(() => toast(store, WIKI_KEY)?.status === "failed")
    expect(fake.writes.filter(write => write.path === `${BASE}/wiki`)).toHaveLength(1)
    await waitFor(() => (store.session().wikiRequests ?? []).length === 0)

    expect(await controller.commands.run("wiki.create", REPO)).toMatchObject({ status: "executed", value: "Requested" })
    await waitFor(() => fake.writes.filter(write => write.path === `${BASE}/wiki`).length === 2)
    await waitFor(() => (store.session().wikiRequests ?? []).length === 0)
    expect(toast(store, WIKI_KEY)).toMatchObject({ status: "failed", action: { flow: "wiki.create", args: REPO, label: "Retry" } })
    expect(failures).toEqual([])
    expect((await store.verifyState()).valid).toBe(true)
  } finally {
    await controller.dispose()
    await store.dispose?.()
  }
})

test("a reload reconnects a running Wiki notice without sending the request again", async () => {
  const storage = new Map<string, string>()
  const local = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) }, removeItem: (key: string) => { storage.delete(key) } }
  const first = await createAppStore({ kind: "localStorage", storage: local })
  await first.dispatch({ type: "card.upsert", actor: "system", card: {
    id: `stack:${REPO}`, kind: "stack", title: `History · ${REPO}`, status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: REPO, failure: null }
  } }).isPersisted.promise
  await first.dispatch({ type: "stack.wiki.requests.changed", actor: "system", requests: [{ repo: REPO, owner: "alice", requestedAt: 1 }] }).isPersisted.promise
  await first.dispose?.()
  const fake = cloud()
  fake.set(snapshot(1, [], { wiki: wiki("refreshing") }))
  const { store } = await setup(fake, await createAppStore({ kind: "localStorage", storage: local }))
  await waitFor(() => toast(store, WIKI_KEY)?.status === "running")
  await waitFor(() => fake.streams() === 1)
  fake.set(snapshot(2, [], { wiki: wiki("failed", { error: "the review timed out" }) }))
  fake.hint(2)
  await waitFor(() => toast(store, WIKI_KEY)?.status === "failed")
  expect(toast(store, WIKI_KEY)).toMatchObject({ detail: "the review timed out", action: { flow: "wiki.create", args: REPO, label: "Retry" } })
  expect(fake.writes).toEqual([])
  await waitFor(() => (store.session().wikiRequests ?? []).length === 0)
})

test("search.history indexes the history's changes: one read when none is watched, the live snapshot once History shows", async () => {
  const { store, controller, fake } = await setup()
  const change = (changeId: string, title: string, state: "landed" | "pending", issue?: number) =>
    ({ changeId, commitId: `c-${changeId}`, title, kind: issue === undefined ? "bootstrap" as const : "item" as const, state, ...(issue === undefined ? {} : { issue }) })
  await store.dispatch({ type: "repositories.loaded", actor: "system",
    repositories: [{ id: REPO, org: "smithersai", ownerKind: "org", name: "smithers", head: null }] }).isPersisted.promise
  fake.set(snapshot(1, [], { changes: [change("kaaa", "Redact the journal", "pending", 12), change("kbbb", "Initial import", "landed")] }))
  expect(await controller.commands.run("search.history", "redact")).toMatchObject({ status: "executed" })
  const results = () => {
    const card = store.collections.cards.get("search-search.history")
    return card?.kind === "search-results" ? card.payload.items.map(row => [row.ref, row.title, row.subtitle]) : []
  }
  expect(results()).toEqual([[`${REPO}#kaaa`, "Redact the journal", "#12 · pending"]])
  // The read is the index, never a History card.
  expect(stackCard(store)).toBeUndefined()
  expect(fake.streams()).toBe(0)

  await controller.commands.run("history.show", REPO)
  const reads = fake.reads()
  expect(await controller.commands.run("search.history", "import")).toMatchObject({ status: "executed" })
  expect(fake.reads()).toBe(reads)
  expect(results()).toEqual([[`${REPO}#kbbb`, "Initial import", "landed"]])
  expect(controller.searchPalette("history: redact").groups.flatMap(group => group.items.map(row => row.item.ref))).toEqual([`${REPO}#kaaa`])
})

test("signed out, History parks behind sign-in and reads nothing", async () => {
  const fake = cloud()
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
    fetchImpl: fake.fetchImpl
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
  await controller.commands.run("history.show", REPO)
  expect(fake.reads()).toBe(0)
  expect(stackCard(store)).toBeUndefined()
})

test("History exposes no obsolete TODO Land door", async () => {
  const { controller } = await setup()
  expect(controller.commands.entries().map(nameOf)).not.toContain("history.land")
})
