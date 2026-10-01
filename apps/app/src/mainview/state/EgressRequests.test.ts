import { digest } from "@smthrs/core/Digest"
import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { APP_SCHEMA_VERSION } from "../chain/SchemaVersion"
import { openSqliteRowStorage, ROW_TABLE_NAME } from "../chain/SqliteRowStorage"
import { APP_PROJECTOR_VERSION } from "./AppEventStream"
import { type AppStore, createAppStore, PERSISTED_COLLECTION_SPECS } from "./AppStore"
import { APP_TRANSITION_SCHEMAS } from "./AppTransitionValidation"
import { createControllerContext } from "./controller/context"
import { createFailureController } from "./controller/failures"
import { scopedControllers } from "./ControllerTestScope"
import { canonicalEventValue, decodeEventValue } from "./EventValue"
import { createEgressSeam } from "./seams/EgressSeam"
import { applicationIdentityFromFetch } from "./TestFixtures"
import { unavailableAgent, waitFor } from "./TestFixtures"

const cleanups: Array<() => Promise<void> | void> = []
const createAppController = scopedControllers()
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const hold = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const requests = (store: AppStore) => store.session().egressRequests ?? []
const key = (host: string, owner = "will", repo = "will/smithers") => `egress-allow:${owner}:${repo}:${host}`
const notice = (store: AppStore, host: string) =>
  [...store.collections.toasts.values()].find((row) => row.key === key(host))

const world = () => {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  let answer: ((call: typeof calls[number]) => Response | Promise<Response>) | undefined
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === "GET" && path === "/api/user") return Response.json({ username: "will", is_admin: false })
      if (request.method === "GET" && path === "/api/cloud-auth/session") {
        return Response.json({ state: "signed-in", username: "will", expiresAt: null })
      }
      if (!path.endsWith("/egress-policy")) {
        return Response.json([])
      }
      const call = { method: request.method, path, body: await request.json().catch(() => null) }
      calls.push(call)
      if (answer) return answer(call)
      const body = call.body as { add?: string[] }
      return Response.json({ allow_domains: body.add ?? [], reloads: [] })
    }
  })
  cleanups.push(() => {
    server.stop(true)
  })
  return {
    origin: server.url.origin,
    calls,
    answer: (next: typeof answer) => {
      answer = next
    }
  }
}
const databasePath = () => {
  const dir = mkdtempSync(join(tmpdir(), "smithers-egress-requests-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, "app.sqlite")
}
const open = async (file: string, remote: ReturnType<typeof world>, beforeCommit?: () => Promise<void>) => {
  const db = new Database(file)
  const adapter = await openSqliteRowStorage({
    execute: async <Row>(sql: string, params: ReadonlyArray<unknown> = []) => {
      if (/^\s*COMMIT\b/i.test(sql)) await beforeCommit?.()
      const query = db.query(sql)
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return query.all(...params as []) as ReadonlyArray<Row>
      query.run(...params as [])
      return []
    },
    close: () => db.close()
  }, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION })
  const store = await createAppStore({
    kind: "opfs",
    ...adapter,
    storageEventApi: { addEventListener: () => {}, removeEventListener: () => {} }
  })
  if (store.collections.cloudSessions.get("cloud")?.state !== "signed-in") {
    await store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      admin: false,
      scopesPlain: null
    }).isPersisted.promise
    await store.dispatch({
      type: "cloud.session.loaded",
      actor: "system",
      state: "signed-in",
      username: "will",
      expiresAt: null,
      scopes: null
    }).isPersisted.promise
    await store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "will/smithers", org: "will", ownerKind: "user", name: "smithers", head: null }]
    }).isPersisted.promise
  }
  const ctx = createControllerContext(store, unavailableAgent, {
    baseUrl: remote.origin,
    fetchImpl: fetch,
    toastAutoDismissMs: 10_000
  })
  const failures = createFailureController(ctx)
  const context = {
    http: (input: string, init?: RequestInit) => ctx.http(input, init),
    baseUrl: remote.origin,
    store,
    dispatch: store.dispatch,
    actor: () => "user" as const,
    nextOrdinal: store.nextOrdinal,
    isDisposed: () => ctx.disposed
  }
  const seam = createEgressSeam(context, failures.withToast)
  let closed = false
  const dispose = async () => {
    if (closed) return
    closed = true
    await ctx.dispose()
    await store.dispose?.()
  }
  cleanups.push(dispose)
  return { store, db, ctx, context, failures, seam, dispose }
}

