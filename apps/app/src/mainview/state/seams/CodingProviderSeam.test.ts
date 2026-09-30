import { afterEach, expect, test } from "bun:test"
import { writeOnlyGesture } from "../../flows/CommandGesture"
import { createSecretsSeam } from "./SecretsSeam"
import type { SeamContext } from "./SeamContext"
import type { FailureController } from "../controller/failures"
import { createAppStore, type AppStore, type PersistenceBackend } from "../AppStore"
import { SessionSchema } from "../AppState"
import { isRecord } from "@smthrs/canonical/Record"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
type RequestRow = NonNullable<ReturnType<SeamContext["store"]["session"]>["codingProviderRequests"]>[number]
function harness(options: {
  persist?: (rows: RequestRow[]) => Promise<void>
  http: (init: RequestInit | undefined, rows: RequestRow[]) => Promise<Response>
}) {
  let rows: RequestRow[] = []
  let ownerRevision = 1
  let login = "alice"
  let disposed = false
  const calls: RequestInit[] = []
  const messages: string[] = []
  const work: Promise<unknown>[] = []
  const ctx = {
    baseUrl: "https://smithers.sh", isDisposed: () => disposed,
    store: { session: () => ({ codingProviderRequests: rows }), collections: {
      identitySessions: { get: () => ({ login, ownerRevision }) },
      cloudSessions: { get: () => ({ state: "signed-in", ownerRevision }) }
    } },
    dispatch: (event: { type: string; requests?: RequestRow[]; text?: string }) => {
      if (event.type === "message.appended") messages.push(event.text ?? "")
      if (event.requests) rows = event.requests
      return { isPersisted: { promise: event.requests ? options.persist?.(rows) ?? Promise.resolve() : Promise.resolve() } }
    },
    http: (_path: string, init?: RequestInit) => { calls.push(init ?? {}); return options.http(init, rows) }
  } as unknown as SeamContext
  const withToast = ((_key: string, _title: string, _done: string, task: () => Promise<unknown>) => {
    const pending = task(); work.push(pending); return pending
  }) as FailureController["withToast"]
  return {
    seam: createSecretsSeam(ctx, withToast), calls, messages, work, rows: () => rows,
    account: (next: string) => { login = next; ownerRevision++ },
    dispose: () => { disposed = true }
  }
}

test("admission waits only for durable intent, including duplicate input", async () => {
  const persisted = deferred<void>()
  const response = deferred<Response>()
  const h = harness({ persist: () => persisted.promise, http: () => response.promise })
  const gesture = () => writeOnlyGesture("secrets.connect", { value: "sk-ant-api03-fixture" })
  let acknowledged = false
  const first = h.seam.connectCodingProvider(gesture()).then(value => { acknowledged = true; return value })
  const duplicate = h.seam.connectCodingProvider(gesture())
  await tick()
  expect(acknowledged).toBe(false)
  expect(h.calls).toHaveLength(0)
  persisted.resolve()
  expect(await first).toEqual({ value: "Requested" })
  expect(await duplicate).toEqual({ value: "Requested" })
  expect(h.calls).toHaveLength(1)
  response.resolve(Response.json({ id: "conn-1", provider: "claude", state: "active", label: `web-${h.rows()[0]!.id}` }))
  expect(await h.work[0]).toBe(true)
})

test("failed intent persistence never launches or acknowledges enrollment or revocation", async () => {
  for (const action of ["connect", "revoke"] as const) {
    const h = harness({ persist: () => Promise.reject(new Error("storage unavailable")), http: async () => Response.json({}) })
    const result = action === "connect"
      ? await h.seam.connectCodingProvider(writeOnlyGesture("secrets.connect", { value: "sk-ant-api03-fixture" }))
      : await h.seam.revokeCodingProvider("conn-1")
    expect(result).toBe("Connection request could not be saved.")
    expect(h.calls).toHaveLength(0)
    expect(h.work).toHaveLength(0)
  }
})

test("missing or non-string IDs cannot be successful provider receipts", async () => {
  for (const id of [undefined, null, 123]) {
    const h = harness({ http: async (_init, rows) => Response.json({ id, provider: "claude", state: "active", label: `web-${rows[0]!.id}` }) })
    await h.seam.connectCodingProvider(writeOnlyGesture("secrets.connect", { value: "sk-ant-api03-fixture" }))
    expect(await h.work[0]).toBe("Claude connection failed.")
    expect(h.rows()[0]?.state).toBe("failed")
  }
})

