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
 * The connect card's integration rows read the routes the backend registers
 * (compose/router.go): GET …/issues/sync/channels and GET /api/integrations/linear.
 * A missing route is `unavailable`, never "not connected".
 */
const setup = async (answer: (url: string) => Response | Promise<Response>, options: Partial<Pick<SeamContext, "withToast" | "actor">> = {}) => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } } })
  stores.add(store)
  const seen: string[] = []
  let disposed = false
  const retire = () => { disposed = true }
  retireContexts.add(retire)
  let ordinal = 0
  const seam = createIntegrationsSeam({ store, dispatch: store.dispatch, actor: () => "user", nextOrdinal: () => ++ordinal, baseUrl: "https://app.test",
    http: (url) => {
      seen.push(url)
      return track(Promise.resolve().then(() => {
        if (url !== CHANNELS && url !== LINEAR) {
          unexpectedRequests.push(url)
          throw new Error(`Unexpected Integrations HTTP: ${url}`)
        }
        return answer(url)
      }))
    }, isDisposed: () => disposed, ...options } satisfies SeamContext)
  const rows = () => { const card = store.collections.cards.get("connect-embedded"); return card?.kind === "connect" ? card.payload.integrations?.rows : undefined }
  return { store, seam: { listIntegrations: (repo?: string) => track(seam.listIntegrations(repo)) }, seen, rows, retire }
}

const CHANNELS = "https://app.test/api/repos/Owner/Repo/issues/sync/channels"
const LINEAR = "https://app.test/api/integrations/linear"

test("connected rows come from the registered routes: the owner's Slack admissions and the Linear integration bound to the repository", async () => {
  const { seam, seen, rows } = await setup(url => url === CHANNELS
    ? Response.json([{ provider: "telegram", connection_id: "bot", scope_id: "1", conversation_id: "-100", thread_id: "", external_user_id: "" },
      { provider: "slack", connection_id: "workspace", scope_id: "T001", conversation_id: "C001", thread_id: "", external_user_id: "" },
      { provider: "slack", connection_id: "workspace", scope_id: "T001", conversation_id: "C002", thread_id: "", external_user_id: "" }])
    : Response.json([{ id: 1, repo_owner: "someone", repo_name: "else", linear_team_key: "OPS", is_active: true, last_sync_at: null },
      { id: 2, repo_owner: "owner", repo_name: "repo", linear_team_key: "ENG", is_active: true, last_sync_at: "2026-09-26T09:40:00Z" }]))
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: "slack: connected · C001, C002\nlinear: connected · ENG" })
  expect(seen.sort()).toEqual([LINEAR, CHANNELS].sort())
  expect(rows()).toEqual([
    { id: "slack", state: "connected", detail: "C001, C002" },
    { id: "linear", state: "connected", detail: "ENG", lastSyncAt: "2026-09-26T09:40:00Z" }
  ])
})

test("no admissions and no Linear row for this repository read not-connected", async () => {
  const { seam, rows } = await setup(url => url === CHANNELS
    ? Response.json([{ provider: "telegram", connection_id: "bot", scope_id: "1", conversation_id: "-100", thread_id: "", external_user_id: "" }])
    : Response.json([{ id: 1, repo_owner: "someone", repo_name: "else", linear_team_key: "OPS", is_active: true }]))
  await seam.listIntegrations("Owner/Repo")
  expect(rows()?.map(row => row.state)).toEqual(["not-connected", "not-connected"])
})

test("a route this server does not register is unavailable, not a disconnected account; a 502 refusal says what failed and whose fault it was", async () => {
  const { seam, rows, store } = await setup(url => url === CHANNELS
    ? Response.json({ status: "error", code: "route_not_found", message: "Not found." }, { status: 404 })
    : Response.json({ status: "error", message: "token revoked" }, { status: 502 }))
  try {
    await seam.listIntegrations("Owner/Repo")
    expect(rows()).toEqual([
      { id: "slack", state: "unavailable" },
      { id: "linear", state: "error", error: "Reading the Linear integrations failed (502). Something Smithers depends on failed. Not your doing." }
    ])
    expect(rows()?.[1]?.error).not.toContain("token revoked")
  } finally { await store.dispose?.() }
})

