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

test("history.view keeps the view in the card payload: it surfaces the card, survives other writes, and switches back", async () => {
  const { store, controller, fake } = await setup()
  fake.set(snapshot(1, [item("i1", "landed")]))
  const shown = await controller.commands.run("history.view", `metrics ${REPO}`)
  expect(shown).toMatchObject({ status: "executed" })
  expect(stackCard(store)?.payload).toEqual({ repo: REPO, failure: null, view: "metrics" })
  expect(controller.stackSnapshots.get(REPO)?.stack?.generation).toBe(1)
  // Showing the card again keeps its view.
  await controller.commands.run("history.show", REPO)
  expect(stackCard(store)?.payload.view).toBe("metrics")
  const back = await controller.commands.run("history.view", `issues ${REPO}`)
  expect(back).toMatchObject({ status: "executed" })
  expect(stackCard(store)?.payload.view).toBe("issues")
  expect(await controller.commands.run("history.view", `graph ${REPO}`)).not.toMatchObject({ status: "executed" })
  expect(stackCard(store)?.payload.view).toBe("issues")
})

test("lane notices start after the debounce, follow rebases and conflicts, and settle only on a real outcome", async () => {
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
  await waitFor(() => toast(store, one)?.detail === "rebasing" && toast(store, two)?.detail === "conflict · src/a.ts")
  expect(toast(store, two)?.status).toBe("running")

  fake.set(snapshot(2, [
    item("i1", "proposed", { checks: { state: "passed", failed: [] }, pullRequest: { number: 40, url: "https://github.com/pr/40", state: "open" } }),
    item("i2", "blocked", { reason: "3 attempts conflicted" })
  ]))
  fake.hint(2)
  await waitFor(() => toast(store, one)?.status === "ok" && toast(store, two)?.status === "failed")
  expect(toast(store, one)).toMatchObject({ title: "#1 Issue i1", detail: "PR #40" })
  expect(toast(store, two)).toMatchObject({ detail: "blocked · 3 attempts conflicted", action: { flow: "history.retry", args: `i2 ${REPO}`, label: "Retry" } })
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

test("backfill and lane count answer before their requests do, deduplicate, and settle with the answer", async () => {
  const { store, controller, fake } = await setup()
  await controller.commands.run("history.show", REPO)
  const held = deferred<Response>()
  fake.handlers.set(`POST ${BASE}/backfill`, () => held.promise)
  // A double press: both doors answer at once and one request goes out.
  const [first, second] = await Promise.all([controller.commands.run("history.backfill", REPO), controller.commands.run("history.backfill", REPO)])
  expect(first).toMatchObject({ status: "executed", value: "Requested" })
  expect(second).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => toast(store, `stack.backfill.${REPO}`)?.status === "running")
  expect(fake.writes.filter(write => write.path.endsWith("/backfill"))).toHaveLength(1)
  held.resolve(Response.json(snapshot(4, [item("i9", "queued")]), { status: 202 }))
  await waitFor(() => toast(store, `stack.backfill.${REPO}`)?.status === "ok")
  expect(controller.stackSnapshots.get(REPO)?.stack?.items.map(row => row.id)).toEqual(["i9"])

  expect(await controller.commands.run("history.parallel", `4 ${REPO}`)).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => fake.writes.some(write => write.method === "PUT"))
  expect(fake.writes.find(write => write.method === "PUT")).toEqual({ method: "PUT", path: `${BASE}/config`, body: JSON.stringify({ maxParallel: 4 }) })
  // Nine lanes is outside the API's range: the grammar refuses it, so no request is made.
  expect(await controller.commands.run("history.parallel", `9 ${REPO}`)).not.toMatchObject({ status: "executed" })
  expect(fake.writes.filter(write => write.method === "PUT")).toHaveLength(1)
})

