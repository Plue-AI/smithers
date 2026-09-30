import { afterEach, expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import type { Card } from "../AppState"
import type { SeamContext } from "./SeamContext"
import { createIntegrationsSeam } from "./IntegrationsSeam"

const stores = new Set<AppStore>()
const pending = new Set<Promise<unknown>>()
const releases = new Set<() => void>()
const retireContexts = new Set<() => void>()
const unexpectedRequests: string[] = []
const track = <T>(task: Promise<T>): Promise<T> => {
  pending.add(task)
  void task.then(() => pending.delete(task), () => pending.delete(task))
  return task
}
const drainWork = async () => {
  while (pending.size > 0) await Promise.allSettled([...pending])
  await new Promise<void>(resolve => { setImmediate(resolve) })
}
const bounded = async <T>(task: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Integrations fixture work did not settle")), 3_000)
    })])
  } finally { clearTimeout(timer) }
}
const closeStore = async (store: AppStore) => {
  if (!stores.has(store)) return
  try {
    if (typeof store.dispose !== "function") throw new Error("Store disposal is required")
    await store.dispose()
  } finally { stores.delete(store) }
}
afterEach(async () => {
  const failures: unknown[] = []
  for (const retire of retireContexts) {
    try { retire() } catch (error) { failures.push(error) }
  }
  retireContexts.clear()
  for (const release of releases) {
    try { release() } catch (error) { failures.push(error) }
  }
  releases.clear()
  try { await bounded(drainWork()) } catch (error) { failures.push(error) }
  for (const store of stores) {
    try { await closeStore(store) } catch (error) { failures.push(error) }
  }
  if (unexpectedRequests.length > 0) failures.push(new Error(`Unexpected Integrations HTTP: ${unexpectedRequests.join(", ")}`))
  unexpectedRequests.length = 0
  if (failures.length > 0) throw new AggregateError(failures, "Integration fixture cleanup failed")
})

/*
 * The connect card's integration row reads the route the backend registers
 * (compose/router.go): GET …/issues/sync/channels. The first-party Linear
 * integration is retired (D-11), so no read ever asks for it and the card
 * carries no Linear row. A missing route is `unavailable`, never "not
 * connected".
 */
const setup = async (answer: (url: string, init?: RequestInit) => Response | Promise<Response>, options: Partial<Pick<SeamContext, "withToast" | "actor">> = {}) => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } } })
  stores.add(store)
  const seen: string[] = []
  const writes: Array<{ method: string; body: unknown }> = []
  let disposed = false
  const retire = () => { disposed = true }
  retireContexts.add(retire)
  let ordinal = 0
  const seam = createIntegrationsSeam({ store, dispatch: store.dispatch, actor: () => "user", nextOrdinal: () => ++ordinal, baseUrl: "https://app.test",
    http: (url, init) => {
      seen.push(url)
      if (init?.method !== undefined && init.method !== "GET") writes.push({ method: init.method, body: JSON.parse(String(init.body)) })
      return track(Promise.resolve().then(() => {
        if (url !== CHANNELS) {
          unexpectedRequests.push(url)
          throw new Error(`Unexpected Integrations HTTP: ${url}`)
        }
        return answer(url, init)
      }))
    }, isDisposed: () => disposed, ...options } satisfies SeamContext)
  const rows = () => { const card = store.collections.cards.get("connect-embedded"); return card?.kind === "connect" ? card.payload.integrations?.rows : undefined }
  return { store, seam: { listIntegrations: (repo?: string) => track(seam.listIntegrations(repo)), admitSlackChannel: (admission: Parameters<typeof seam.admitSlackChannel>[0], repo?: string) => track(seam.admitSlackChannel(admission, repo)) }, seen, writes, rows, retire }
}

const CHANNELS = "https://app.test/api/repos/Owner/Repo/issues/sync/channels"