test("malformed successful integration lists report a read error instead of claiming no connection", async () => {
  const { seam, rows, store } = await setup(url => url === CHANNELS
    ? Response.json({ channels: { provider: "slack", conversation_id: "C001" } })
    : Response.json({ integrations: null }))
  try {
    await seam.listIntegrations("Owner/Repo")
    expect(rows()?.map(row => row.state)).toEqual(["error", "error"])
  } finally { await store.dispose?.() }
})

test("supported empty list wrappers remain disconnected", async () => {
  const { seam, rows, store } = await setup(url => url === CHANNELS
    ? Response.json({ channels: [] })
    : Response.json({ integrations: [] }))
  try {
    await seam.listIntegrations("Owner/Repo")
    expect(rows()?.map(row => row.state)).toEqual(["not-connected", "not-connected"])
  } finally { await store.dispose?.() }
})

test("malformed rows inside valid list wrappers are filtered", async () => {
  const { seam, rows, store } = await setup(url => url === CHANNELS
    ? Response.json({ channels: [null, { provider: "slack", conversation_id: "" }] })
    : Response.json({ integrations: [null, { repo_owner: "someone", repo_name: "else" }] }))
  try {
    await seam.listIntegrations("Owner/Repo")
    expect(rows()?.map(row => row.state)).toEqual(["not-connected", "not-connected"])
  } finally { await store.dispose?.() }
})

test("wrapped admissions filter Slack IDs and independently match Linear repository case", async () => {
  const { seam, rows, seen } = await setup(url => url === CHANNELS
    ? Response.json({ channels: [null, { provider: "slack", conversation_id: "" }, { provider: "telegram", conversation_id: "OTHER" }, { provider: "slack", conversation_id: "C space" }] })
    : Response.json({ integrations: [{ repo_owner: "OWNER", repo_name: "REPO", linear_team_name: "Platform", last_sync_at: "" }] }))
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: "slack: connected · C space\nlinear: connected · Platform" })
  expect(rows()).toEqual([{ id: "slack", state: "connected", detail: "C space" }, { id: "linear", state: "connected", detail: "Platform" }])
  expect(seen.sort()).toEqual([CHANNELS, LINEAR].sort())
})

test.each(["bare", "wrapped"])("a %s Linear list tolerates malformed nonmatching rows beside a valid repository match", async shape => {
  const integrations = [
    null,
    {},
    { repo_name: "repo", linear_team_key: "MISSING-OWNER" },
    { repo_owner: 7, repo_name: "repo", linear_team_key: "NONSTRING-OWNER" },
    { repo_owner: "owner", linear_team_key: "MISSING-REPO" },
    { repo_owner: "owner", repo_name: false, linear_team_key: "NONSTRING-REPO" },
    { repo_owner: "someone", repo_name: "else", linear_team_key: "OTHER", is_active: true },
    { repo_owner: "OWNER", repo_name: "REPO", linear_team_key: "MATCH", is_active: true, last_sync_at: "2026-09-26T09:40:00Z" }
  ]
  const { seam, rows, seen } = await setup(url => url === CHANNELS
    ? Response.json([{ provider: "slack", conversation_id: "C-MATCH" }])
    : Response.json(shape === "bare" ? integrations : { integrations }))
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: "slack: connected · C-MATCH\nlinear: connected · MATCH" })
  expect(rows()).toEqual([
    { id: "slack", state: "connected", detail: "C-MATCH" },
    { id: "linear", state: "connected", detail: "MATCH", lastSyncAt: "2026-09-26T09:40:00Z" }
  ])
  expect(seen).toEqual([CHANNELS, LINEAR])
})

