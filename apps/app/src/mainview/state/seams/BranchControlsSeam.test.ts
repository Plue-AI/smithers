import { expect, test } from "bun:test"
import { createBranchControlsSeam } from "./BranchControlsSeam"
import { createAppStore } from "../AppStore"
import { memoryStorage } from "../TestFixtures"
import type { SeamFetch } from "./SeamContext"

const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 250 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}
const boot = async (http: SeamFetch, storage = memoryStorage(), origin = "http://mini.lan:4000") => {
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "ben/demo", org: "ben", ownerKind: "user", name: "demo", head: { bookmark: "main", changeId: "main", commitId: "main" } }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: "ben/demo" }).isPersisted.promise
  const done: string[] = [], errors: string[] = []
  const seam = createBranchControlsSeam({ store, dispatch: store.dispatch, http, baseUrl: origin, actor: () => "user", nextOrdinal: () => store.nextOrdinal(),
    withToast: async (key, _title, _done, work, _quiet, current) => {
      const result = await work()
      if (current?.() !== false) { done.push(key); if (typeof result === "string") errors.push(result) }
      return result
    } }, { ready: () => true })
  return { store, seam, done, errors, storage, row: () => store.session().branchControlRequests?.[0] }
}
const admission = (key: string) => Response.json({ state: "accepted", operationId: "operation-1", requestId: `b-1:${key}` }, { status: 202 })

test("persist before unresolved launch; duplicate sleep joins; settlement waits for execution", async () => {
  let release!: (response: Response) => void, state = "running"
  const keys: string[] = [], reads: string[] = []
  const h = await boot(async (url, init) => {
    if (init?.method === "POST") { keys.push(new Headers(init.headers).get("Idempotency-Key")!); return new Promise(resolve => { release = resolve }) }
    reads.push(url); return Response.json({ operationId: "operation-1", state })
  })
  try {
    expect(await Promise.all([h.seam.request("sleep", "my branch"), h.seam.request("sleep", "my branch")])).toEqual([{ value: "Requested" }, { value: "Requested" }])
    expect(h.row()?.state).toBe("requested"); expect(keys).toHaveLength(1); expect(h.done).toEqual([])
    release(admission(keys[0]!))
    await until(() => h.row()?.state === "accepted" && reads.length === 1)
    expect(reads).toEqual(["http://mini.lan:4000/api/repos/ben/demo/workspaces/b-1/command-runs/operation-1"])
    expect(h.done).toEqual([])
    state = "completed"
    await until(() => h.row()?.state === "completed" && h.done.length === 1)
    expect(h.errors).toEqual([])
  } finally { h.seam.dispose() }
})

test("reload replays unacknowledged key; accepted reload observes only", async () => {
  const first = await boot(async () => new Promise<Response>(() => {}))
  await first.seam.request("wake", "smithers/retry")
  const key = first.row()!.key
  first.seam.dispose()
  const keys: string[] = []
  const second = await boot(async (_url, init) => {
    if (init?.method === "POST") { keys.push(new Headers(init.headers).get("Idempotency-Key")!); return admission(keys[0]!) }
    return new Promise<Response>(() => {})
  }, first.storage)
  await until(() => second.row()?.state === "accepted")
  second.seam.dispose()
  let writes = 0
  const third = await boot(async (_url, init) => { if (init?.method === "POST") writes++; return Response.json({ operationId: "operation-1", state: "completed" }) }, first.storage)
  try {
    await until(() => third.row()?.state === "completed")
    expect(keys).toEqual([key]); expect(writes).toBe(0)
  } finally { third.seam.dispose() }
})

for (const state of ["failed", "uncertain", "cancelled"]) test(`execution ${state} persists a visible failure and permits retry`, async () => {
  let posts = 0
  const h = await boot(async (_url, init) => {
    if (init?.method === "POST") { posts++; return admission(new Headers(init.headers).get("Idempotency-Key")!) }
    return Response.json({ operationId: "operation-1", state, error: "Branch request failed" })
  })
  try {
    await h.seam.request("wake", "smithers/retry")
    await until(() => h.row()?.state === "failed" && h.done.length === 1)
    expect(h.errors).toEqual(["Branch request failed"])
    await h.seam.request("wake", "smithers/retry")
    await until(() => posts === (state === "uncertain" ? 1 : 2) && h.done.length === 2)
  } finally { h.seam.dispose() }
})