test("failure notification waits for the durable terminal receipt", async () => {
  const persisted = deferred<void>()
  const h = harness({
    persist: rows => rows[0]?.state === "failed" ? persisted.promise : Promise.resolve(),
    http: async () => new Response(null, { status: 403 })
  })
  await h.seam.revokeCodingProvider("conn-1")
  let settled = false
  const final = h.work[0]!.then(value => { settled = true; return value })
  await tick()
  expect(settled).toBe(false)
  expect(h.messages).toEqual([])
  persisted.resolve()
  expect(await final).toBe("Connection revocation failed (HTTP 403).")
})

test("revoke deduplicates live work and reconnects after A to B to A", async () => {
  const old = deferred<Response>()
  const current = deferred<Response>()
  let deletes = 0
  const h = harness({ http: async init => {
    if (init?.method === "DELETE") return ++deletes === 1 ? old.promise : current.promise
    return Response.json([{ id: "conn-1", provider: "claude", state: "active", label: "web-request" }])
  } })
  await h.seam.revokeCodingProvider("conn-1")
  h.seam.resumeCodingProviders()
  await h.seam.revokeCodingProvider("conn-1")
  expect(h.calls).toHaveLength(1)
  h.account("bob"); h.account("alice")
  h.seam.resumeCodingProviders()
  await tick()
  expect(deletes).toBe(2)
  old.resolve(new Response(null, { status: 204 }))
  expect(await h.work[0]).not.toBe(true)
  await h.seam.revokeCodingProvider("conn-1")
  expect(deletes).toBe(2)
  current.resolve(new Response(null, { status: 204 }))
  expect(await h.work[1]).toBe(true)
  expect(h.rows()[0]?.state).toBe("completed")
})

test("disposal while response JSON is held cannot publish a connection", async () => {
  const parsed = deferred<unknown>()
  const h = harness({ http: async () => ({ ok: true, json: () => parsed.promise } as Response) })
  await h.seam.connectCodingProvider(writeOnlyGesture("secrets.connect", { value: "sk-ant-api03-fixture" }))
  await tick()
  h.dispose()
  parsed.resolve({ id: "conn-1", provider: "claude", state: "active", label: `web-${h.rows()[0]!.id}` })
  expect(await h.work[0]).not.toBe(true)
  expect(h.rows()[0]?.state).toBe("requested")
  expect(h.messages).toEqual([])
})

test("Claude coding enrollment returns before the held request, deduplicates, and never persists a token", async () => {
  const hold = deferred<Response>()
  const sent: Array<{ path: string; init?: RequestInit }> = []
  const notices: string[] = []
  let settled: Promise<unknown> | undefined
  let login = "alice"
  let rows: Array<{ id: string; owner: string; state: "requested" | "completed" | "failed" }> = []
  const ctx = {
    baseUrl: "https://smithers.sh", store: { session: () => ({ codingProviderRequests: rows }), collections: { identitySessions: { get: () => ({ login, ownerRevision: login }) }, cloudSessions: { get: () => ({ state: "signed-in", ownerRevision: login }) } } },
    dispatch: (event: { type: string; requests?: typeof rows }) => { if (event.type === "coding.provider.requests.changed") rows = event.requests ?? []; return { isPersisted: { promise: Promise.resolve() } } },
    http: (path: string, init?: RequestInit) => { sent.push({ path, init }); return hold.promise }
  } as unknown as SeamContext
  const withToast = ((_key: string, title: string, _done: string, work: () => Promise<unknown>) => {
    notices.push(title)
    settled = work()
    return settled
  }) as FailureController["withToast"]
  const seam = createSecretsSeam(ctx, withToast)
  const value = "sk-ant-api03-private-fixture"
  const gesture = writeOnlyGesture("secrets.connect", { value })
  expect(await seam.connectCodingProvider(gesture)).toEqual({ value: "Requested" })
  expect(await seam.connectCodingProvider(writeOnlyGesture("secrets.connect", { value }))).toEqual({ value: "Requested" })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(sent).toHaveLength(1)
  expect(notices).toHaveLength(1)
  expect(JSON.stringify([notices, await seam.connectCodingProvider(writeOnlyGesture("secrets.connect", { value }))])).not.toContain(value)
  expect(sent[0]?.init?.body).toContain(value)
  hold.resolve(Response.json({ id: "conn-1", provider: "claude", state: "active", label: `web-${rows[0]?.id}` }, { status: 201 }))
  expect(await settled).toBe(true)
  expect(rows[0]).toMatchObject({ owner: "alice", state: "completed" })
  expect(gesture.takeWriteOnly?.("value")).toBeUndefined()
  login = "bob"
  expect(await seam.connectCodingProvider(writeOnlyGesture("secrets.connect", { value: "bad" }))).toBe("Enter an Anthropic API key.")
  expect(sent).toHaveLength(1)
})