const linearCases = [
  { label: "inactive", wire: { is_active: false, linear_team_key: "ENG", linear_team_name: "ignored" }, row: { id: "linear", state: "not-connected", detail: "ENG" }, value: "linear: not-connected · ENG" },
  { label: "remediation overrides inactive", wire: { is_active: false, remediation_state: "Reconnect Linear", linear_team_id: "team-7" }, row: { id: "linear", state: "error", detail: "team-7", error: "Reconnect Linear" }, value: "linear: error · team-7 · Reconnect Linear" },
  { label: "empty preferred fields fall back to ID", wire: { is_active: true, linear_team_key: "", linear_team_name: "", linear_team_id: "team-8", last_sync_at: null }, row: { id: "linear", state: "connected", detail: "team-8" }, value: "linear: connected · team-8" },
  { label: "no team metadata", wire: { is_active: true }, row: { id: "linear", state: "connected" }, value: "linear: connected" }
] as const

test.each([...linearCases])("Linear $label has the exact owning row and model result", async ({ wire, row, value }) => {
  const { seam, rows } = await setup(url => url === CHANNELS ? Response.json([]) : Response.json([{ repo_owner: "owner", repo_name: "repo", ...wire }]))
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: `slack: not-connected\n${value}` })
  expect(rows()).toEqual([{ id: "slack", state: "not-connected" }, row])
})

test("405 is unavailable and unaddressed server failures use safe route-specific copy", async () => {
  const { seam, rows } = await setup(url => url === CHANNELS ? new Response("private router detail", { status: 405 }) : new Response("private stack", { status: 503 }))
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: "slack: unavailable\nlinear: error · Reading the Linear integrations failed (503). Something on Smithers' side failed. Not your fault, and nothing your request could have changed." })
  expect(rows()).toEqual([{ id: "slack", state: "unavailable" }, { id: "linear", state: "error", error: "Reading the Linear integrations failed (503). Something on Smithers' side failed. Not your fault, and nothing your request could have changed." }])
})