test("an unresolved atomic add has a durable request before acknowledgment and a real running toast", async () => {
  const remote = world(), pending = hold<Response>()
  remote.answer(() => pending.promise)
  const h = await open(databasePath(), remote)
  try {
    expect(await h.seam.allowEgressHost(" API.Example.com. ", "will/smithers")).toEqual({
      value: "Allowing api.example.com for will/smithers."
    })
    expect(requests(h.store)).toMatchObject([{
      owner: "will",
      repo: "will/smithers",
      host: "api.example.com",
      state: "requested"
    }])
    const saved = h.db.query(`SELECT value FROM ${ROW_TABLE_NAME} WHERE collection_id = 'app-sessions'`).all() as Array<
      { value: string }
    >
    expect(saved.map((row) => row.value).join("\n")).toContain("\"host\":\"api.example.com\"")
    await waitFor(() => remote.calls.length === 1 && notice(h.store, "api.example.com")?.status === "running")
    expect(remote.calls).toEqual([{
      method: "PATCH",
      path: "/api/repos/will/smithers/egress-policy",
      body: { add: ["api.example.com"] }
    }])
    pending.resolve(Response.json({ allow_domains: ["api.example.com"], reloads: [] }))
    await waitFor(() =>
      requests(h.store)[0]?.state === "completed" && notice(h.store, "api.example.com")?.status === "ok"
    )
  } finally {
    pending.resolve(Response.json({}))
    await h.dispose()
  }
})

test("an admission waits only for its SQLite commit, never the unresolved network launch", async () => {
  const remote = world(), response = hold<Response>(), reached = hold<void>(), commit = hold<void>()
  remote.answer(() => response.promise)
  let blocked = false
  const h = await open(databasePath(), remote, async () => {
    if (blocked) {
      reached.resolve()
      await commit.promise
    }
  })
  let answered = false
  try {
    blocked = true
    const acknowledgment = h.seam.allowEgressHost("api.example.com", "will/smithers").then((value) => {
      answered = true
      return value
    })
    await reached.promise
    expect(answered).toBe(false)
    expect(remote.calls).toEqual([])
    blocked = false
    commit.resolve()
    expect(await acknowledgment).toEqual({ value: "Allowing api.example.com for will/smithers." })
    await waitFor(() => remote.calls.length === 1)
    expect(requests(h.store)[0]?.state).toBe("requested")
    response.resolve(Response.json({ allow_domains: ["api.example.com"], reloads: [] }))
    await waitFor(() => requests(h.store)[0]?.state === "completed")
  } finally {
    blocked = false
    commit.resolve()
    response.resolve(Response.json({}))
    await h.dispose()
  }
})