test("revocation is account scoped and reports failure instead of success", async () => {
  let login = "alice"
  const calls: string[] = []
  const ctx = {
    baseUrl: "https://smithers.sh", store: { session: () => ({ codingProviderRequests: [] }), collections: { identitySessions: { get: () => ({ login, ownerRevision: login }) }, cloudSessions: { get: () => ({ state: "signed-in", ownerRevision: login }) } } },
    dispatch: () => ({ isPersisted: { promise: Promise.resolve() } }),
    http: async (path: string) => { calls.push(path); return new Response(null, { status: 403 }) }
  } as unknown as SeamContext
  let settled: Promise<unknown> | undefined
  const withToast = ((_key: string, _title: string, _done: string, work: () => Promise<unknown>) => {
    settled = work()
    return settled
  }) as FailureController["withToast"]
  const seam = createSecretsSeam(ctx, withToast)
  expect(await seam.revokeCodingProvider("../other")).toBe("Invalid connection.")
  expect(await seam.revokeCodingProvider("conn-1")).toEqual({ value: "Requested" })
  expect(await settled).toBe("Connection revocation failed (HTTP 403).")
  expect(calls).toEqual(["https://smithers.sh/api/user/provider-connections/conn-1"])
  login = "bob"
  expect(await seam.listCodingProviders()).toBe("Coding connections unavailable (HTTP 403).")
})

test("reload reconciles a safe request id from account metadata without replaying a token", async () => {
  let rows: Array<{ id: string; owner: string; state: "requested" | "completed" | "failed" }> = [{ id: "request-1", owner: "alice", state: "requested" }]
  const calls: Array<{ path: string; init?: RequestInit }> = []
  let settled: Promise<unknown> | undefined
  const ctx = {
    baseUrl: "https://smithers.sh",
    store: { session: () => ({ codingProviderRequests: rows }), collections: { identitySessions: { get: () => ({ login: "alice", ownerRevision: "alice" }) }, cloudSessions: { get: () => ({ state: "signed-in", ownerRevision: "alice" }) } } },
    dispatch: (event: { type: string; requests?: typeof rows }) => { if (event.type === "coding.provider.requests.changed") rows = event.requests ?? []; return { isPersisted: { promise: Promise.resolve() } } },
    http: async (path: string, init?: RequestInit) => { calls.push({ path, init }); return Response.json([{ id: "conn-1", provider: "claude", state: "active", label: "web-request-1" }]) }
  } as unknown as SeamContext
  const withToast = ((_key: string, _title: string, _done: string, work: () => Promise<unknown>) => { settled = work(); return settled }) as FailureController["withToast"]
  createSecretsSeam(ctx, withToast).resumeCodingProviders()
  expect(await settled).toBe(true)
  expect(rows[0]?.state).toBe("completed")
  expect(calls).toEqual([{ path: "https://smithers.sh/api/user/provider-connections", init: undefined }])
})