test.each(["fulfill", "reject"] as const)("disposed ownership fences late integration read: %s", async answer => {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const admission = new Promise<void>(resolve => { entered = resolve })
  releases.add(release)
  const { seam, rows, store, retire } = await setup(async url => {
    if (url !== CHANNELS) return Response.json([])
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


test("refresh preserves concurrent durable connect changes made while both reads are held", async () => {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const admission = new Promise<void>(resolve => { entered = resolve })
  releases.add(release)
  let requests = 0
  const { seam, store, rows } = await setup(async url => {
    if (++requests === 2) entered()
    await gate
    return url === CHANNELS ? Response.json([{ provider: "slack", conversation_id: "CURRENT" }]) : Response.json([])
  })
  const command = seam.listIntegrations("Owner/Repo")
  await admission
  const card = store.collections.cards.get("connect-embedded")
  if (card?.kind !== "connect") throw new Error("Expected connect card")
  await store.dispatch({ type: "card.upsert", actor: "user", card: { ...card, payload: { ...card.payload, github: { connected: true, login: "will" }, nativeAvailable: true } } }).isPersisted.promise
  release()
  expect(await command).toEqual({ value: "slack: connected · CURRENT\nlinear: not-connected" })
  const refreshed = store.collections.cards.get("connect-embedded")
  if (refreshed?.kind !== "connect") throw new Error("Expected refreshed connect card")
  expect(refreshed.payload.github).toEqual({ connected: true, login: "will" })
  expect(refreshed.payload.nativeAvailable).toBe(true)
  expect(refreshed.ordinal).toBe(card.ordinal)
  expect(rows()).toEqual([{ id: "slack", state: "connected", detail: "CURRENT" }, { id: "linear", state: "not-connected" }])
})

const signIn = (store: AppStore, login: string) => store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login, allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise

for (const owner of ["same", "account", "sign-out"] as const) {
  test(`a held successful integration read belongs to ${owner === "same" ? "the unchanged account" : "the original account after " + owner}`, async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const admission = new Promise<void>(resolve => { entered = resolve })
    releases.add(release)
    let requests = 0
    const { seam, store, rows, seen } = await setup(async url => {
      if (++requests === 2) entered()
      await gate
      return url === CHANNELS ? Response.json([{ provider: "slack", conversation_id: "OWNER" }]) : Response.json([])
    })
    await signIn(store, "will")
    const command = seam.listIntegrations("Owner/Repo")
    await admission
    if (owner === "account") await signIn(store, "ada")
    else if (owner === "sign-out") await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
    const atRelease = store.collections.cards.get("connect-embedded")
    release()
    const result = await command
    await Promise.allSettled([...pending])
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(seen.sort()).toEqual([CHANNELS, LINEAR].sort())
    if (owner === "same") {
      expect(result).toEqual({ value: "slack: connected · OWNER\nlinear: not-connected" })
      expect(rows()).toEqual([{ id: "slack", state: "connected", detail: "OWNER" }, { id: "linear", state: "not-connected" }])
    } else {
      expect(result).toBeUndefined()
      expect(rows()).toBeUndefined()
      expect(store.collections.cards.get("connect-embedded")).toEqual(atRelease)
    }
  })
}

const networkCases = [
  { route: CHANNELS, row: { id: "slack", state: "error", error: "Could not reach the Slack channels. Nothing answered at all — that's the connection, not something you did. Try it again." }, value: "slack: error · Could not reach the Slack channels. Nothing answered at all — that's the connection, not something you did. Try it again.\nlinear: not-connected", label: "Slack" },
  { route: LINEAR, row: { id: "linear", state: "error", error: "Could not reach the Linear integrations. Nothing answered at all — that's the connection, not something you did. Try it again." }, value: "slack: not-connected\nlinear: error · Could not reach the Linear integrations. Nothing answered at all — that's the connection, not something you did. Try it again.", label: "Linear" }
] as const

test.each([...networkCases])("a live $label network rejection is visible on its owning row and model answer", async ({ route, row, value }) => {
  const { seam, rows, seen } = await setup(url => {
    if (url === route) throw new Error("offline")
    return Response.json([])
  })
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value })
  expect(rows()).toEqual(route === CHANNELS ? [row, { id: "linear", state: "not-connected" }] : [{ id: "slack", state: "not-connected" }, row])
  expect(seen.sort()).toEqual([CHANNELS, LINEAR].sort())
})

const slackAdmission = { provider: "slack", connection_id: "workspace", scope_id: "T001", conversation_id: "C003", thread_id: "", external_user_id: "" }
const linearIntegration = { id: 7, linear_team_id: "team-7", linear_team_name: "Engineering", linear_team_key: "ENG", repo_owner: "owner", repo_name: "repo", repo_id: 4, is_active: true, last_sync_at: null, created_at: "2026-09-26T09:40:00Z", linear_actor: { id: "viewer-7", name: "Ada", email: "ada@example.test" } }

for (const route of [CHANNELS, LINEAR]) test.each([
  { name: "malformed JSON" },
  { name: "null JSON" },
  { name: "absent wrapper" },
  { name: "number JSON" },
  { name: "boolean JSON" },
  { name: "string JSON" },
  { name: "wrong wrapper shape" },
  { name: "body reader failure" }
])(`${route === CHANNELS ? "Slack" : "Linear"} $name cannot establish a disconnected account and a later valid read recovers`, async ({ name }) => {
  let phase: "empty" | "invalid" | "recovery" = "empty"
  const { seam, rows, seen } = await setup(url => {
    if (url !== route || phase === "empty") return Response.json([])
    if (phase === "recovery") return Response.json(route === CHANNELS ? [slackAdmission] : [linearIntegration])
    if (name === "malformed JSON") return new Response("{not-json", { headers: { "content-type": "application/json" } })
    if (name === "null JSON") return Response.json(null)
    if (name === "absent wrapper") return Response.json({})
    if (name === "number JSON") return Response.json(42)
    if (name === "boolean JSON") return Response.json(false)
    if (name === "string JSON") return Response.json("")
    if (name === "wrong wrapper shape") return Response.json(route === CHANNELS ? { channels: {} } : { integrations: {} })
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("owned body reader failed")) } }), { headers: { "content-type": "application/json" } })
  })
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: "slack: not-connected\nlinear: not-connected" })
  expect(rows()).toEqual([{ id: "slack", state: "not-connected" }, { id: "linear", state: "not-connected" }])
  phase = "invalid"
  const invalidResult = await seam.listIntegrations("Owner/Repo"), invalidRows = rows()
  phase = "recovery"
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: route === CHANNELS ? "slack: connected · C003\nlinear: not-connected" : "slack: not-connected\nlinear: connected · ENG" })
  expect(rows()).toEqual(route === CHANNELS
    ? [{ id: "slack", state: "connected", detail: "C003" }, { id: "linear", state: "not-connected" }]
    : [{ id: "slack", state: "not-connected" }, { id: "linear", state: "connected", detail: "ENG" }])
  expect(seen).toEqual([CHANNELS, LINEAR, CHANNELS, LINEAR, CHANNELS, LINEAR])
  // A failed read supplies no evidence of disconnected state. Exact new copy
  // is not prescribed; the card and model must agree on the same visible error.
  const failedRow = invalidRows?.[route === CHANNELS ? 0 : 1]
  expect(failedRow?.state).toBe("error")
  expect(failedRow?.error).toEqual(expect.any(String))
  expect(failedRow?.error?.trim()).not.toBe("")
  expect(failedRow?.error).toContain(route === CHANNELS ? "Slack" : "Linear")
  expect(invalidRows).toEqual(route === CHANNELS
    ? [{ id: "slack", state: "error", error: failedRow?.error }, { id: "linear", state: "not-connected" }]
    : [{ id: "slack", state: "not-connected" }, { id: "linear", state: "error", error: failedRow?.error }])
  expect(invalidResult).toEqual({ value: route === CHANNELS ? `slack: error · ${failedRow?.error}\nlinear: not-connected` : `slack: not-connected\nlinear: error · ${failedRow?.error}` })
})