test("a refused act stays visible on the card and its Retry succeeds", async () => {
  const { store, controller, fake } = await setup()
  await controller.commands.run("history.show", REPO)
  fake.handlers.set(`POST ${BASE}/items/i5/retry`, async () => Response.json({ message: "Only a repository writer can retry." }, { status: 403 }))
  expect(await controller.commands.run("history.retry", `i5 ${REPO}`)).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => toast(store, `stack.retry.${REPO}#i5`)?.status === "failed")
  await waitFor(() => stackCard(store)?.payload.failure?.act === "retry")
  expect(stackCard(store)?.payload.failure).toMatchObject({ act: "retry", args: `i5 ${REPO}` })

  fake.handlers.set(`POST ${BASE}/items/i5/retry`, async () => Response.json(item("i5", "queued"), { status: 202 }))
  const failure = stackCard(store)!.payload.failure!
  expect(await controller.commands.run("history.retry", failure.args)).toMatchObject({ status: "executed" })
  await waitFor(() => stackCard(store)?.payload.failure === null)
  await waitFor(() => toast(store, `stack.retry.${REPO}#i5`)?.status !== "running")
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

/*
 * history.todo (#2782): a TODO filed for the coding factory through
 * POST …/mythical/todos, acknowledged before the filing answers, durable on
 * the History card, and followed in one notice through the factory's lanes
 * until its pull request opens, it lands, or it stops.
 */
const todoKey = (key: string) => `stack.todo.${encodeURIComponent(REPO)}#${key}`
const todoToasts = (store: AppStore) => [...store.collections.toasts.values()].filter(row => row.key.startsWith(todoKey("")))
const filed = (id: string, title: string) => Response.json(item(id, "queued", { issue: { number: 9, title, url: `https://github.com/${REPO}/issues/9` } }), { status: 201 })

test("history.todo answers before the filing does, keeps Chat usable, and follows the TODO until its pull request opens", async () => {
  const { store, controller, fake } = await setup()
  fake.set(snapshot(1, []))
  const filing = deferred<Response>()
  fake.handlers.set(`POST ${BASE}/todos`, () => filing.promise)
  const asked = await controller.commands.run("history.todo", JSON.stringify({ title: " Add the footer link ", body: "Make it findable.", repo: REPO }))
  expect(asked).toMatchObject({ status: "executed", value: "Requested" })
  // The request is durable before the filing answers.
  const pending = stackCard(store)?.payload.todos ?? []
  expect(pending).toMatchObject([{ title: "Add the footer link", body: "Make it findable." }])
  expect(pending[0]?.item).toBeUndefined()
  await waitFor(() => fake.writes.length === 1)
  expect(fake.writes[0]).toMatchObject({ method: "POST", path: `${BASE}/todos` })
  const sent = JSON.parse(fake.writes[0]!.body) as { title: string; body: string; request: string }
  expect(sent).toEqual({ title: "Add the footer link", body: "Make it findable.", request: `${pending[0]!.key}-${pending[0]!.requestedAt.toString(36)}` })
  // Chat and the other acts stay usable meanwhile.
  expect(await controller.commands.run("history.view", `metrics ${REPO}`)).toMatchObject({ status: "executed" })
  // The same TODO asked again joins the filing in flight.
  expect(await controller.commands.run("history.todo", JSON.stringify({ title: "Add the footer link", body: "Make it findable.", repo: REPO }))).toMatchObject({ status: "executed", value: "Requested" })
  expect(stackCard(store)?.payload.todos).toHaveLength(1)
  const key = todoKey(pending[0]!.key)
  await waitFor(() => toast(store, key)?.status === "running")
  expect(toast(store, key)?.title).toBe("Add the footer link")

  fake.set(snapshot(2, [item("i9", "queued")]))
  filing.resolve(filed("i9", "Add the footer link"))
  await waitFor(() => stackCard(store)?.payload.todos?.[0]?.item === "i9")
  await waitFor(() => toast(store, key)?.detail === "queued")
  expect(fake.writes).toHaveLength(1)

  await waitFor(() => fake.streams() === 1)
  fake.set(snapshot(3, [item("i9", "running", { lane: 0 })]))
  fake.hint(3)
  await waitFor(() => toast(store, key)?.detail === "implementing")
  fake.set(snapshot(4, [item("i9", "verifying", { lane: 0, checks: { state: "pending", failed: [] } })]))
  fake.hint(4)
  await waitFor(() => toast(store, key)?.detail === "checking")
  // The TODO's notice is the only one: no lane notice repeats it.
  await new Promise(resolve => setTimeout(resolve, 60))
  expect(toast(store, itemKey("i9"))).toBeUndefined()
  expect(toast(store, key)?.status).toBe("running")

  fake.set(snapshot(5, [item("i9", "proposed", { pullRequest: { number: 41, url: `https://github.com/${REPO}/pull/41`, state: "open" } })]))
  fake.hint(5)
  await waitFor(() => toast(store, key)?.status === "ok")
  expect(toast(store, key)?.detail).toBe("PR #41")
  await waitFor(() => stackCard(store)?.payload.todos === undefined)
  expect(stackCard(store)?.payload.failure).toBeNull()
})

test("a refused filing fails on the card and its notice, and Retry files it again", async () => {
  const { store, controller, fake } = await setup()
  fake.set(snapshot(1, []))
  fake.handlers.set(`POST ${BASE}/todos`, async () => Response.json({ message: "only a maintainer the factory's policy names files a TODO" }, { status: 403 }))
  expect(await controller.commands.run("history.todo", JSON.stringify({ title: "Fix the footer", repo: REPO }))).toMatchObject({ status: "executed", value: "Requested" })
  const args = JSON.stringify({ title: "Fix the footer", repo: REPO })
  await waitFor(() => stackCard(store)?.payload.failure?.act === "todo")
  expect(stackCard(store)?.payload.failure).toMatchObject({ act: "todo", args })
  expect(stackCard(store)?.payload.todos).toBeUndefined()
  await waitFor(() => todoToasts(store)[0]?.status === "failed")
  expect(todoToasts(store)[0]?.action).toEqual({ flow: "history.todo", args, label: "Retry" })

  fake.handlers.set(`POST ${BASE}/todos`, async () => filed("i3", "Fix the footer"))
  fake.set(snapshot(2, [item("i3", "landed")]))
  expect(await controller.commands.run("history.todo", args)).toMatchObject({ status: "executed", value: "Requested" })
  expect(stackCard(store)?.payload.failure).toBeNull()
  await waitFor(() => todoToasts(store).some(row => row.status === "ok" && row.detail === "landed"))
})

test("a rejected TODO filing request stays retryable instead of claiming the TODO was filed", async () => {
  const { store, controller, fake } = await setup()
  fake.set(snapshot(1, []))
  fake.handlers.set(`POST ${BASE}/todos`, async () => { throw new TypeError("private transport diagnostic") })
  await controller.commands.run("history.todo", JSON.stringify({ title: "Fix the footer", repo: REPO }))
  await waitFor(() => todoToasts(store)[0]?.status === "failed")
  expect(todoToasts(store)[0]?.detail).toBe("Could not reach Smithers Cloud. Nothing answered at all — that's the connection, not something you did. Try it again.")
  expect(todoToasts(store)[0]?.action).toMatchObject({ flow: "history.todo", label: "Retry" })
  expect(stackCard(store)?.payload.todos).toHaveLength(1)
})

test("an unexpected TODO follow failure keeps its diagnostic out of the notice", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const fake = cloud()
  const reports: string[] = []
  let failTodoWrite = false
  const guarded = new Proxy(store, {
    get(target, property, receiver) {
      if (property !== "dispatch") return Reflect.get(target, property, receiver)
      return (transition: Parameters<AppStore["dispatch"]>[0]) => {
        if (failTodoWrite && transition.type === "card.upsert" && transition.card.kind === "stack"
          && transition.card.payload.todos?.some((row) => row.item === "i3")) {
          failTodoWrite = false
          throw new Error("private TODO follow diagnostic")
        }
        return target.dispatch(transition)
      }
    }
  })
  const controller = createAppController(guarded, unavailableAgent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
    fetchImpl: fake.fetchImpl,
    toastDebounceMs: 20,
    clientErrors: { report: (_kind, error) => reports.push(String(error)), reported: () => reports.length }
  })
  await signIn(store)
  await waitFor(() => fake.profileReads.length === 1)
  fake.set(snapshot(1, []))
  fake.handlers.set(`POST ${BASE}/todos`, async () => {
    failTodoWrite = true
    return filed("i3", "Fix the footer")
  })
  await controller.commands.run("history.todo", JSON.stringify({ title: "Fix the footer", repo: REPO }))
  await waitFor(() => todoToasts(store)[0]?.status === "failed")
  expect(todoToasts(store)[0]?.detail).toBe("Smithers lost track of this TODO. Open History to see its state.")
  expect(todoToasts(store)[0]?.action).toBeUndefined()
  expect(fake.writes).toHaveLength(1)
  expect(JSON.stringify([...store.collections.toasts.values()])).not.toContain("private TODO follow diagnostic")
  expect(reports).toHaveLength(1)
  expect(reports[0]).toContain("private TODO follow diagnostic")
  expect(reports[0]).toContain(`stack.todo.follow ${REPO}`)
})