test("revoked reload receipt fails without claiming connection", async () => {
  let rows: Array<{ id: string; owner: string; state: "requested" | "completed" | "failed" }> = [{ id: "old", owner: "alice", state: "requested" }]
  const messages: string[] = []
  let settled: Promise<unknown> | undefined
  const ctx = {
    baseUrl: "https://smithers.sh",
    store: { session: () => ({ codingProviderRequests: rows }), collections: {
      identitySessions: { get: () => ({ login: "alice", ownerRevision: 1 }) },
      cloudSessions: { get: () => ({ state: "signed-in", ownerRevision: 1 }) }
    } },
    dispatch: (event: { type: string; requests?: typeof rows; text?: string }) => {
      if (event.type === "coding.provider.requests.changed") rows = event.requests ?? []
      if (event.type === "message.appended") messages.push(event.text ?? "")
      return { isPersisted: { promise: Promise.resolve() } }
    },
    http: async () => Response.json([{ id: "conn-1", provider: "claude", state: "revoked", label: "web-old" }])
  } as unknown as SeamContext
  const withToast = ((_key: string, _title: string, _done: string, work: () => Promise<unknown>) => { settled = work(); return settled }) as FailureController["withToast"]
  createSecretsSeam(ctx, withToast).resumeCodingProviders()
  expect(await settled).toBe("Claude connection is inactive. Retry with a fresh token.")
  expect(rows[0]?.state).toBe("failed")
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(messages.join(" ")).not.toContain("connected")
})

test("an A to B to A switch cannot publish the first account's response", async () => {
  const held = deferred<Response>()
  let revision = 1
  let login = "alice"
  let rows: unknown[] = []
  const messages: string[] = []
  let settled: Promise<unknown> | undefined
  const ctx = {
    baseUrl: "https://smithers.sh",
    store: { session: () => ({ codingProviderRequests: rows }), collections: {
      identitySessions: { get: () => ({ login, ownerRevision: revision }) },
      cloudSessions: { get: () => ({ state: "signed-in", ownerRevision: revision }) }
    } },
    dispatch: (event: { type: string; requests?: unknown[]; text?: string }) => {
      if (event.type === "coding.provider.requests.changed") rows = event.requests ?? []
      if (event.type === "message.appended") messages.push(event.text ?? "")
      return { isPersisted: { promise: Promise.resolve() } }
    },
    http: async () => held.promise
  } as unknown as SeamContext
  const withToast = ((_key: string, _title: string, _done: string, work: () => Promise<unknown>) => { settled = work(); return settled }) as FailureController["withToast"]
  const seam = createSecretsSeam(ctx, withToast)
  seam.connectCodingProvider(writeOnlyGesture("secrets.connect", { value: "sk-ant-api03-private-fixture" }))
  await new Promise(resolve => setTimeout(resolve, 0))
  login = "bob"; revision++
  login = "alice"; revision++
  held.resolve(Response.json({ id: "conn-1", provider: "claude", state: "active", label: `web-${(rows[0] as {id:string}).id}` }))
  expect(await settled).not.toBe(true)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect((rows[0] as {state:string}).state).toBe("requested")
  expect(messages).toEqual([])
})

test("a rejected or malformed enrollment receipt never completes the persisted request", async () => {
  for (const response of [new Response(null, { status: 400 }), Response.json({ id: "conn-1", provider: "claude", state: "revoked", label: "wrong" })]) {
    let rows: Array<{ id: string; owner: string; state: "requested" | "completed" | "failed" }> = []
    let settled: Promise<unknown> | undefined
    const ctx = {
      baseUrl: "https://smithers.sh",
      store: { session: () => ({ codingProviderRequests: rows }), collections: {
        identitySessions: { get: () => ({ login: "alice", ownerRevision: 1 }) },
        cloudSessions: { get: () => ({ state: "signed-in", ownerRevision: 1 }) }
      } },
      dispatch: (event: { type: string; requests?: typeof rows }) => {
        if (event.type === "coding.provider.requests.changed") rows = event.requests ?? []
        return { isPersisted: { promise: Promise.resolve() } }
      },
      http: async () => response
    } as unknown as SeamContext
    const withToast = ((_key: string, _title: string, _done: string, work: () => Promise<unknown>) => { settled = work(); return settled }) as FailureController["withToast"]
    await createSecretsSeam(ctx, withToast).connectCodingProvider(writeOnlyGesture("secrets.connect", { value: "sk-ant-api03-private-fixture" }))
    expect(await settled).not.toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(rows[0]?.state).toBe("failed")
    expect(JSON.stringify(rows)).not.toContain("private-fixture")
  }
})