for (const route of [CHANNELS, LINEAR]) test(`${route === CHANNELS ? "Slack" : "Linear"} supports its wrapped empty list while the other service remains connected`, async () => {
  const { seam, rows } = await setup(url => url === route
    ? Response.json(route === CHANNELS ? { channels: [] } : { integrations: [] })
    : Response.json(url === CHANNELS ? [slackAdmission] : [linearIntegration]))
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: route === CHANNELS ? "slack: not-connected\nlinear: connected · ENG" : "slack: connected · C003\nlinear: not-connected" })
  expect(rows()).toEqual(route === CHANNELS
    ? [{ id: "slack", state: "not-connected" }, { id: "linear", state: "connected", detail: "ENG" }]
    : [{ id: "slack", state: "connected", detail: "C003" }, { id: "linear", state: "not-connected" }])
})

test.each([{ status: 404 }, { status: 405 }])("a Linear HTTP$status missing route does not erase the connected Slack row", async ({ status }) => {
  const { seam, rows } = await setup(url => url === CHANNELS ? Response.json([slackAdmission]) : Response.json({ message: "Route absent" }, { status }))
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: "slack: connected · C003\nlinear: unavailable" })
  expect(rows()).toEqual([{ id: "slack", state: "connected", detail: "C003" }, { id: "linear", state: "unavailable" }])
})