test("distinct host admissions preserve both intents while the first SQLite commit is held", async () => {
  const remote = world(), response = hold<Response>(), reached = hold<void>(), commit = hold<void>()
  remote.answer(() => response.promise)
  let blocked = false
  const file = databasePath(),
    first = await open(file, remote, async () => {
      if (blocked) {
        reached.resolve()
        await commit.promise
      }
    })
  const agent = createEgressSeam({ ...first.context, actor: () => "smithers" as const }, first.failures.withToast)
  let answers = 0
  try {
    blocked = true
    const a = first.seam.allowEgressHost("a.example.com", "will/smithers").then((value) => {
      answers += 1
      return value
    })
    await reached.promise
    const b = agent.allowEgressHost("b.example.com", "will/smithers").then((value) => {
      answers += 1
      return value
    })
    expect(requests(first.store).map((row) => row.host)).toEqual(["a.example.com", "b.example.com"])
    expect(answers).toBe(0)
    expect(remote.calls).toEqual([])
    blocked = false
    commit.resolve()
    expect(await Promise.all([a, b])).toEqual([
      { value: "Allowing a.example.com for will/smithers." },
      { value: "Allowing b.example.com for will/smithers." }
    ])
    const reader = new Database(file, { readonly: true })
    try {
      const saved = reader.query(`SELECT value FROM ${ROW_TABLE_NAME} WHERE collection_id = 'app-sessions'`)
        .all() as Array<{ value: string }>
      const rows = JSON.parse(saved.find((row) => JSON.parse(row.value).egressRequests)?.value ?? "{}").egressRequests
      expect(rows.map((row: { host: string; state: string }) => [row.host, row.state])).toEqual([
        ["a.example.com", "requested"],
        ["b.example.com", "requested"]
      ])
    } finally {
      reader.close()
    }
    await waitFor(() => remote.calls.length === 1)
    await first.dispose()
    remote.answer((call) => Response.json({ allow_domains: (call.body as { add: string[] }).add, reloads: [] }))
    const second = await open(file, remote)
    expect(requests(second.store).map((row) => [row.host, row.state])).toEqual([
      ["a.example.com", "requested"],
      ["b.example.com", "requested"]
    ])
    second.seam.resumeEgressRequests()
    await waitFor(() => requests(second.store).every((row) => row.state === "completed"))
    expect(remote.calls.map((call) => call.body)).toEqual([
      { add: ["a.example.com"] },
      { add: ["a.example.com"] },
      { add: ["b.example.com"] }
    ])
    expect((await second.store.verifyState()).valid).toBe(true)
  } finally {
    blocked = false
    commit.resolve()
    response.resolve(Response.json({}))
    await first.dispose()
  }
})

test("the terminal SQLite receipt commits before the real running toast can settle", async () => {
  const remote = world(), response = hold<Response>(), reached = hold<void>(), commit = hold<void>()
  remote.answer(() => response.promise)
  let blocked = false
  const file = databasePath()
  const h = await open(file, remote, async () => {
    if (blocked) {
      reached.resolve()
      await commit.promise
    }
  })
  try {
    await h.seam.allowEgressHost("api.example.com", "will/smithers")
    await waitFor(() => notice(h.store, "api.example.com")?.status === "running")
    blocked = true
    response.resolve(Response.json({ allow_domains: ["api.example.com"], reloads: [] }))
    await reached.promise
    expect(notice(h.store, "api.example.com")?.status).toBe("running")
    const reader = new Database(file, { readonly: true })
    try {
      const saved = reader.query(`SELECT value FROM ${ROW_TABLE_NAME} WHERE collection_id = 'app-sessions'`)
        .all() as Array<{ value: string }>
      expect(saved.map((row) => row.value).join("\n")).toContain("\"state\":\"requested\"")
    } finally {
      reader.close()
    }
    blocked = false
    commit.resolve()
    await waitFor(() => notice(h.store, "api.example.com")?.status === "ok")
    expect(requests(h.store)[0]?.state).toBe("completed")
  } finally {
    blocked = false
    commit.resolve()
    response.resolve(Response.json({}))
    await h.dispose()
  }
})