test("a TODO the factory stops settles failed with the stop's words and Retry", async () => {
  const { store, controller, fake } = await setup()
  fake.set(snapshot(1, [item("i5", "queued")]))
  fake.handlers.set(`POST ${BASE}/todos`, async () => filed("i5", "Issue i5"))
  await controller.commands.run("history.todo", JSON.stringify({ title: "Issue i5", repo: REPO }))
  await waitFor(() => fake.streams() === 1)
  fake.set(snapshot(2, [item("i5", "blocked", { reason: "out of attempts" })]))
  fake.hint(2)
  await waitFor(() => todoToasts(store)[0]?.status === "failed")
  expect(todoToasts(store)[0]).toMatchObject({ detail: "blocked · out of attempts", action: { flow: "history.retry", args: `i5 ${REPO}`, label: "Retry" } })
  // The card's issue list, not a failure row, keeps the stopped TODO.
  expect(stackCard(store)?.payload.failure).toBeNull()
  expect(stackCard(store)?.payload.todos).toBeUndefined()
})

test("a TODO without a title opens its form instead of filing; a typed line files its title in the active repository", async () => {
  const { store, fake, controller } = await setup()
  expect(await controller.commands.run("history.todo", JSON.stringify({ repo: REPO }))).toMatchObject({ status: "form", flow: "history.todo", fields: ["title"] })
  expect(fake.writes).toEqual([])
  await store.dispatch({ type: "repositories.loaded", actor: "system",
    repositories: [{ id: REPO, org: "smithersai", ownerKind: "org", name: "smithers", head: null }] }).isPersisted.promise
  fake.handlers.set(`POST ${BASE}/todos`, async () => filed("i2", "Fix the footer link"))
  expect(await controller.commands.run("history.todo", "Fix the footer link")).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => fake.writes.length === 1)
  expect(JSON.parse(fake.writes[0]!.body)).toMatchObject({ title: "Fix the footer link" })
  expect(JSON.parse(fake.writes[0]!.body)).not.toHaveProperty("body")
})