/* Real-store harness: the durable request rows, one-shot gestures and persisted bytes are observed through AppStore. */
const pendingWork = new Set<Promise<unknown>>()
const retirements = new Set<() => void>()
const releases = new Set<() => void>()
const stores = new Set<AppStore>()
const unexpected: string[] = []
const track = <T>(task: Promise<T>): Promise<T> => {
  pendingWork.add(task)
  void task.then(() => pendingWork.delete(task), () => pendingWork.delete(task))
  return task
}
const gate = <T>() => {
  const gate = Promise.withResolvers<T>()
  void gate.promise.catch(() => {})
  releases.add(() => gate.reject(new Error("Provider fixture retired")))
  return gate
}
const trackResponse = (response: Response): Response => {
  const json = response.json.bind(response)
  const clone = response.clone.bind(response)
  response.json = () => track(json())
  response.clone = () => trackResponse(clone())
  return response
}
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve))
const drain = async () => {
  do {
    await Promise.allSettled([...pendingWork])
    await checkpoint()
  } while (pendingWork.size > 0)
}
const bounded = async (task: Promise<unknown>) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Provider fixture work did not settle")), 3000)
    })])
  } finally { clearTimeout(timer) }
}
afterEach(async () => {
  const failures: unknown[] = []
  for (const retire of retirements) { try { retire() } catch (error) { failures.push(error) } }
  retirements.clear()
  for (const release of releases) { try { release() } catch (error) { failures.push(error) } }
  releases.clear()
  try { await bounded(drain()) } catch (error) { failures.push(error) }
  for (const store of stores) {
    try {
      if (!store.dispose) throw new Error("Provider store disposal is required")
      await store.dispose()
    } catch (error) { failures.push(error) }
  }
  stores.clear()
  if (unexpected.length) failures.push(new Error(`Unexpected provider HTTP: ${unexpected.join(", ")}`))
  unexpected.length = 0
  if (failures.length) throw new AggregateError(failures, "Provider fixture cleanup failed")
})

async function storeHarness(options: {
  persist?: (rows: RequestRow[]) => Promise<void>
  rows?: RequestRow[]
  connectionIds?: ReadonlyArray<string>
  http: (init: RequestInit | undefined, rows: RequestRow[], path: string) => Promise<Response>
}) {
  let ready = false
  const committed = new Map<string, string>()
  let staged: Map<string, string> | undefined
  const storage = {
    getItem: (key: string) => (staged ?? committed).get(key) ?? null,
    setItem: (key: string, value: string) => { (staged ?? committed).set(key, value) },
    removeItem: (key: string) => { (staged ?? committed).delete(key) }
  }
  const host: PersistenceBackend = {
    kind: "opfs", storage, storageEventApi: { addEventListener() {}, removeEventListener() {} },
    beginBatch: () => { if (staged) throw new Error("Overlapping provider persistence batches"); staged = new Map(committed) },
    commitBatch: () => { if (!staged) throw new Error("No provider persistence batch") },
    abortBatch: () => { staged = undefined },
    flush: async () => {
      const raw = staged?.get("smithers-mvp.app-sessions")
      if (ready && raw !== undefined && raw !== committed.get("smithers-mvp.app-sessions")) {
        const entries: unknown = JSON.parse(raw)
        const row = isRecord(entries) ? entries["s:main"] : undefined
        if (!isRecord(row)) throw new Error("Missing provider fixture session")
        await options.persist?.(SessionSchema.parse(row.data).codingProviderRequests ?? [])
      }
      if (staged) {
        committed.clear()
        for (const [key, value] of staged) committed.set(key, value)
        staged = undefined
      }
    },
    close: async () => { staged = undefined }
  }
  const store = await createAppStore(options.persist ? host : { kind: "localStorage", storage })
  stores.add(store)
  let disposed = false
  retirements.add(() => { disposed = true; ready = false })
  const account = (login: string) => track(store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login, admin: false, scopesPlain: null }).isPersisted.promise)
  await account("alice")
  if (options.rows) await store.dispatch({ type: "coding.provider.requests.changed", actor: "system", requests: options.rows }).isPersisted.promise
  const calls: RequestInit[] = []
  const enteredHttp = Promise.withResolvers<void>()
  const sent: Array<{ path: string; init?: RequestInit }> = []
  const messages: string[] = []
  const titles: string[] = []
  const work: Promise<unknown>[] = []
  const ctx: SeamContext = {
    baseUrl: "https://smithers.sh", store, isDisposed: () => disposed, nextOrdinal: store.nextOrdinal, actor: () => "user",
    dispatch: event => {
      if (event.type === "message.appended") messages.push(event.text)
      const tx = store.dispatch(event)
      track(tx.isPersisted.promise)
      return tx
    },
    http: (path, init) => {
      calls.push(init ?? {})
      sent.push({ path, init })
      const method = init?.method ?? "GET"
      return track(Promise.resolve().then(async () => {
        if ((path !== "https://smithers.sh/api/user/provider-connections" || !["GET", "POST"].includes(method)) &&
          (!(options.connectionIds ?? ["conn-1"]).some(id => path === `https://smithers.sh/api/user/provider-connections/${id}`) || method !== "DELETE")) {
          unexpected.push(`${method} ${path}`)
          throw new Error("Unexpected provider request")
        }
        enteredHttp.resolve()
        const response = await options.http(init, store.session().codingProviderRequests ?? [], path)
        return trackResponse(response)
      }))
    }
  }
  const withToast: FailureController["withToast"] = (_key, title, _done, task) => {
    titles.push(title)
    const job = track(task()); work.push(job); return job
  }
  const real = createSecretsSeam(ctx, withToast)
  const seam = { ...real, connectCodingProvider: (...args: Parameters<typeof real.connectCodingProvider>) => track(real.connectCodingProvider(...args)),
    revokeCodingProvider: (id: string) => track(real.revokeCodingProvider(id)), listCodingProviders: () => track(real.listCodingProviders()) }
  ready = true
  return { store, seam, httpEntered: enteredHttp.promise, persistedBytes: () => JSON.stringify([...committed]), anotherSeam: (actor: "user" | "smithers") => createSecretsSeam({ ...ctx, actor: () => actor }, withToast), calls, sent, titles, messages, work, rows: () => store.session().codingProviderRequests ?? [], account, dispose: () => { disposed = true } }
}