test("the connected row comes from the registered route: the owner's Slack admissions", async () => {
  const { seam, seen, rows } = await setup(() => Response.json([{ provider: "telegram", connection_id: "bot", scope_id: "1", conversation_id: "-100", thread_id: "", external_user_id: "" },
    { provider: "slack", connection_id: "workspace", scope_id: "T001", conversation_id: "C001", thread_id: "", external_user_id: "" },
    { provider: "slack", connection_id: "workspace", scope_id: "T001", conversation_id: "C002", thread_id: "", external_user_id: "" }]))
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: "slack: connected · C001, C002" })
  expect(seen).toEqual([CHANNELS])
  expect(rows()).toEqual([{ id: "slack", state: "connected", detail: "C001, C002" }])
})

test("no Slack admissions read not-connected", async () => {
  const { seam, rows } = await setup(() => Response.json([{ provider: "telegram", connection_id: "bot", scope_id: "1", conversation_id: "-100", thread_id: "", external_user_id: "" }]))
  await seam.listIntegrations("Owner/Repo")
  expect(rows()?.map(row => row.state)).toEqual(["not-connected"])
})

test("a route this server does not register is unavailable, not a disconnected account", async () => {
  const { seam, rows, store } = await setup(() => Response.json({ status: "error", code: "route_not_found", message: "Not found." }, { status: 404 }))
  try {
    await seam.listIntegrations("Owner/Repo")
    expect(rows()).toEqual([{ id: "slack", state: "unavailable" }])
  } finally { await store.dispose?.() }
})

test("a 502 refusal says what failed and whose fault it was, never the upstream's words", async () => {
  const { seam, rows, store } = await setup(() => Response.json({ status: "error", message: "token revoked" }, { status: 502 }))
  try {
    await seam.listIntegrations("Owner/Repo")
    expect(rows()).toEqual([{ id: "slack", state: "error", error: "Reading the Slack channels failed (502). Something Smithers depends on failed. Not your doing." }])
    expect(rows()?.[0]?.error).not.toContain("token revoked")
  } finally { await store.dispose?.() }
})

test("a malformed successful list reports a read error instead of claiming no connection", async () => {
  const { seam, rows, store } = await setup(() => Response.json({ channels: { provider: "slack", conversation_id: "C001" } }))
  try {
    await seam.listIntegrations("Owner/Repo")
    expect(rows()?.map(row => row.state)).toEqual(["error"])
  } finally { await store.dispose?.() }
})

test("a supported empty list wrapper remains disconnected", async () => {
  const { seam, rows, store } = await setup(() => Response.json({ channels: [] }))
  try {
    await seam.listIntegrations("Owner/Repo")
    expect(rows()?.map(row => row.state)).toEqual(["not-connected"])
  } finally { await store.dispose?.() }
})

test("malformed rows inside a valid list wrapper are filtered", async () => {
  const { seam, rows, store } = await setup(() => Response.json({ channels: [null, { provider: "slack", conversation_id: "" }] }))
  try {
    await seam.listIntegrations("Owner/Repo")
    expect(rows()?.map(row => row.state)).toEqual(["not-connected"])
  } finally { await store.dispose?.() }
})

test("wrapped admissions filter Slack IDs", async () => {
  const { seam, rows, seen } = await setup(() => Response.json({ channels: [null, { provider: "slack", conversation_id: "" }, { provider: "telegram", conversation_id: "OTHER" }, { provider: "slack", conversation_id: "C space" }] }))
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: "slack: connected · C space" })
  expect(rows()).toEqual([{ id: "slack", state: "connected", detail: "C space" }])
  expect(seen).toEqual([CHANNELS])
})

test("405 is unavailable and an unaddressed server failure uses safe route-specific copy", async () => {
  const unavailable = await setup(() => new Response("private router detail", { status: 405 }))
  expect(await unavailable.seam.listIntegrations("Owner/Repo")).toEqual({ value: "slack: unavailable" })
  expect(unavailable.rows()).toEqual([{ id: "slack", state: "unavailable" }])
  const failed = await setup(() => new Response("private stack", { status: 503 }))
  expect(await failed.seam.listIntegrations("Owner/Repo")).toEqual({ value: "slack: error · Reading the Slack channels failed (503). Something on Smithers' side failed. Not your fault, and nothing your request could have changed." })
  expect(failed.rows()).toEqual([{ id: "slack", state: "error", error: "Reading the Slack channels failed (503). Something on Smithers' side failed. Not your fault, and nothing your request could have changed." }])
})