test("account change discards an earlier launch; a different origin never replays it", async () => {
  let release!: (response: Response) => void
  const h = await boot(async () => new Promise(resolve => { release = resolve }))
  await h.seam.request("sleep", "smithers/retry")
  await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
  release(admission("old-account-key")); await new Promise(resolve => setTimeout(resolve, 20))
  expect(h.row()?.state).not.toBe("accepted"); expect(h.done).toEqual([])
  h.seam.dispose()
  let writes = 0
  const other = await boot(async () => { writes++; return new Response("{}") }, h.storage, "http://other.test")
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(writes).toBe(0); other.seam.dispose()
})

test("branch controls retain an idempotency key without secure-context UUID support", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID")
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined })
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const h = await boot(async (url, init) => { requests.push({ url, init }); return new Promise<Response>(() => {}) })
  try {
    expect(await h.seam.request("sleep", "my branch")).toEqual({ value: "Requested" })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe("http://mini.lan:4000/api/branches/my%20branch")
    expect(JSON.parse(String(requests[0]!.init!.body))).toEqual({ op: "sleep" })
    expect(new Headers(requests[0]!.init!.headers).get("Idempotency-Key")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  } finally {
    h.seam.dispose()
    if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor)
    else delete (crypto as { randomUUID?: unknown }).randomUUID
  }
})

test("a lost receipt read retries observation without repeating the admitted action", async () => {
  let writes = 0, reads = 0
  const h = await boot(async (_url, init) => {
    if (init?.method === "POST") { writes++; return admission(new Headers(init.headers).get("Idempotency-Key")!) }
    reads++
    return reads === 1 ? new Response("offline", { status: 503 }) : Response.json({ operationId: "operation-1", state: "completed" })
  })
  try {
    await h.seam.request("sleep", "smithers/retry")
    await until(() => h.row()?.state === "failed")
    const key = h.row()!.key
    await h.seam.request("sleep", "smithers/retry")
    await until(() => h.row()?.state === "completed")
    expect(writes).toBe(1); expect(reads).toBe(2); expect(h.row()?.key).toBe(key)
  } finally { h.seam.dispose() }
})

test("an unresolved rebase never serializes an unrelated machine control behind its network", async () => {
  const operations: unknown[] = []
  const h = await boot(async (_url, init) => { operations.push(JSON.parse(String(init?.body))); return new Promise<Response>(() => {}) })
  try {
    void h.seam.request("rebase", "smithers/retry")
    expect(await h.seam.request("sleep", "smithers/retry")).toEqual({ value: "Requested" })
    expect(operations).toEqual([{ rebase: true }, { op: "sleep" }])
  } finally { h.seam.dispose() }
})

const rebaseAdmission = () => Response.json({ state: "accepted", n: 2, onto: "new-main" }, { status: 202 })
const rebaseReceipt = (state: string) => Response.json({ n: 2, rebase_execution: { state, onto: "new-main" } })

const scratchId = "11111111-1111-4111-8111-111111111111"
const scratchAdmission = () => Response.json({ state: "accepted", branch: scratchId, onto: "new-source" }, { status: 202 })
const scratchReceipt = (state: string, id = scratchId) => Response.json({ kind: "scratch", machine: { id }, rebase_execution: { state, onto: "new-source" } })

test("Scratch Rebase persists before launch and settles only from its bound branch receipt", async () => {
  let release!: (response: Response) => void, state = "running"
  const writes: string[] = [], reads: string[] = []
  const h = await boot(async (url, init) => {
    if (init?.method === "POST") { writes.push(new Headers(init.headers).get("Idempotency-Key")!); return new Promise(resolve => { release = resolve }) }
    reads.push(url); return scratchReceipt(state)
  })
  try {
    expect(await Promise.all([h.seam.request("rebase", "scratch/ben/experiment"), h.seam.request("rebase", "scratch/ben/experiment")])).toEqual([{ value: "Requested" }, { value: "Requested" }])
    expect(h.row()?.state).toBe("requested"); expect(writes).toHaveLength(1); expect(h.done).toEqual([])
    release(scratchAdmission())
    await until(() => reads.length === 1)
    expect(reads[0]).toBe(`http://mini.lan:4000/api/branches/${scratchId}?rebase_request=${writes[0]}`)
    expect(h.row()?.number).toBeUndefined(); expect(h.row()?.workspace).toBe(scratchId); expect(h.done).toEqual([])
    state = "completed"
    await until(() => h.row()?.state === "completed" && h.done.length === 1)
    expect(h.errors).toEqual([])
  } finally { h.seam.dispose() }
})

