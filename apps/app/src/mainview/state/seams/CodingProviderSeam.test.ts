import { expect, test } from "bun:test"
import { writeOnlyGesture } from "../../flows/CommandGesture"
import { createSecretsSeam } from "./SecretsSeam"
import type { SeamContext } from "./SeamContext"
import type { FailureController } from "../controller/failures"

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