test.each(["fulfill", "reject"] as const)("disposed ownership fences late integration read: %s", async answer => {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const admission = new Promise<void>(resolve => { entered = resolve })
  releases.add(release)
  const { seam, rows, store, retire } = await setup(async () => {
    entered()
    await gate
    if (answer === "reject") throw new Error("retired private failure")
    return Response.json([{ provider: "slack", conversation_id: "OLD" }])
  })
  const command = seam.listIntegrations("Owner/Repo")
  await admission
  const original = store.collections.cards.get("connect-embedded")
  retire()
  release()
  expect(await command).toBeUndefined()
  await Promise.allSettled([...pending])
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(rows()).toBeUndefined()
  expect(store.collections.cards.get("connect-embedded")).toEqual(original)
})


test("refresh preserves concurrent durable connect changes made while the read is held", async () => {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const admission = new Promise<void>(resolve => { entered = resolve })
  releases.add(release)
  const { seam, store, rows } = await setup(async () => {
    entered()
    await gate
    return Response.json([{ provider: "slack", conversation_id: "CURRENT" }])
  })
  const command = seam.listIntegrations("Owner/Repo")
  await admission
  const card = store.collections.cards.get("connect-embedded")
  if (card?.kind !== "connect") throw new Error("Expected connect card")
  await store.dispatch({ type: "card.upsert", actor: "user", card: { ...card, payload: { ...card.payload, github: { connected: true, login: "will" }, nativeAvailable: true } } }).isPersisted.promise
  release()
  expect(await command).toEqual({ value: "slack: connected · CURRENT" })
  const refreshed = store.collections.cards.get("connect-embedded")
  if (refreshed?.kind !== "connect") throw new Error("Expected refreshed connect card")
  expect(refreshed.payload.github).toEqual({ connected: true, login: "will" })
  expect(refreshed.payload.nativeAvailable).toBe(true)
  expect(refreshed.ordinal).toBe(card.ordinal)
  expect(rows()).toEqual([{ id: "slack", state: "connected", detail: "CURRENT" }])
})

const signIn = (store: AppStore, login: string) => store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login, admin: false, scopesPlain: null }).isPersisted.promise

for (const owner of ["same", "account", "sign-out"] as const) {
  test(`a held successful integration read belongs to ${owner === "same" ? "the unchanged account" : "the original account after " + owner}`, async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const admission = new Promise<void>(resolve => { entered = resolve })
    releases.add(release)
    const { seam, store, rows, seen } = await setup(async () => {
      entered()
      await gate
      return Response.json([{ provider: "slack", conversation_id: "OWNER" }])
    })
    await signIn(store, "will")
    const command = seam.listIntegrations("Owner/Repo")
    await admission
    if (owner === "account") await signIn(store, "ada")
    else if (owner === "sign-out") await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
    const atRelease = store.collections.cards.get("connect-embedded")
    release()
    const result = await command
    await Promise.allSettled([...pending])
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(seen).toEqual([CHANNELS])
    if (owner === "same") {
      expect(result).toEqual({ value: "slack: connected · OWNER" })
      expect(rows()).toEqual([{ id: "slack", state: "connected", detail: "OWNER" }])
    } else {
      expect(result).toBeUndefined()
      expect(rows()).toBeUndefined()
      expect(store.collections.cards.get("connect-embedded")).toEqual(atRelease)
    }
  })
}

test("a live network rejection is visible on the Slack row and model answer", async () => {
  const { seam, rows, seen } = await setup(() => { throw new Error("offline") })
  const error = "Could not reach the Slack channels. Nothing answered at all — that's the connection, not something you did. Try it again."
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: `slack: error · ${error}` })
  expect(rows()).toEqual([{ id: "slack", state: "error", error }])
  expect(seen).toEqual([CHANNELS])
})

const slackAdmission = { provider: "slack", connection_id: "workspace", scope_id: "T001", conversation_id: "C003", thread_id: "", external_user_id: "" }