test("Scratch receipt recovery observes without repeating Rebase or inventing a TODO", async () => {
  let writes = 0, reads = 0
  const h = await boot(async (_url, init) => {
    if (init?.method === "POST") { writes++; return scratchAdmission() }
    reads++
    return reads === 1 ? new Response("offline", { status: 503 }) : scratchReceipt("completed")
  })
  try {
    await h.seam.request("rebase", "scratch/ben/experiment")
    await until(() => h.row()?.state === "failed")
    const key = h.row()!.key
    await h.seam.request("rebase", "scratch/ben/experiment")
    await until(() => h.row()?.state === "completed")
    expect(writes).toBe(1); expect(reads).toBe(2); expect(h.row()?.key).toBe(key); expect(h.row()?.number).toBeUndefined()
  } finally { h.seam.dispose() }
})

test("Scratch conflict remains visible and a receipt for another branch refuses completion", async () => {
  for (const [state, id, expected] of [["conflict", scratchId, "Resolve the conflict"], ["completed", "22222222-2222-4222-8222-222222222222", "Rebase receipt unavailable"]] as const) {
    const h = await boot(async (_url, init) => init?.method === "POST" ? scratchAdmission() : scratchReceipt(state, id))
    try {
      await h.seam.request("rebase", "scratch/ben/experiment")
      await until(() => h.row()?.state === "failed")
      expect(h.errors).toEqual([expected]); expect(h.row()?.state).not.toBe("completed")
      expect(Boolean(h.row()?.settled)).toBe(state === "conflict")
    } finally { h.seam.dispose() }
  }
})

test("Rebase acknowledges unresolved launch, deduplicates, and waits for its execution receipt", async () => {
  let release!: (response: Response) => void, state = "running"
  const writes: Array<{ key: string; body: unknown }> = [], reads: string[] = []
  const h = await boot(async (url, init) => {
    if (init?.method === "POST") {
      writes.push({ key: new Headers(init.headers).get("Idempotency-Key")!, body: JSON.parse(String(init.body)) })
      return new Promise(resolve => { release = resolve })
    }
    reads.push(url); return rebaseReceipt(state)
  })
  try {
    expect(await Promise.all([h.seam.request("rebase", "smithers/retry"), h.seam.request("rebase", "smithers/retry")])).toEqual([{ value: "Requested" }, { value: "Requested" }])
    expect(writes).toHaveLength(1); expect(writes[0]!.body).toEqual({ rebase: true })
    expect(h.row()?.state).toBe("requested"); expect(h.done).toEqual([])
    release(rebaseAdmission())
    await until(() => reads.length === 1)
    expect(reads[0]).toBe(`http://mini.lan:4000/api/todos/2?rebase_request=${writes[0]!.key}`)
    expect(h.row()?.state).toBe("accepted"); expect(h.done).toEqual([])
    state = "completed"
    await until(() => h.row()?.state === "completed" && h.done.length === 1)
    expect(h.errors).toEqual([])
  } finally { h.seam.dispose() }
})

for (const accepted of [false, true]) test(`Rebase reload ${accepted ? "observes an admitted request" : "replays the persisted launch key"}`, async () => {
  const first = await boot(async (_url, init) => init?.method === "POST" && accepted ? rebaseAdmission() : new Promise<Response>(() => {}))
  await first.seam.request("rebase", "smithers/retry")
  if (accepted) await until(() => first.row()?.state === "accepted")
  const key = first.row()!.key
  first.seam.dispose()
  const writes: string[] = []
  const second = await boot(async (_url, init) => {
    if (init?.method === "POST") { writes.push(new Headers(init.headers).get("Idempotency-Key")!); return rebaseAdmission() }
    return rebaseReceipt("completed")
  }, first.storage)
  try {
    await until(() => second.row()?.state === "completed" && second.done.length === 1)
    expect(writes).toEqual(accepted ? [] : [key])
  } finally { second.seam.dispose() }
})

for (const launchFailure of [false, true]) test(`Rebase ${launchFailure ? "launch" : "execution"} failure remains visible and retryable`, async () => {
  let writes = 0
  const h = await boot(async (_url, init) => {
    if (init?.method === "POST") { writes++; return launchFailure ? Response.json({ code: "rebase_unavailable", class: "infra", message: "Rebase unavailable" }, { status: 503 }) : rebaseAdmission() }
    return rebaseReceipt("failed")
  })
  try {
    await h.seam.request("rebase", "smithers/retry")
    await until(() => h.row()?.state === "failed" && h.done.length === 1)
    expect(h.errors).toHaveLength(1)
    await h.seam.request("rebase", "smithers/retry")
    await until(() => writes === 2 && h.done.length === 2)
  } finally { h.seam.dispose() }
})