const recoveredRevocations = [
  { label: "absent connection", rows: [], outcome: true, state: "completed", deletes: 0 },
  { label: "already revoked", rows: [{ id: "conn-1", provider: "claude", state: "revoked", label: "Old" }], outcome: true, state: "completed", deletes: 0 },
  { label: "active connection", rows: [{ id: "conn-1", provider: "claude", state: "active", label: "Active" }], outcome: true, state: "completed", deletes: 1 },
  { label: "refresh failed", rows: [{ id: "conn-1", provider: "claude", state: "refresh_failed", label: "Needs attention" }], outcome: "Connection revocation needs a retry.", state: "requested", deletes: 0 }
] as const
test.each([...recoveredRevocations])("reload of $label revocation reconciles observed state before deciding whether to write", async ({ rows, outcome, state, deletes }) => {
  const h = await storeHarness({ rows: [{ id: "revoke-1", owner: "alice", action: "revoke", connectionId: "conn-1", state: "requested" }],
    http: async init => init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(rows) })
  h.seam.resumeCodingProviders()
  expect(await h.work[0]).toBe(outcome)
  expect(h.rows()).toEqual([{ id: "revoke-1", owner: "alice", action: "revoke", connectionId: "conn-1", state }])
  expect(h.sent.filter(call => call.init?.method === "DELETE")).toHaveLength(deletes)
  expect(h.sent[0]).toEqual({ path: "https://smithers.sh/api/user/provider-connections", init: undefined })
  expect(h.sent.some(call => call.init?.method === "POST")).toBe(false)
})

test.each(["connect", "revoke"])("user and Smithers seams share one held %s request through the actual store", async action => {
  const response = gate<Response>()
  const h = await storeHarness({ http: () => response.promise })
  const agent = h.anotherSeam("smithers")
  const run = (seam: ReturnType<typeof createSecretsSeam>) => action === "connect"
    ? seam.connectCodingProvider(writeOnlyGesture("secrets.connect", { value: "sk-ant-api03-two-door-fixture" }))
    : seam.revokeCodingProvider("conn-1")
  expect(await Promise.all([track(run(h.seam)), track(run(agent))])).toEqual([{ value: "Requested" }, { value: "Requested" }])
  expect(h.rows()).toHaveLength(1)
  expect(h.work).toHaveLength(1)
  expect(h.sent).toHaveLength(1)
  response.resolve(action === "connect"
    ? Response.json({ id: "conn-1", provider: "claude", state: "active", label: `web-${h.rows()[0]!.id}` }, { status: 201 })
    : new Response(null, { status: 204 }))
  expect(await h.work[0]).toBe(true)
  expect(h.rows()[0]?.state).toBe("completed")
  expect(JSON.stringify(await h.store.eventHistory())).not.toContain("sk-ant-api03-two-door-fixture")
  expect(h.persistedBytes()).not.toContain("sk-ant-api03-two-door-fixture")
})