test.each([
  { name: "malformed JSON" },
  { name: "null JSON" },
  { name: "absent wrapper" },
  { name: "number JSON" },
  { name: "boolean JSON" },
  { name: "string JSON" },
  { name: "wrong wrapper shape" },
  { name: "body reader failure" }
])("Slack $name cannot establish a disconnected account and a later valid read recovers", async ({ name }) => {
  let phase: "empty" | "invalid" | "recovery" = "empty"
  const { seam, rows, seen } = await setup(() => {
    if (phase === "empty") return Response.json([])
    if (phase === "recovery") return Response.json([slackAdmission])
    if (name === "malformed JSON") return new Response("{not-json", { headers: { "content-type": "application/json" } })
    if (name === "null JSON") return Response.json(null)
    if (name === "absent wrapper") return Response.json({})
    if (name === "number JSON") return Response.json(42)
    if (name === "boolean JSON") return Response.json(false)
    if (name === "string JSON") return Response.json("")
    if (name === "wrong wrapper shape") return Response.json({ channels: {} })
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("owned body reader failed")) } }), { headers: { "content-type": "application/json" } })
  })
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: "slack: not-connected" })
  expect(rows()).toEqual([{ id: "slack", state: "not-connected" }])
  phase = "invalid"
  const invalidResult = await seam.listIntegrations("Owner/Repo"), invalidRows = rows()
  phase = "recovery"
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: "slack: connected · C003" })
  expect(rows()).toEqual([{ id: "slack", state: "connected", detail: "C003" }])
  expect(seen).toEqual([CHANNELS, CHANNELS, CHANNELS])
  // A failed read supplies no evidence of disconnected state. Exact new copy
  // is not prescribed; the card and model must agree on the same visible error.
  const failedRow = invalidRows?.[0]
  expect(failedRow?.state).toBe("error")
  expect(failedRow?.error).toEqual(expect.any(String))
  expect(failedRow?.error?.trim()).not.toBe("")
  expect(failedRow?.error).toContain("Slack")
  expect(invalidRows).toEqual([{ id: "slack", state: "error", error: failedRow?.error }])
  expect(invalidResult).toEqual({ value: `slack: error · ${failedRow?.error}` })
})

test("a Slack permission refusal preserves the addressed nested server copy", async () => {
  const { seam, rows } = await setup(() => Response.json({ error: { message: "Permission denied." } }, { status: 403 }))
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: "slack: error · Permission denied." })
  expect(rows()).toEqual([{ id: "slack", state: "error", error: "Permission denied." }])
})

test("a failed Slack refusal-body read uses its route-specific fallback", async () => {
  const { seam, rows } = await setup(() => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("private body failure")) } }), { status: 503 }))
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: "slack: error · Reading the Slack channels failed (503). Something on Smithers' side failed. Not your fault, and nothing your request could have changed." })
  expect(rows()).toEqual([{ id: "slack", state: "error", error: "Reading the Slack channels failed (503). Something on Smithers' side failed. Not your fault, and nothing your request could have changed." }])
})

test.each([
  { name: "extra path segment", repo: "Owner/Repo/extra", error: '"Owner/Repo/extra" is not an owner/repo name' },
  { name: "invalid name", repo: "bad name", error: '"bad name" is not an owner/repo name' },
  { name: "no selection", repo: undefined, error: "No repository is loaded yet — sign in with /cloud.sign-in, or name one as owner/repo" }
])("$name creates no connect card and performs no service read", async ({ repo, error }) => {
  const { seam, store, seen, rows } = await setup(() => { throw new Error("Unexpected HTTP read") })
  const before = [...store.collections.cards.values()]
  expect(await seam.listIntegrations(repo)).toBe(error)
  expect(seen).toEqual([])
  expect(rows()).toBeUndefined()
  expect([...store.collections.cards.values()]).toEqual(before)
})