test("reload reconnects both a queued addition and an unresolved PATCH, with their shared toasts", async () => {
  const remote = world(), old = hold<Response>(), resumed = hold<Response>(), queued = hold<Response>()
  remote.answer(() => [old.promise, resumed.promise, queued.promise][remote.calls.length - 1]!)
  const file = databasePath(), first = await open(file, remote)
  try {
    await first.seam.allowEgressHost("a.example.com", "will/smithers")
    await waitFor(() => remote.calls.length === 1)
    await first.seam.allowEgressHost("b.example.com", "will/smithers")
    await waitFor(() =>
      notice(first.store, "a.example.com")?.status === "running" &&
      notice(first.store, "b.example.com")?.status === "running"
    )
    await first.store.settled?.()
    expect(remote.calls).toHaveLength(1)
    expect(requests(first.store).map((row) => row.state)).toEqual(["requested", "requested"])
    await first.dispose()
    const second = await open(file, remote)
    second.seam.resumeEgressRequests()
    second.seam.resumeEgressRequests()
    await waitFor(() => remote.calls.length === 2)
    expect(remote.calls.map((call) => call.body)).toEqual([{ add: ["a.example.com"] }, { add: ["a.example.com"] }])
    await waitFor(() => notice(second.store, "b.example.com")?.status === "running")
    // The old controller's late answer cannot settle the reopened requests.
    old.resolve(Response.json({ allow_domains: ["a.example.com"], reloads: [] }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests(second.store).map((row) => row.state)).toEqual(["requested", "requested"])
    resumed.resolve(Response.json({ allow_domains: ["a.example.com"], reloads: [] }))
    await waitFor(() => remote.calls.length === 3)
    expect(remote.calls[2]?.body).toEqual({ add: ["b.example.com"] })
    expect(notice(second.store, "b.example.com")?.status).toBe("running")
    queued.resolve(Response.json({ allow_domains: ["a.example.com", "b.example.com"], reloads: [] }))
    await waitFor(() =>
      requests(second.store).every((row) => row.state === "completed") &&
      notice(second.store, "b.example.com")?.status === "ok"
    )
    expect((await second.store.verifyState()).valid).toBe(true)
  } finally {
    for (const response of [old, resumed, queued]) response.resolve(Response.json({}))
    await first.dispose()
  }
})

test("user and agent seams share one durable admission and one write, including while its commit waits", async () => {
  const remote = world(), response = hold<Response>(), reached = hold<void>(), commit = hold<void>()
  remote.answer(() => response.promise)
  let blocked = false
  const h = await open(databasePath(), remote, async () => {
    if (blocked) {
      reached.resolve()
      await commit.promise
    }
  })
  const agent = createEgressSeam({ ...h.context, actor: () => "smithers" as const }, h.failures.withToast)
  try {
    blocked = true
    const first = h.seam.allowEgressHost("api.example.com", "will/smithers")
    await reached.promise
    const duplicate = agent.allowEgressHost(" API.EXAMPLE.com. ", "will/smithers")
    expect(requests(h.store)).toHaveLength(1)
    expect(remote.calls).toEqual([])
    blocked = false
    commit.resolve()
    expect(await duplicate).toEqual(await first)
    await waitFor(() => remote.calls.length === 1)
    h.seam.resumeEgressRequests()
    agent.resumeEgressRequests()
    expect(remote.calls).toHaveLength(1)
    response.resolve(Response.json({ allow_domains: ["api.example.com"], reloads: [] }))
    await waitFor(() => requests(h.store)[0]?.state === "completed")
    const admissions = (await h.store.eventHistory()).events.filter((event) => {
      if (event.type !== "egress.requests.changed") return false
      const transition = APP_TRANSITION_SCHEMAS["egress.requests.changed"].parse(decodeEventValue(event.input))
      return transition.type === "egress.requests.changed" && transition.requests[0]?.state === "requested"
    })
    expect(admissions).toHaveLength(1)
    expect(admissions[0]?.actor).toBe("user")
  } finally {
    blocked = false
    commit.resolve()
    response.resolve(Response.json({}))
    await h.dispose()
  }
})

for (const change of ["sign-out", "cloud-account", "identity-account"] as const) {
  test(`${change} retires pending egress intent and fences late replies`, async () => {
    const remote = world(), late = hold<Response>()
    remote.answer(() => late.promise)
    const h = await open(databasePath(), remote)
    try {
      await h.seam.allowEgressHost("a.example.com", "will/smithers")
      await waitFor(() => remote.calls.length === 1)
      await h.seam.allowEgressHost("b.example.com", "will/smithers")
      await waitFor(() => notice(h.store, "a.example.com")?.status === "running")
      if (change === "identity-account") {
        await h.store.dispatch({
          type: "identity.session.loaded",
          actor: "system",
          state: "signed-in",
          login: "bob",
          admin: false,
          scopesPlain: null
        }).isPersisted.promise
      } else {await h.store.dispatch({
          type: "cloud.session.loaded",
          actor: "system",
          state: change === "sign-out" ? "signed-out" : "signed-in",
          username: change === "sign-out" ? null : "bob",
          expiresAt: null,
          scopes: null
        }).isPersisted.promise}
      expect(requests(h.store)).toEqual([])
      expect([...h.store.collections.toasts.values()].filter((row) => row.key.startsWith("egress-allow:"))).toEqual([])
      late.resolve(Response.json({ allow_domains: ["a.example.com"], reloads: [] }))
      await new Promise((resolve) => setTimeout(resolve, 20))
      h.seam.resumeEgressRequests()
      expect(remote.calls).toHaveLength(1)
      expect(requests(h.store)).toEqual([])
    } finally {
      late.resolve(Response.json({}))
      await h.dispose()
    }
  })
}

test("a transient Cloud probe retains requests and same-owner recovery deduplicates the replay", async () => {
  const remote = world(), late = hold<Response>(), fresh = hold<Response>()
  remote.answer(() => remote.calls.length === 1 ? late.promise : fresh.promise)
  const h = await open(databasePath(), remote)
  try {
    await h.seam.allowEgressHost("api.example.com", "will/smithers")
    await waitFor(() => remote.calls.length === 1)
    await h.store.dispatch({
      type: "cloud.session.loaded",
      actor: "system",
      state: "signing-in",
      username: null,
      expiresAt: null,
      scopes: null
    }).isPersisted.promise
    h.seam.resumeEgressRequests()
    expect(requests(h.store)[0]?.state).toBe("requested")
    expect(remote.calls).toHaveLength(1)
    await h.store.dispatch({
      type: "cloud.session.loaded",
      actor: "system",
      state: "signed-in",
      username: "will",
      expiresAt: null,
      scopes: null
    }).isPersisted.promise
    h.seam.resumeEgressRequests()
    h.seam.resumeEgressRequests()
    // The old unresolved HTTP promise is superseded and does not block reauthorization.
    await waitFor(() => remote.calls.length === 2)
    late.resolve(Response.json({ allow_domains: ["api.example.com"], reloads: [] }))
    expect(requests(h.store)[0]?.state).toBe("requested")
    fresh.resolve(Response.json({ allow_domains: ["api.example.com"], reloads: [] }))
    await waitFor(() => requests(h.store)[0]?.state === "completed")
  } finally {
    late.resolve(Response.json({}))
    fresh.resolve(Response.json({}))
    await h.dispose()
  }
})

test("a failed sandbox reload is durable, restores its failed toast without a write, and retries explicitly", async () => {
  const remote = world(), retry = hold<Response>()
  remote.answer(() => Response.json({ allow_domains: ["api.example.com"], reloads: [{ reloaded: false }] }))
  const file = databasePath(), first = await open(file, remote)
  await first.seam.allowEgressHost("api.example.com", "will/smithers")
  await waitFor(() =>
    requests(first.store)[0]?.state === "failed" && notice(first.store, "api.example.com")?.status === "failed"
  )
  const error = "api.example.com allowed; 1 running box gets it on restart."
  expect(requests(first.store)[0]?.error).toBe(error)
  await first.store.dispatch({
    type: "toast.dismissed",
    actor: "system",
    id: notice(first.store, "api.example.com")!.id
  }).isPersisted.promise
  await first.dispose()
  const second = await open(file, remote)
  second.seam.resumeEgressRequests()
  await waitFor(() => notice(second.store, "api.example.com")?.status === "failed")
  expect(notice(second.store, "api.example.com")?.detail).toBe(error)
  expect(remote.calls).toHaveLength(1)
  remote.answer(() => retry.promise)
  try {
    await second.seam.allowEgressHost("api.example.com", "will/smithers")
    await waitFor(() => remote.calls.length === 2 && notice(second.store, "api.example.com")?.status === "running")
    expect(requests(second.store)[0]).not.toHaveProperty("error")
    retry.resolve(Response.json({ allow_domains: ["api.example.com"], reloads: [] }))
    await waitFor(() =>
      requests(second.store)[0]?.state === "completed" && notice(second.store, "api.example.com")?.status === "ok"
    )
  } finally {
    retry.resolve(Response.json({}))
    await second.dispose()
  }
})

test("a rejected SQLite admission is never acknowledged or sent over HTTP", async () => {
  const remote = world()
  let fail = false
  const h = await open(databasePath(), remote, async () => {
    if (fail) throw new Error("fixture disk failure")
  })
  fail = true
  try {
    const answer = await h.seam.allowEgressHost("api.example.com", "will/smithers")
    expect(typeof answer).toBe("string")
    expect(answer).not.toEqual({ value: "Allowing api.example.com for will/smithers." })
    expect(remote.calls).toEqual([])
    expect([...h.store.collections.toasts.values()].filter((row) => row.key.startsWith("egress-allow:"))).toEqual([])
  } finally {
    fail = false
    await expect(h.dispose()).rejects.toThrow("fixture disk failure")
  }
})

test("bounded terminal receipts never evict any requested host", async () => {
  const remote = world(), response = hold<Response>()
  remote.answer(() => response.promise)
  const h = await open(databasePath(), remote)
  const rows = Array.from(
    { length: 132 },
    (_, n) => ({
      id: key(`${n}.example.com`),
      owner: "will",
      repo: "will/smithers",
      host: `${n}.example.com`,
      state: n < 65 ? "requested" as const : "completed" as const
    })
  )
  await h.store.dispatch({ type: "egress.requests.changed", actor: "system", requests: rows }).isPersisted.promise
  try {
    await h.seam.allowEgressHost("new.example.com", "will/smithers")
    expect(requests(h.store).filter((row) => row.state === "requested")).toHaveLength(66)
    expect(requests(h.store).filter((row) => row.state === "completed")).toHaveLength(64)
    response.resolve(Response.json({ allow_domains: ["new.example.com"], reloads: [] }))
    await waitFor(() => requests(h.store).find((row) => row.host === "new.example.com")?.state === "completed")
    expect(requests(h.store).filter((row) => row.state === "requested").map((row) => row.host)).toEqual(
      rows.slice(0, 65).map((row) => row.host)
    )
    expect(requests(h.store).filter((row) => row.state === "completed")).toHaveLength(64)
  } finally {
    response.resolve(Response.json({}))
    await h.dispose()
  }
})

test("completed work never replays, but its interrupted running notice settles from the durable receipt", async () => {
  const remote = world(), h = await open(databasePath(), remote)
  const id = key("api.example.com")
  await h.store.dispatch({
    type: "egress.requests.changed",
    actor: "system",
    requests: [{ id, owner: "will", repo: "will/smithers", host: "api.example.com", state: "completed" }]
  }).isPersisted.promise
  h.seam.resumeEgressRequests()
  expect([...h.store.collections.toasts.values()]).toEqual([])
  await h.store.dispatch({ type: "toast.shown", actor: "system", key: id, title: "Allowing api.example.com…" })
    .isPersisted.promise
  h.seam.resumeEgressRequests()
  h.seam.resumeEgressRequests()
  await waitFor(() => notice(h.store, "api.example.com")?.status === "ok")
  expect(remote.calls).toEqual([])
})

test("a degraded owner settles its pending request as refused without a remote write", async () => {
  const remote = world(), h = await open(databasePath(), remote)
  const id = key("api.example.com")
  await h.store.dispatch({
    type: "egress.requests.changed",
    actor: "system",
    requests: [{ id, owner: "will", repo: "will/smithers", host: "api.example.com", state: "requested" }]
  }).isPersisted.promise
  await h.store.dispatch({
    type: "cloud.session.loaded",
    actor: "system",
    state: "signed-in",
    username: "will",
    expiresAt: null,
    scopes: "degraded"
  }).isPersisted.promise
  h.seam.resumeEgressRequests()
  await waitFor(() =>
    requests(h.store)[0]?.state === "failed" && notice(h.store, "api.example.com")?.status === "failed"
  )
  expect(remote.calls).toEqual([])
  expect(requests(h.store)[0]?.error).toContain("sign in again")
})

test("the actual app command acknowledges its persisted request, keeps Chat editable and reconnects on controller startup", async () => {
  const remote = world(), firstResponse = hold<Response>(), secondResponse = hold<Response>()
  remote.answer(() => remote.calls.length === 1 ? firstResponse.promise : secondResponse.promise)
  const file = databasePath(), first = await open(file, remote)
  const start = (store: AppStore) => {
    const controller = createAppController(store, unavailableAgent, {
      baseUrl: remote.origin,
      fetchImpl: fetch,
      applicationIdentity: applicationIdentityFromFetch(fetch, remote.origin),
      bootstrap: {
        apiVersion: 1,
        host: "cloud",
        version: "test",
        buildSha: "test",
        capabilities: ["identity", "cloud"],
        authFlow: "redirect",
        sandbox: null
      },
      toastAutoDismissMs: 10_000
    })
    cleanups.push(() => controller.dispose())
    return controller
  }
  const controller = start(first.store)
  try {
    expect(await controller.commands.run("egress.allow", "api.example.com will/smithers")).toMatchObject({
      status: "executed",
      value: "Allowing api.example.com for will/smithers."
    })
    expect(requests(first.store)[0]?.state).toBe("requested")
    await waitFor(() => remote.calls.length === 1 && notice(first.store, "api.example.com")?.status === "running")
    controller.showChat()
    controller.changeDraft("Chat stays usable")
    expect(first.store.session().draft).toBe("Chat stays usable")
    expect(first.store.session().phase).toBe("idle")
    await first.store.settled?.()
    await controller.dispose()
    await first.dispose()
    const second = await open(file, remote), reopened = start(second.store)
    // No manual resume call: AppController's real startup door must reconnect it.
    await waitFor(() => remote.calls.length === 2 && notice(second.store, "api.example.com")?.status === "running")
    reopened.changeDraft("Still usable after reload")
    expect(second.store.session().draft).toBe("Still usable after reload")
    firstResponse.resolve(Response.json({ allow_domains: ["api.example.com"], reloads: [] }))
    expect(requests(second.store)[0]?.state).toBe("requested")
    secondResponse.resolve(Response.json({ allow_domains: ["api.example.com"], reloads: [] }))
    await waitFor(() =>
      requests(second.store)[0]?.state === "completed" && notice(second.store, "api.example.com")?.status === "ok"
    )
    expect(remote.calls).toHaveLength(2)
    await reopened.dispose()
  } finally {
    firstResponse.resolve(Response.json({}))
    secondResponse.resolve(Response.json({}))
    await controller.dispose()
    await first.dispose()
  }
})

test("a genuine v29 SQLite checkpoint upgrades once, preserves Chat and accepts durable egress work", async () => {
  const remote = world(), file = databasePath(), first = await open(file, remote)
  await first.store.dispatch({ type: "composer.changed", actor: "user", draft: "Existing conversation" }).isPersisted
    .promise
  await first.store.compactEvents()
  const old = await first.store.eventHistory()
  expect(old.checkpoint.snapshot.sessions?.[0]).not.toHaveProperty("egressRequests")
  const head = { ...old.head, projectorVersion: 29 }
  const { hash: _hash, ...body } = { ...old.checkpoint, projectorVersion: 29 }
  const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
  await first.dispose()
  const db = new Database(file)
  try {
    for (const [id, value] of [["app-event-heads", head], ["app-event-checkpoints", checkpoint]] as const) {
      expect(
        db.query(`UPDATE ${ROW_TABLE_NAME} SET value = ? WHERE collection_id = ?`).run(JSON.stringify(value), id)
          .changes
      ).toBe(1)
    }
  } finally {
    db.close()
  }
  const second = await open(file, remote), history = await second.store.eventHistory()
  expect(history.checkpoint.reason).toBe("projector-upgrade")
  expect(history.head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
  expect(history.head.streamId).not.toBe(old.head.streamId)
  expect(second.store.session().draft).toBe("Existing conversation")
  expect(second.store.session()).not.toHaveProperty("egressRequests")
  expect((await second.store.verifyState()).valid).toBe(true)
  await second.seam.allowEgressHost("api.example.com", "will/smithers")
  await waitFor(() => requests(second.store)[0]?.state === "completed")
  await second.dispose()
  const third = await open(file, remote)
  expect((await third.store.eventHistory()).head.streamId).toBe(history.head.streamId)
  expect(third.store.session().draft).toBe("Existing conversation")
  expect(requests(third.store)[0]).toMatchObject({ owner: "will", host: "api.example.com", state: "completed" })
  expect((await third.store.verifyState()).valid).toBe(true)
})

test("a terminal SQLite failure retains the durable pending intent and replays safely on a healthy reload", async () => {
  const remote = world(), response = hold<Response>()
  remote.answer(() => response.promise)
  let fail = false
  const file = databasePath(),
    first = await open(file, remote, async () => {
      if (fail) throw new Error("fixture terminal disk failure")
    })
  const reports: unknown[] = []
  const seam = createEgressSeam({
    ...first.context,
    report: (_subject, error) => {
      reports.push(error)
    }
  }, first.failures.withToast)
  try {
    await seam.allowEgressHost("api.example.com", "will/smithers")
    await waitFor(() => remote.calls.length === 1 && notice(first.store, "api.example.com")?.status === "running")
    fail = true
    response.resolve(Response.json({ allow_domains: ["api.example.com"], reloads: [] }))
    await waitFor(() => reports.length > 0)
    // A rejected local receipt is a storage failure, never an egress success.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reports.some((error) => error instanceof Error && error.message === "fixture terminal disk failure")).toBe(
      true
    )
    expect(notice(first.store, "api.example.com")?.status).toBe("running")
    expect(first.store.committedToast(`toast-${key("api.example.com")}`)?.status).toBe("running")
    const reader = new Database(file, { readonly: true })
    try {
      const saved = reader.query(`SELECT value FROM ${ROW_TABLE_NAME} WHERE collection_id = 'app-sessions'`)
        .all() as Array<{ value: string }>
      expect(saved.map((row) => row.value).join("\n")).toContain("\"state\":\"requested\"")
      expect(saved.map((row) => row.value).join("\n")).not.toContain("\"state\":\"completed\"")
    } finally {
      reader.close()
    }
    fail = false
    await expect(first.dispose()).rejects.toThrow("fixture terminal disk failure")
    remote.answer(() => Response.json({ allow_domains: ["api.example.com"], reloads: [] }))
    const second = await open(file, remote)
    expect(requests(second.store)[0]?.state).toBe("requested")
    second.seam.resumeEgressRequests()
    await waitFor(() => requests(second.store)[0]?.state === "completed")
    expect(remote.calls).toHaveLength(2)
    expect(remote.calls.map((call) => call.body)).toEqual([{ add: ["api.example.com"] }, { add: ["api.example.com"] }])
    expect((await second.store.verifyState()).valid).toBe(true)
  } finally {
    fail = false
    response.resolve(Response.json({}))
    await first.dispose()
  }
})