test("a reload reconnects filed TODOs: a followed one is not sent again, an unanswered one is sent again under its request id", async () => {
  const storage = new Map<string, string>()
  const local = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) }, removeItem: (key: string) => { storage.delete(key) } }
  const first = await createAppStore({ kind: "localStorage", storage: local })
  await first.dispatch({ type: "card.upsert", actor: "system", card: {
    id: `stack:${REPO}`, kind: "stack", title: `History · ${REPO}`, status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: REPO, failure: null, todos: [
      { key: "a", title: "Issue i4", body: "", requestedAt: 1, item: "i4" },
      { key: "b", title: "Issue i6", body: "", requestedAt: 36 },
      { key: "c", title: "Refused", body: "", requestedAt: 1 }
    ] }
  } }).isPersisted.promise
  await first.dispose?.()
  const fake = cloud()
  fake.set(snapshot(1, [item("i4", "running", { lane: 0 }), item("i6", "queued")]))
  fake.handlers.set(`POST ${BASE}/todos`, async (body) => (JSON.parse(body) as { request: string }).request === "b-10"
    ? filed("i6", "Issue i6") : Response.json({ message: "only a maintainer the factory's policy names files a TODO" }, { status: 403 }))
  const { store } = await setup(fake, await createAppStore({ kind: "localStorage", storage: local }))
  await waitFor(() => toast(store, todoKey("a"))?.detail === "implementing")
  await waitFor(() => toast(store, todoKey("c"))?.status === "failed")
  await waitFor(() => stackCard(store)?.payload.todos?.find(row => row.key === "b")?.item === "i6")
  expect(fake.writes.map(write => JSON.parse(write.body).request).sort()).toEqual(["b-10", "c-1"])
  expect(stackCard(store)?.payload.todos?.map(row => row.key)).toEqual(["a", "b"])
  await waitFor(() => fake.streams() === 1)
  fake.set(snapshot(2, [item("i4", "landed"), item("i6", "declined", { reason: "a duplicate of #4" })]))
  fake.hint(2)
  await waitFor(() => toast(store, todoKey("a"))?.status === "ok" && toast(store, todoKey("b"))?.status === "failed")
  expect(toast(store, todoKey("b"))?.detail).toBe("declined · a duplicate of #4")
  await waitFor(() => stackCard(store)?.payload.todos === undefined)
})