test("scratch Done retains both conflict bindings in its persisted background request", async () => {
  let body: unknown
  const h = await boot(async (_url, init) => { body = JSON.parse(String(init?.body)); return new Promise<Response>(() => {}) })
  try {
    expect(await h.seam.request("rebase", "scratch/ben/retry", { conflict_change: "conflict-1", onto_revision: "target-1" })).toEqual({ value: "Requested" })
    expect(body).toEqual({ conflict_change: "conflict-1", onto_revision: "target-1" })
    expect(h.row()?.input).toEqual({ conflict_change: "conflict-1", onto_revision: "target-1" })
  } finally { h.seam.dispose() }
})


test("Rebase addressed to a TODO acknowledges before the branch lookup resolves", async () => {
  const reads: string[] = []
  const h = await boot(async url => { reads.push(url); return new Promise<Response>(() => {}) })
  try {
    expect(await h.seam.request("rebase", "T2")).toEqual({ value: "Requested" })
    expect(h.row()?.state).toBe("requested")
    expect(reads).toEqual(["http://mini.lan:4000/api/todos/2"])
    expect(h.done).toEqual([])
  } finally { h.seam.dispose() }
})

test("Rebase retries a lost receipt read without launching another rewrite", async () => {
  let writes = 0, reads = 0
  const h = await boot(async (_url, init) => {
    if (init?.method === "POST") { writes++; return rebaseAdmission() }
    return ++reads === 1 ? Response.json({ message: "offline" }, { status: 503 }) : rebaseReceipt("completed")
  })
  try {
    await h.seam.request("rebase", "smithers/retry")
    await until(() => h.row()?.state === "failed" && h.done.length === 1)
    const key = h.row()!.key
    await h.seam.request("rebase", "smithers/retry")
    await until(() => h.row()?.state === "completed" && h.done.length === 2)
    expect(writes).toBe(1); expect(reads).toBe(2); expect(h.row()?.key).toBe(key)
  } finally { h.seam.dispose() }
})

test("reload restores a failed Rebase notice without repeating admission or receipt reads", async () => {
  const first = await boot(async (_url, init) => init?.method === "POST" ? rebaseAdmission() : rebaseReceipt("failed"))
  await first.seam.request("rebase", "smithers/retry")
  await until(() => first.row()?.state === "failed" && first.errors.length === 1)
  const key = first.row()!.key
  first.seam.dispose()
  let calls = 0
  const foreign = await boot(async () => { calls++; throw new Error("Foreign recovery must not request execution") }, first.storage, "http://other.lan:4000")
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(foreign.errors).toEqual([])
  foreign.seam.dispose()
  const second = await boot(async () => { calls++; throw new Error("Recovery must not request execution") }, first.storage)
  try {
    await until(() => second.errors.length === 1)
    expect(second.errors).toEqual(["Rebase failed"])
    expect(second.done).toEqual([`branch.request.${key}`])
    expect(second.row()?.state).toBe("failed")
    expect(calls).toBe(0)
  } finally { second.seam.dispose() }
})

for (const login of ["maya", "ben"]) test(`queued Rebase never transfers to a replacement ${login} session`, async () => {
  let release!: () => void, held = false
  const writes: string[] = []
  const h = await boot(async () => new Promise<Response>(() => {}))
  h.seam.dispose()
  const seam = createBranchControlsSeam({ store: h.store, http: async (_url, init) => {
    writes.push(JSON.parse(String(init?.body)).op ?? "rebase")
    return new Promise<Response>(() => {})
  }, baseUrl: "http://mini.lan:4000", actor: () => "user", nextOrdinal: () => h.store.nextOrdinal(),
  dispatch: event => {
    const result = h.store.dispatch(event)
    if (event.type !== "branch.control.requests.changed" || event.actor !== "user" || held) return result
    held = true
    result.isPersisted.promise = result.isPersisted.promise.then(async transaction => {
      await new Promise<void>(resolve => { release = resolve })
      return transaction
    })
    return result
  } }, { ready: () => true })
  try {
    const first = seam.request("sleep", "smithers/retry")
    const queued = seam.request("rebase", "smithers/retry")
    await until(() => typeof release === "function")
    await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
    await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login, admin: false, scopesPlain: null }).isPersisted.promise
    release()
    expect(await first).toEqual({ value: "Requested" })
    expect(await queued).toBe("Sign in")
    expect((h.store.session().branchControlRequests ?? []).filter(row => row.operation === "rebase")).toEqual([])
    expect(writes).not.toContain("rebase")
  } finally { seam.dispose() }
})