test.each([{ name: "omitted", repo: undefined }, { name: "empty", repo: "" }])("an $name explicit repository uses the active repository", async ({ repo }) => {
  const { seam, store, seen, rows } = await setup(() => Response.json([]))
  await store.dispatch({ type: "repository.upserted", actor: "system", repository: { id: "Owner/Repo", org: "Owner", name: "Repo", ownerKind: "user", head: null } }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: "Owner/Repo" }).isPersisted.promise
  expect(await seam.listIntegrations(repo)).toEqual({ value: "slack: not-connected" })
  expect(seen).toEqual([CHANNELS])
  expect(rows()).toEqual([{ id: "slack", state: "not-connected" }])
})

test("the controlled toast wrapper receives the live owner and existing connect card while preserving its metadata", async () => {
  const calls: Array<{ key: string; title: string; doneTitle: string; quiet: boolean | undefined; current: boolean | undefined; sourceCard: string | undefined }> = []
  const { seam, store, rows } = await setup(() => Response.json([slackAdmission]), {
    actor: () => "smithers",
    withToast: async (key, title, doneTitle, work, quiet, current, sourceCard) => {
      calls.push({ key, title, doneTitle, quiet, current: current?.(), sourceCard })
      return work()
    }
  })
  const original: Extract<Card, { kind: "connect" }> = { id: "connect-embedded", kind: "connect", title: "Existing connections", status: "acted", createdAt: 37, ordinal: 91, payload: { provider: "github", github: { connected: true, login: "will" }, nativeAvailable: true } }
  await store.dispatch({ type: "card.upsert", actor: "user", card: original }).isPersisted.promise
  const eventCount = (await store.eventHistory()).events.length
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: "slack: connected · C003" })
  expect(calls).toEqual([{ key: "integrations.read:Owner/Repo", title: "Reading integrations", doneTitle: "Integrations", quiet: false, current: true, sourceCard: "connect-embedded" }])
  expect(rows()).toEqual([{ id: "slack", state: "connected", detail: "C003" }])
  const refreshed = store.collections.cards.get("connect-embedded")
  if (refreshed?.kind !== "connect") throw new Error("Expected connect card")
  expect({ id: refreshed.id, kind: refreshed.kind, title: refreshed.title, status: refreshed.status, createdAt: refreshed.createdAt, ordinal: refreshed.ordinal, payload: refreshed.payload }).toEqual({ ...original, payload: { ...original.payload, integrations: { repo: "Owner/Repo", rows: [{ id: "slack", state: "connected", detail: "C003" }] } } })
  expect((await store.eventHistory()).events.slice(eventCount).map(event => ({ type: event.type, actor: event.actor }))).toEqual([{ type: "card.upsert", actor: "smithers" }])
})

/* Admission (#2267): the PUT the authenticated route validates, then the readback the card projects. */
const admission = { connection_id: "slack-main", scope_id: "T0123", conversation_id: "C0123" }

test("admitting a Slack channel PUTs the admission, reads the channels back and connects the card without a reload", async () => {
  let admitted = false
  const { seam, writes, rows } = await setup((_url, init) => {
    if (init?.method === "PUT") { admitted = true; return Response.json({}) }
    return Response.json(admitted ? [{ provider: "slack", connection_id: "slack-main", scope_id: "T0123", conversation_id: "C0123" }] : [])
  })
  await seam.listIntegrations("Owner/Repo")
  expect(rows()?.[0]).toEqual({ id: "slack", state: "not-connected" })
  expect(await seam.admitSlackChannel({ ...admission, external_user_id: " U0999 " }, "Owner/Repo")).toEqual({ value: "Admitted C0123 to Owner/Repo." })
  expect(writes).toEqual([{ method: "PUT", body: { provider: "slack", ...admission, external_user_id: "U0999" } }])
  expect(rows()?.[0]).toEqual({ id: "slack", state: "connected", detail: "C0123" })
})

test("a refused admission renders no connection and says the server's words", async () => {
  const { seam, rows, writes } = await setup((_url, init) => init?.method === "PUT"
    ? Response.json({ error: { message: "sync conversation already configured for another repository" } }, { status: 409 })
    : Response.json([]))
  await seam.listIntegrations("Owner/Repo")
  const answer = await seam.admitSlackChannel(admission, "Owner/Repo")
  expect(answer).toContain("sync conversation already configured for another repository")
  expect(writes).toHaveLength(1)
  expect(rows()?.[0]).toEqual({ id: "slack", state: "not-connected" })
})