test("a filing whose answer is unknown keeps its request, and Retry sends the same request id", async () => {
  const { store, controller, fake } = await setup()
  fake.set(snapshot(1, []))
  fake.handlers.set(`POST ${BASE}/todos`, async () => Response.json({ message: "upstream timed out" }, { status: 503 }))
  const args = JSON.stringify({ title: "Fix the footer", repo: REPO })
  await controller.commands.run("history.todo", args)
  await waitFor(() => stackCard(store)?.payload.failure?.act === "todo")
  expect(stackCard(store)?.payload.todos).toHaveLength(1)
  await waitFor(() => todoToasts(store)[0]?.status === "failed")
  fake.handlers.set(`POST ${BASE}/todos`, async () => filed("i3", "Fix the footer"))
  fake.set(snapshot(2, [item("i3", "running", { lane: 0 })]))
  expect(await controller.commands.run("history.todo", args)).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => stackCard(store)?.payload.todos?.[0]?.item === "i3")
  const ids = fake.writes.map(write => (JSON.parse(write.body) as { request: string }).request)
  expect(ids).toHaveLength(2)
  expect(ids[1]).toBe(ids[0])
  expect(stackCard(store)?.payload.failure).toBeNull()
})

test("the TODO's notice takes over a lane notice raised before the filing answered", async () => {
  const { store, controller, fake } = await setup()
  const filing = deferred<Response>()
  fake.set(snapshot(1, [item("i8", "running", { lane: 0 })]))
  fake.handlers.set(`POST ${BASE}/todos`, () => filing.promise)
  await controller.commands.run("history.show", REPO)
  await controller.commands.run("history.todo", JSON.stringify({ title: "Issue i8", repo: REPO }))
  await waitFor(() => toast(store, itemKey("i8"))?.status === "running")
  filing.resolve(filed("i8", "Issue i8"))
  await waitFor(() => toast(store, itemKey("i8")) === undefined)
  await waitFor(() => todoToasts(store)[0]?.detail === "implementing")
})

test("a followed TODO missing from several fresh snapshots stops its notice instead of running forever", async () => {
  const { store, controller, fake } = await setup()
  fake.set(snapshot(1, [item("i2", "queued")]))
  fake.handlers.set(`POST ${BASE}/todos`, async () => filed("i2", "Issue i2"))
  await controller.commands.run("history.todo", JSON.stringify({ title: "Issue i2", repo: REPO }))
  await waitFor(() => todoToasts(store)[0]?.detail === "queued")
  await waitFor(() => fake.streams() === 1)
  fake.set(snapshot(2, []))
  for (const generation of [2, 3, 4]) {
    fake.hint(generation)
    await new Promise(resolve => setTimeout(resolve, 1_100))
  }
  await waitFor(() => todoToasts(store)[0]?.status === "failed", 3_000)
  expect(todoToasts(store)[0]?.detail).toBe("The history no longer lists this TODO. Open History to see it.")
})