for (const route of [CHANNELS, LINEAR]) test(`${route === CHANNELS ? "Slack" : "Linear"} permission refusal preserves addressed nested server copy and the independent healthy service`, async () => {
  const { seam, rows } = await setup(url => url === route ? Response.json({ error: { message: "Permission denied." } }, { status: 403 }) : Response.json(url === CHANNELS ? [slackAdmission] : [linearIntegration]))
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: route === CHANNELS ? "slack: error · Permission denied.\nlinear: connected · ENG" : "slack: connected · C003\nlinear: error · Permission denied." })
  expect(rows()).toEqual(route === CHANNELS
    ? [{ id: "slack", state: "error", error: "Permission denied." }, { id: "linear", state: "connected", detail: "ENG" }]
    : [{ id: "slack", state: "connected", detail: "C003" }, { id: "linear", state: "error", error: "Permission denied." }])
})

test("a failed Slack refusal-body read uses its route-specific fallback while Linear remains connected", async () => {
  const { seam, rows } = await setup(url => url === CHANNELS ? new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("private body failure")) } }), { status: 503 }) : Response.json([linearIntegration]))
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: "slack: error · Reading the Slack channels failed (503). Something on Smithers' side failed. Not your fault, and nothing your request could have changed.\nlinear: connected · ENG" })
  expect(rows()).toEqual([{ id: "slack", state: "error", error: "Reading the Slack channels failed (503). Something on Smithers' side failed. Not your fault, and nothing your request could have changed." }, { id: "linear", state: "connected", detail: "ENG" }])
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
  expect(await seam.listIntegrations(repo)).toEqual({ value: "slack: not-connected\nlinear: not-connected" })
  expect(seen).toEqual([CHANNELS, LINEAR])
  expect(rows()).toEqual([{ id: "slack", state: "not-connected" }, { id: "linear", state: "not-connected" }])
})

test("the controlled toast wrapper receives the live owner and existing connect card while preserving its metadata", async () => {
  const calls: Array<{ key: string; title: string; doneTitle: string; quiet: boolean | undefined; current: boolean | undefined; sourceCard: string | undefined }> = []
  const { seam, store, rows } = await setup(url => Response.json(url === CHANNELS ? [slackAdmission] : [linearIntegration]), {
    actor: () => "smithers",
    withToast: async (key, title, doneTitle, work, quiet, current, sourceCard) => {
      calls.push({ key, title, doneTitle, quiet, current: current?.(), sourceCard })
      return work()
    }
  })
  const original: Extract<Card, { kind: "connect" }> = { id: "connect-embedded", kind: "connect", title: "Existing connections", status: "acted", createdAt: 37, ordinal: 91, payload: { provider: "github", github: { connected: true, login: "will" }, nativeAvailable: true } }
  await store.dispatch({ type: "card.upsert", actor: "user", card: original }).isPersisted.promise
  const eventCount = (await store.eventHistory()).events.length
  expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: "slack: connected · C003\nlinear: connected · ENG" })
  expect(calls).toEqual([{ key: "integrations.read:Owner/Repo", title: "Reading integrations", doneTitle: "Integrations", quiet: false, current: true, sourceCard: "connect-embedded" }])
  expect(rows()).toEqual([{ id: "slack", state: "connected", detail: "C003" }, { id: "linear", state: "connected", detail: "ENG" }])
  const refreshed = store.collections.cards.get("connect-embedded")
  if (refreshed?.kind !== "connect") throw new Error("Expected connect card")
  expect({ id: refreshed.id, kind: refreshed.kind, title: refreshed.title, status: refreshed.status, createdAt: refreshed.createdAt, ordinal: refreshed.ordinal, payload: refreshed.payload }).toEqual({ ...original, payload: { ...original.payload, integrations: { repo: "Owner/Repo", rows: [{ id: "slack", state: "connected", detail: "C003" }, { id: "linear", state: "connected", detail: "ENG" }] } } })
  expect((await store.eventHistory()).events.slice(eventCount).map(event => ({ type: event.type, actor: event.actor }))).toEqual([{ type: "card.upsert", actor: "smithers" }])
})