test("an admission the readback does not list is not a success, and a failed readback says so", async () => {
  const listed = await setup((_url, init) => init?.method === "PUT" ? Response.json({}) : Response.json([{ provider: "slack", conversation_id: "C0999" }]))
  expect(await listed.seam.admitSlackChannel(admission, "Owner/Repo")).toBe("Slack channel C0123 was not among the admitted channels afterwards.")
  const failed = await setup((_url, init) => init?.method === "PUT" ? Response.json({}) : Response.json({ message: "down" }, { status: 502 }))
  expect(await failed.seam.admitSlackChannel(admission, "Owner/Repo")).toContain("Reading the Slack channels failed (502)")
})

test("a write that cannot reach the server is an unreachable sentence, not a connection", async () => {
  const { seam, rows } = await setup((_url, init) => { if (init?.method === "PUT") throw new Error("offline"); return Response.json([]) })
  await seam.listIntegrations("Owner/Repo")
  expect(await seam.admitSlackChannel(admission, "Owner/Repo")).toContain("Slack channels")
  expect(rows()?.[0]).toEqual({ id: "slack", state: "not-connected" })
})

test.each([
  { name: "empty connection", change: { connection_id: " " }, words: "connection id" },
  { name: "long connection", change: { connection_id: "c".repeat(129) }, words: "connection id" },
  { name: "lowercase workspace", change: { scope_id: "t0123" }, words: "workspace id" },
  { name: "short workspace", change: { scope_id: "T1" }, words: "workspace id" },
  { name: "user id as channel", change: { conversation_id: "U0123" }, words: "channel id" },
  { name: "bad user", change: { external_user_id: "u 1" }, words: "user id" }
])("$name is refused before any write", async ({ change, words }) => {
  const { seam, writes } = await setup(() => Response.json([]))
  expect(await seam.admitSlackChannel({ ...admission, ...change }, "Owner/Repo")).toContain(words)
  expect(writes).toEqual([])
})

test("an unresolved repository is refused before any write", async () => {
  const { seam, writes } = await setup(() => Response.json([]))
  expect(await seam.admitSlackChannel(admission, "bad name")).toBe('"bad name" is not an owner/repo name')
  expect(writes).toEqual([])
})

test("a duplicate submit while the first is in flight writes once, and a later resubmit is allowed", async () => {
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  releases.add(release)
  const { seam, writes } = await setup(async (_url, init) => {
    if (init?.method === "PUT") { await gate; return Response.json({}) }
    return Response.json([{ provider: "slack", conversation_id: "C0123" }])
  })
  const first = seam.admitSlackChannel(admission, "Owner/Repo")
  await new Promise<void>(resolve => { setTimeout(resolve, 5) })
  expect(await seam.admitSlackChannel(admission, "Owner/Repo")).toBe("Admitting C0123 is already under way.")
  release()
  expect(await first).toEqual({ value: "Admitted C0123 to Owner/Repo." })
  expect(writes).toHaveLength(1)
  expect(await seam.admitSlackChannel(admission, "Owner/Repo")).toEqual({ value: "Admitted C0123 to Owner/Repo." })
  expect(writes).toHaveLength(2)
})

test("the admission runs under the shared toast keyed by the admission, and a failure settles it as a failure string", async () => {
  const calls: Array<{ key: string; title: string; sourceCard: string | undefined }> = []
  const { seam } = await setup((_url, init) => init?.method === "PUT" ? Response.json({ message: "no write access" }, { status: 403 }) : Response.json([]), {
    withToast: async (key, title, _done, work, _quiet, _current, sourceCard) => { calls.push({ key, title, sourceCard }); return work() }
  })
  expect(await seam.admitSlackChannel(admission, "Owner/Repo")).toContain("no write access")
  expect(calls).toEqual([{ key: "integrations.admit:owner/repo\nslack-main\nT0123\nC0123\n", title: "Admitting Slack channel", sourceCard: "connect-embedded" }])
})