test("Land (history.land) is acknowledged at once and its notice follows the TODO until it lands (#3059)", async () => {
  const { store, controller, fake } = await setup()
  const head = "d".repeat(40)
  const pullRequest = { number: 40, url: "https://github.com/pr/40", state: "open" as const, head }
  const proposed = item("i40", "proposed", { todo: { replans: 0 }, pullRequest })
  fake.set(snapshot(2, [proposed]))
  await controller.commands.run("history.show", REPO)
  const held = deferred<Response>()
  fake.handlers.set(`POST ${BASE}/items/i40/land`, () => held.promise)
  const key = `stack.land.${REPO}#i40`
  // The command returns before the request answers; a second press joins it.
  expect(await controller.commands.run("history.land", `i40 ${head} ${REPO}`)).toMatchObject({ status: "executed", value: "Requested" })
  expect(await controller.commands.run("history.land", `i40 ${head} ${REPO}`)).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => toast(store, key)?.status === "running")
  expect(fake.writes.filter(write => write.path === `${BASE}/items/i40/land`)).toEqual([{ method: "POST", path: `${BASE}/items/i40/land`, body: JSON.stringify({ head }) }])
  // Chat stays usable while it runs.
  expect(await controller.commands.run("history.show", REPO)).toMatchObject({ status: "executed" })

  const accepted = { ...proposed, automerge: true, updatedAt: "2026-09-25T10:05:00Z" }
  held.resolve(Response.json(accepted, { status: 202 }))
  // A read that began before the land was accepted does not settle it.
  fake.hint(3)
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(toast(store, key)?.status).toBe("running")
  // Reviewed, green, merged: the notice settles only now.
  fake.set(snapshot(4, [accepted]))
  fake.hint(4)
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(toast(store, key)?.status).toBe("running")
  fake.set(snapshot(5, [{ ...accepted, state: "landed", updatedAt: "2026-09-25T10:09:00Z", pullRequest: { ...pullRequest, state: "merged" } }]))
  fake.hint(5)
  await waitFor(() => toast(store, key)?.status === "ok")
  expect(stackCard(store)?.payload.failure).toBeNull()
})

test("a Land the stack stops short of, or that Cloud refuses, fails visibly with Retry and never claims it landed", async () => {
  const { store, controller, fake } = await setup()
  const head = "e".repeat(40)
  const pullRequest = { number: 41, url: "https://github.com/pr/41", state: "open" as const, head }
  const proposed = item("i41", "proposed", { todo: { replans: 0 }, pullRequest })
  fake.set(snapshot(2, [proposed]))
  await controller.commands.run("history.show", REPO)
  const args = `i41 ${head} ${REPO}`
  const key = `stack.land.${REPO}#i41`

  fake.handlers.set(`POST ${BASE}/items/i41/land`, async () => Response.json({ message: "the pull request changed since you saw it" }, { status: 409 }))
  expect(await controller.commands.run("history.land", args)).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => toast(store, key)?.status === "failed")
  expect(toast(store, key)).toMatchObject({ action: { flow: "history.land", args, label: "Retry" } })
  // A land failure lives on its notice, never as the card's standing failure.
  expect(stackCard(store)?.payload.failure).toBeNull()

  // Accepted, then a maintainer takes automerge off: the stack holds it.
  fake.handlers.set(`POST ${BASE}/items/i41/land`, async () =>
    Response.json({ ...proposed, automerge: true, updatedAt: "2026-09-25T10:05:00Z" }, { status: 202 }))
  expect(await controller.commands.run("history.land", args)).toMatchObject({ status: "executed" })
  await waitFor(() => toast(store, key)?.status === "running")
  fake.set(snapshot(3, [{ ...proposed, reason: "a maintainer's automerge label is no longer on the issue", updatedAt: "2026-09-25T10:06:00Z" }]))
  fake.hint(3)
  await waitFor(() => toast(store, key)?.status === "failed")
  expect(toast(store, key)).toMatchObject({ action: { flow: "history.land", args, label: "Retry" } })
  expect(toast(store, key)?.detail).toContain("automerge label is no longer on the issue")
})

test("history.land refuses a malformed line before any request", async () => {
  const { controller, fake } = await setup()
  for (const line of ["", "i1", `i1 ${"a".repeat(40)} extra ${REPO}`]) {
    expect(await controller.commands.run("history.land", line)).not.toMatchObject({ status: "executed", value: "Requested" })
  }
  expect(fake.writes.filter(write => write.path.endsWith("/land"))).toEqual([])
})