test("independent stores owned by the same account each launch their own connection", async () => {
  const firstResponse = gate<Response>(), secondResponse = gate<Response>()
  const first = await storeHarness({ http: () => firstResponse.promise })
  const second = await storeHarness({ http: () => secondResponse.promise })
  expect(await Promise.all([first.seam.revokeCodingProvider("conn-1"), second.seam.revokeCodingProvider("conn-1")])).toEqual([{ value: "Requested" }, { value: "Requested" }])
  expect(first.sent).toHaveLength(1)
  expect(second.sent).toHaveLength(1)
  firstResponse.resolve(new Response(null, { status: 204 }))
  secondResponse.resolve(new Response(null, { status: 204 }))
  expect(await Promise.all([first.work[0], second.work[0]])).toEqual([true, true])
  expect(first.rows()[0]?.state).toBe("completed")
  expect(second.rows()[0]?.state).toBe("completed")
})

const invalidResumedRevocations = [
  { label: "missing connection id", row: { id: "revoke-missing", owner: "alice", action: "revoke", state: "requested" } },
  { label: "invalid connection id", row: { id: "revoke-invalid", owner: "alice", action: "revoke", connectionId: "bad_id", state: "requested" } }
] satisfies Array<{ label: string; row: RequestRow }>
test.each(invalidResumedRevocations)("a schema-valid resumed revocation with $label cannot issue a delete", async ({ row }) => {
  expect(SessionSchema.shape.codingProviderRequests.unwrap().safeParse([row]).success).toBe(true)
  const h = await storeHarness({ rows: [row], http: async () => Response.json([]) })
  h.seam.resumeCodingProviders()
  expect(await h.work[0]).toBe("Invalid connection.")
  expect(h.rows().some(request => request.state === "completed")).toBe(false)
  expect(h.sent).toEqual([{ path: "https://smithers.sh/api/user/provider-connections", init: undefined }])
})

const maximumConnectionId = "A0-".repeat(33) + "Z"
const publicConnectionIds = [
  { label: "one unit", id: "A", length: 1, accepted: true },
  { label: "100 units with mixed legal token characters", id: maximumConnectionId, length: 100, accepted: true },
  { label: "101 units", id: maximumConnectionId + "A", length: 101, accepted: false },
  { label: "empty", id: "", length: 0, accepted: false },
  { label: "underscore outside the token alphabet", id: "bad_id", length: 6, accepted: false }
]
test.each(publicConnectionIds)("public revocation validates $label at its local ID boundary", async ({ id, length, accepted }) => {
  expect(id.length).toBe(length)
  const h = await storeHarness({ connectionIds: [id], http: async () => new Response(null, { status: 204 }) })
  const outcome = await h.seam.revokeCodingProvider(id)
  if (accepted) {
    expect(outcome).toEqual({ value: "Requested" })
    expect(await h.work[0]).toBe(true)
    expect(h.sent).toEqual([{ path: `https://smithers.sh/api/user/provider-connections/${id}`, init: { method: "DELETE" } }])
    expect(h.rows()).toEqual([{ id: expect.any(String), owner: "alice", action: "revoke", connectionId: id, state: "completed" }])
  } else {
    expect(outcome).toBe("Invalid connection.")
    expect(h.sent).toEqual([])
    expect(h.rows()).toEqual([])
    expect(h.work).toEqual([])
  }
})

const refusedGestures = [
  { label: "signed out", signedOut: true, token: "sk-ant-api03-refused-fixture", expected: "Sign in to connect Claude." },
  { label: "invalid token", signedOut: false, token: "unsupported-refused-fixture", expected: "Enter an Anthropic API key." },
  { label: "Claude subscription token", signedOut: false, token: "sk-ant-oat01-refused-fixture", expected: "Enter an Anthropic API key." }
]
test.each(refusedGestures)("$label admission consumes and releases every one-shot field without persisting its contents", async ({ signedOut, token, expected }) => {
  const h = await storeHarness({ http: async () => { throw new Error("Refused gesture must not reach HTTP") } })
  if (signedOut) await track(h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise)
  const input: Record<string, string> = { value: token, spare: "unconsumed-write-only-fixture" }
  const gesture = writeOnlyGesture("secrets.connect", input)
  expect(input).toEqual({})
  expect(await h.seam.connectCodingProvider(gesture)).toBe(expected)
  expect(gesture.takeWriteOnly?.("value")).toBeUndefined()
  expect(gesture.takeWriteOnly?.("spare")).toBeUndefined()
  expect(h.sent).toEqual([])
  expect(h.rows()).toEqual([])
  expect(h.persistedBytes()).not.toContain(token)
  expect(h.persistedBytes()).not.toContain("unconsumed-write-only-fixture")
  expect(JSON.stringify(await h.store.eventHistory())).not.toContain(token)
  expect(JSON.stringify(await h.store.eventHistory())).not.toContain("unconsumed-write-only-fixture")
})

test("a duplicate live enrollment consumes a different offered token without sending or storing it", async () => {
  const response = gate<Response>()
  const h = await storeHarness({ http: () => response.promise })
  const firstToken = "sk-ant-api03-first-live-fixture", duplicateToken = "sk-ant-api03-duplicate-live-fixture"
  expect(await h.seam.connectCodingProvider(writeOnlyGesture("secrets.connect", { value: firstToken }))).toEqual({ value: "Requested" })
  await h.httpEntered
  const duplicate = writeOnlyGesture("secrets.connect", { value: duplicateToken, spare: "duplicate-spare-fixture" })
  expect(await h.seam.connectCodingProvider(duplicate)).toEqual({ value: "Requested" })
  expect(duplicate.takeWriteOnly?.("value")).toBeUndefined()
  expect(duplicate.takeWriteOnly?.("spare")).toBeUndefined()
  expect(h.sent).toHaveLength(1)
  expect(h.sent[0]?.init?.body).toBe(JSON.stringify({ provider: "claude", label: `web-${h.rows()[0]!.id}`, access_token: firstToken }))
  expect(h.sent[0]?.init?.body).not.toContain(duplicateToken)
  response.resolve(Response.json({ id: "conn-1", provider: "claude", state: "active", label: `web-${h.rows()[0]!.id}` }, { status: 201 }))
  expect(await h.work[0]).toBe(true)
  expect(h.work).toHaveLength(1)
  expect(h.persistedBytes()).not.toContain(firstToken)
  expect(h.persistedBytes()).not.toContain(duplicateToken)
  expect(h.persistedBytes()).not.toContain("duplicate-spare-fixture")
  expect(JSON.stringify(await h.store.eventHistory())).not.toContain(firstToken)
  expect(JSON.stringify(await h.store.eventHistory())).not.toContain(duplicateToken)
  expect(JSON.stringify(await h.store.eventHistory())).not.toContain("duplicate-spare-fixture")
})

test("an offered token is released while an interrupted enrollment reconciles from metadata without replaying it", async () => {
  const reply = gate<Response>()
  const h = await storeHarness({ rows: [{ id: "existing-request", owner: "alice", action: "connect", state: "requested" }], http: () => reply.promise })
  const token = "sk-ant-api03-reconciliation-fixture"
  const gesture = writeOnlyGesture("secrets.connect", { value: token, spare: "reconciliation-spare-fixture" })
  expect(await h.seam.connectCodingProvider(gesture)).toEqual({ value: "Requested" })
  await h.httpEntered
  expect(h.sent).toEqual([{ path: "https://smithers.sh/api/user/provider-connections", init: undefined }])
  expect(gesture.takeWriteOnly?.("value")).toBeUndefined()
  expect(gesture.takeWriteOnly?.("spare")).toBeUndefined()
  reply.resolve(Response.json([{ id: "conn-1", provider: "claude", state: "active", label: "web-existing-request" }]))
  expect(await h.work[0]).toBe(true)
  expect(h.rows()).toEqual([{ id: "existing-request", owner: "alice", action: "connect", state: "completed" }])
  expect(h.sent).toHaveLength(1)
  expect(h.persistedBytes()).not.toContain(token)
  expect(h.persistedBytes()).not.toContain("reconciliation-spare-fixture")
  expect(JSON.stringify(await h.store.eventHistory())).not.toContain(token)
  expect(JSON.stringify(await h.store.eventHistory())).not.toContain("reconciliation-spare-fixture")
})
