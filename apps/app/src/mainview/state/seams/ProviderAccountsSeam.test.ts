import { expect, test } from "bun:test"
import { writeOnlyGesture } from "../../flows/CommandGesture"
import { SessionSchema, type Card } from "../AppState"
import type { FailureController } from "../controller/failures"
import { createSecretsSeam } from "./SecretsSeam"
import type { SeamContext } from "./SeamContext"

/*
 * The account pool through the secrets seam: the Accounts card, Codex device
 * sign-in, pool order and the Claude token door. Every act answers once its
 * intent is durable, before the network; its toast settles only with the work.
 */

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

type RequestRow = NonNullable<ReturnType<SeamContext["store"]["session"]>["codingProviderRequests"]>[number]
type Call = { readonly method: string; readonly path: string; readonly body?: string }
const DEVICE_ID = "6f1b9c2e-6a4a-4c0e-9f52-2c1a7f0b39d1"
const device = (state: string, extra: Record<string, unknown> = {}) => ({
  id: DEVICE_ID, provider: "codex", state, user_code: "ABCD-EFGH", verification_uri: "https://auth.openai.com/codex/device",
  interval_seconds: 5, expires_at: "2999-01-01T00:00:00Z", ...extra
})
const POOL = [
  { id: "a", provider: "claude", kind: "api_key", label: "web-1", account_email: "a@example.com", state: "active", sort_order: 0 },
  { id: "old", provider: "claude", kind: "api_key", label: "web-0", state: "revoked", sort_order: 1 },
  { id: "b", provider: "claude", kind: "api_key", label: "b", state: "active", sort_order: 2, limited_until: "2026-09-25T10:15:00Z" },
  { id: "c", provider: "claude", kind: "api_key", label: "c", state: "refresh_failed", sort_order: 3 },
  { id: "x", provider: "codex", kind: "oauth", label: "x", state: "active", sort_order: 0 }
]

function harness(options: {
  http: (call: Call) => Promise<Response>
  persist?: () => Promise<void>
  rows?: RequestRow[]
  sleep?: (ms: number) => Promise<void>
  card?: boolean
}) {
  let rows: RequestRow[] = options.rows ?? []
  let ordinal = 0
  let login: string | null = "alice"
  let revision = 1
  let disposed = false
  const sleeping = deferred<void>()
  const cards = new Map<string, Card>()
  const calls: Call[] = []
  const toasts: string[] = []
  const messages: string[] = []
  const work: Promise<unknown>[] = []
  const sleeps: number[] = []
  const watchers: Array<(payload: Extract<Card, { kind: "provider-accounts" }>["payload"]) => void> = []
  const ctx = {
    baseUrl: "https://smithers.sh", isDisposed: () => disposed, nextOrdinal: () => ++ordinal, actor: () => "user",
    store: { session: () => ({ codingProviderRequests: rows }), collections: {
      identitySessions: { get: () => ({ login, ownerRevision: revision }) },
      cloudSessions: { get: () => ({ state: "signed-in", ownerRevision: 1 }) },
      cards: { get: (id: string) => cards.get(id) }
    } },
    dispatch: (event: { type: string; requests?: RequestRow[]; text?: string; card?: Card }) => {
      if (event.type === "message.appended") messages.push(event.text ?? "")
      if (event.type === "card.upsert" && event.card) {
        cards.set(event.card.id, event.card)
        if (event.card.kind === "provider-accounts") for (const watch of watchers) watch(event.card.payload)
      }
      if (event.requests) rows = event.requests
      return { isPersisted: { promise: event.requests ? options.persist?.() ?? Promise.resolve() : Promise.resolve() } }
    },
    http: (url: string, init?: RequestInit) => {
      const call = { method: init?.method ?? "GET", path: new URL(url).pathname, ...(typeof init?.body === "string" ? { body: init.body } : {}) }
      calls.push(call)
      return options.http(call)
    }
  } as unknown as SeamContext
  const withToast = ((_key: string, title: string, _done: string, task: () => Promise<unknown>) => {
    toasts.push(title)
    const pending = task()
    work.push(pending)
    return pending
  }) as FailureController["withToast"]
  const seam = createSecretsSeam(ctx, withToast, { sleep: async ms => { sleeps.push(ms); sleeping.resolve(); await options.sleep?.(ms) } })
  const anotherSeam = (actor: "user" | "smithers") => createSecretsSeam({ ...ctx, actor: () => actor } as SeamContext, withToast, { sleep: async ms => { await options.sleep?.(ms) } })
  if (options.card) {
    cards.set("provider-accounts", { id: "provider-accounts", kind: "provider-accounts", title: "Accounts", status: "active", createdAt: 0, ordinal: 0, payload: { accounts: [] } })
  }
  const accounts = () => {
    const card = cards.get("provider-accounts")
    return card?.kind === "provider-accounts" ? card.payload : undefined
  }
  const setAccounts = (list: Extract<Card, { kind: "provider-accounts" }>["payload"]["accounts"]) => {
    const card = cards.get("provider-accounts")
    if (card?.kind === "provider-accounts") cards.set(card.id, { ...card, payload: { ...card.payload, accounts: list } })
  }
  const onCard = (watch: (typeof watchers)[number]) => { watchers.push(watch) }
  return { seam, anotherSeam, login: (name: string | null) => { login = name; revision += 1 }, retire: () => { disposed = true }, sleepEntered: sleeping.promise, calls, toasts, messages, work, sleeps, rows: () => rows, accounts, setAccounts, onCard }
}

test("the connections list renders the Accounts card in pool order without revoked rows, and keeps a text result", async () => {
  const h = harness({ http: async () => Response.json(POOL) })
  const result = await h.seam.listCodingProviders()
  expect(h.accounts()?.accounts.map(row => [row.id, row.state, row.limitedUntil])).toEqual([
    ["a", "active", null], ["b", "active", "2026-09-25T10:15:00Z"], ["c", "refresh_failed", null], ["x", "active", null]
  ])
  expect(h.accounts()?.accounts[0]?.email).toBe("a@example.com")
  expect(h.accounts()?.pending).toBeUndefined()
  expect(result).toEqual({ value: [
    "a · claude · a@example.com · active",
    "b · claude · b · active · limited until 2026-09-25T10:15:00Z",
    "c · claude · c · refresh_failed",
    "x · codex · x · active"
  ].join("\n") })
})

test("Codex sign-in answers before the held start request and settles only when the sign-in connects", async () => {
  const start = deferred<Response>()
  const polls = [device("pending"), device("connected", { connection: POOL[4] })]
  const h = harness({ http: async call => {
    if (call.path.endsWith("/codex/device")) return start.promise
    if (call.path.endsWith(`/codex/device/${DEVICE_ID}`)) return Response.json(polls.shift())
    return Response.json(POOL)
  } })
  expect(await h.seam.connectCodex()).toEqual({ value: "Requested" })
  expect(h.toasts).toEqual(["Connecting Codex…"])
  let settled = false
  void h.work[0]!.then(() => { settled = true })
  await tick()
  expect(settled).toBe(false)
  expect(h.rows()[0]).toMatchObject({ owner: "alice", action: "codex", state: "requested" })
  start.resolve(Response.json(device("pending")))
  expect(await h.work[0]).toBe(true)
  expect(h.calls.filter(call => call.method === "POST").map(call => call.path)).toEqual([
    "/api/user/provider-connections/codex/device",
    `/api/user/provider-connections/codex/device/${DEVICE_ID}`,
    `/api/user/provider-connections/codex/device/${DEVICE_ID}`
  ])
  expect(h.sleeps).toEqual([5000, 5000])
  expect(h.rows()[0]).toMatchObject({ state: "completed", device: { id: DEVICE_ID, userCode: "ABCD-EFGH" } })
  expect(h.accounts()?.pending).toBeUndefined()
  expect(h.accounts()?.accounts).toHaveLength(4)
})

test("a pending Codex sign-in shows its code on the card until the poll settles", async () => {
  const wait = deferred<void>()
  const h = harness({ sleep: () => wait.promise, http: async call => {
    if (call.path.endsWith("/codex/device")) return Response.json(device("pending"))
    if (call.path.includes("/codex/device/")) return Response.json(device("connected"))
    return Response.json(POOL)
  } })
  await h.seam.connectCodex()
  for (let index = 0; index < 5; index += 1) await tick()
  expect(h.accounts()?.pending).toEqual({ userCode: "ABCD-EFGH", verificationUri: "https://auth.openai.com/codex/device" })
  wait.resolve()
  expect(await h.work[0]).toBe(true)
  expect(h.accounts()?.pending).toBeUndefined()
})

test("an expired or failed Codex sign-in fails its toast and clears the code", async () => {
  for (const [answer, message] of [["expired", "Codex sign-in expired. Retry."], ["failed", "Codex sign-in failed."]] as const) {
    const h = harness({ http: async call => {
      if (call.path.endsWith("/codex/device")) return Response.json(device("pending"))
      if (call.path.includes("/codex/device/")) return Response.json(device(answer))
      return Response.json(POOL)
    } })
    expect(await h.seam.connectCodex()).toEqual({ value: "Requested" })
    expect(await h.work[0]).toBe(message)
    expect(h.rows()[0]?.state).toBe("failed")
    expect(h.accounts()?.pending).toBeUndefined()
    await tick()
    expect(h.messages).toEqual([message])
  }
})

test("settling Codex clears its code without reopening an unavailable pool after a failed refresh", async () => {
  const wait = deferred<void>()
  let gated = false
  const h = harness({ sleep: () => wait.promise, http: async call => {
    if (call.path.endsWith("/codex/device")) return Response.json(device("pending"))
    if (call.path.includes("/codex/device/")) return Response.json(device("connected"))
    return gated ? Response.json({ message: "feature not available" }, { status: 403 }) : Response.json(POOL)
  } })
  await h.seam.connectCodex()
  for (let index = 0; index < 5; index += 1) await tick()
  expect(h.accounts()?.pending).toBeDefined()
  gated = true
  await h.seam.listCodingProviders()
  expect(h.accounts()).toEqual({ accounts: [], unavailable: true })
  const updates: unknown[] = []
  h.onCard(payload => updates.push(payload))
  wait.resolve()
  expect(await h.work[0]).toBe(true)
  for (let index = 0; index < 5; index += 1) await tick()
  expect(updates.length).toBeGreaterThan(0)
  for (const payload of updates) expect(payload).toEqual({ accounts: [], unavailable: true })
})

test("a refused start fails without polling, and a transient poll refusal waits for the next interval", async () => {
  const refused = harness({ http: async () => new Response(null, { status: 403 }) })
  await refused.seam.connectCodex()
  expect(await refused.work[0]).toBe("Codex sign-in failed (HTTP 403).")
  expect(refused.calls).toHaveLength(1)
  expect(refused.rows()[0]?.state).toBe("failed")

  const answers = [new Response(null, { status: 503 }), Response.json(device("connected"))]
  const flaky = harness({ http: async call => {
    if (call.path.endsWith("/codex/device")) return Response.json(device("pending"))
    if (call.path.includes("/codex/device/")) return answers.shift()!
    return Response.json(POOL)
  } })
  await flaky.seam.connectCodex()
  expect(await flaky.work[0]).toBe(true)
})

test("duplicate Codex starts reuse the in-flight sign-in", async () => {
  const start = deferred<Response>()
  const h = harness({ http: async call => {
    if (call.path.endsWith("/codex/device")) return start.promise
    if (call.path.includes("/codex/device/")) return Response.json(device("connected"))
    return Response.json(POOL)
  } })
  const [first, second] = await Promise.all([h.seam.connectCodex(), h.seam.connectCodex()])
  expect(first).toEqual({ value: "Requested" })
  expect(second).toEqual({ value: "Requested" })
  expect(await h.seam.connectCodex()).toEqual({ value: "Requested" })
  start.resolve(Response.json(device("pending")))
  expect(await h.work[0]).toBe(true)
  expect(h.work).toHaveLength(1)
  expect(h.calls.filter(call => call.path.endsWith("/codex/device"))).toHaveLength(1)
})

test("reload resumes polling a persisted Codex sign-in without starting another", async () => {
  const h = harness({
    rows: [{ id: "request-1", owner: "alice", action: "codex", state: "requested", device: { id: DEVICE_ID, userCode: "ABCD-EFGH", verificationUri: "https://auth.openai.com/codex/device", interval: 2, expiresAt: "2999-01-01T00:00:00Z" } }],
    http: async call => call.path.includes("/codex/device/") ? Response.json(device("connected")) : Response.json(POOL)
  })
  h.seam.resumeCodingProviders()
  expect(h.toasts).toEqual(["Connecting Codex…"])
  expect(await h.work[0]).toBe(true)
  expect(h.sleeps).toEqual([2000])
  expect(h.calls.some(call => call.path.endsWith("/codex/device"))).toBe(false)
  expect(h.rows()[0]?.state).toBe("completed")
  expect(await h.seam.connectCodex()).toEqual({ value: "Requested" })
})

test("a reload that lost the start request fails honestly rather than polling nothing", async () => {
  const h = harness({ rows: [{ id: "request-1", owner: "alice", action: "codex", state: "requested" }], http: async () => Response.json(POOL) })
  h.seam.resumeCodingProviders()
  expect(await h.work[0]).toBe("Codex sign-in interrupted. Retry.")
  expect(h.calls).toHaveLength(0)
  expect(h.rows()[0]?.state).toBe("failed")
})

const cardOf = (ids: ReadonlyArray<string>) => ids.map(id => {
  const row = POOL.find(item => item.id === id)!
  return { id, provider: row.provider as "claude" | "codex", label: row.label, email: row.account_email ?? null, state: row.state, limitedUntil: row.limited_until ?? null }
})

test("move persists the provider's whole order before answering, then writes it in the background", async () => {
  const persisted = deferred<void>()
  const put = deferred<Response>()
  const h = harness({ card: true, persist: () => persisted.promise, http: async call => call.method === "PUT" ? put.promise : Response.json(POOL) })
  h.setAccounts(cardOf(["a", "b", "c", "x"]))
  let acknowledged = false
  const answer = h.seam.moveCodingProvider("c", "up").then(value => { acknowledged = true; return value })
  await tick()
  expect(acknowledged).toBe(false)
  expect(h.calls).toHaveLength(0)
  expect(h.rows()[0]).toMatchObject({ owner: "alice", action: "order", provider: "claude", ids: ["a", "c", "b"], state: "requested" })
  persisted.resolve()
  expect(await answer).toEqual({ value: "Requested" })
  expect(h.accounts()?.accounts.map(row => row.id)).toEqual(["a", "c", "b", "x"])
  expect(h.toasts).toEqual(["Moving connection…"])
  let settled = false
  void h.work[0]!.then(() => { settled = true })
  await tick()
  expect(settled).toBe(false)
  expect(h.calls[0]).toEqual({ method: "PUT", path: "/api/user/provider-connections/order", body: JSON.stringify({ provider: "claude", ids: ["a", "c", "b"] }) })
  put.resolve(new Response(null, { status: 204 }))
  expect(await h.work[0]).toBe(true)
  expect(h.rows()[0]?.state).toBe("completed")
  expect(h.calls.at(-1)).toEqual({ method: "GET", path: "/api/user/provider-connections" })
})

test("a second press moves from the first, supersedes its pending order, and an edge move writes nothing", async () => {
  const bodies: string[] = []
  const h = harness({ card: true, http: async call => {
    if (call.method === "PUT") { bodies.push(call.body!); return new Response(null, { status: 204 }) }
    return new Promise<Response>(() => {})
  } })
  h.setAccounts(cardOf(["a", "b", "c"]))
  await h.seam.moveCodingProvider("c", "up")
  await h.seam.moveCodingProvider("c", "up")
  expect(h.rows().filter(row => row.action === "order" && row.state === "requested").map(row => row.ids)).toEqual([["c", "a", "b"]])
  await h.work[0]; await h.work[1]
  expect(bodies.map(body => JSON.parse(body).ids)).toEqual([["a", "c", "b"], ["c", "a", "b"]])
  expect(await h.seam.moveCodingProvider("c", "up")).toEqual({ value: "Already in place." })
  expect(bodies).toHaveLength(2)
  expect(await h.seam.moveCodingProvider("../x", "up")).toBe("Invalid connection.")
  expect(await h.seam.moveCodingProvider("zz", "up")).toBe("Connection not found.")
})

test("move without an Accounts card refuses instead of acknowledging unpersisted work", async () => {
  const h = harness({ http: async () => Response.json(POOL) })
  expect(await h.seam.moveCodingProvider("a", "down")).toBe("Show coding accounts first.")
  expect(h.rows()).toEqual([])
  expect(h.calls).toHaveLength(0)
})

test("a refused order write fails the toast and restores the card from the server", async () => {
  const h = harness({ card: true, http: async call => call.method === "PUT" ? new Response(null, { status: 400 }) : Response.json(POOL) })
  h.setAccounts(cardOf(["a", "b", "c"]))
  await h.seam.moveCodingProvider("a", "down")
  expect(await h.work[0]).toBe("Connection move failed (HTTP 400).")
  expect(h.rows()[0]?.state).toBe("failed")
  await tick()
  expect(h.accounts()?.accounts.map(row => row.id)).toEqual(["a", "b", "c", "x"])
})

test("reload replays a persisted order request", async () => {
  const h = harness({
    rows: [{ id: "order-1", owner: "alice", action: "order", provider: "claude", ids: ["b", "a"], state: "requested" }],
    http: async call => call.method === "PUT" ? new Response(null, { status: 204 }) : Response.json(POOL)
  })
  h.seam.resumeCodingProviders()
  expect(h.toasts).toEqual(["Moving connection…"])
  expect(await h.work[0]).toBe(true)
  expect(h.calls).toEqual([{ method: "PUT", path: "/api/user/provider-connections/order", body: JSON.stringify({ provider: "claude", ids: ["b", "a"] }) }])
  expect(h.rows()[0]?.state).toBe("completed")
})

test("a held accounts read never hides the Codex code or stalls polling", async () => {
  const h = harness({ card: true, http: async call => {
    if (call.path.endsWith("/codex/device")) return Response.json(device("pending"))
    if (call.path.includes("/codex/device/")) return Response.json(device("connected"))
    return new Promise<Response>(() => {})
  } })
  const codes: unknown[] = []
  h.onCard(payload => codes.push(payload.pending))
  await h.seam.connectCodex()
  expect(await h.work[0]).toBe(true)
  expect(codes).toContainEqual({ userCode: "ABCD-EFGH", verificationUri: "https://auth.openai.com/codex/device" })
  expect(h.calls.filter(call => call.path.includes("/codex/device/"))).toHaveLength(1)
  expect(h.rows()[0]?.state).toBe("completed")
})

test("reload puts a persisted Codex code back on the card while it polls", async () => {
  const wait = deferred<void>()
  const h = harness({
    sleep: () => wait.promise,
    rows: [{ id: "request-1", owner: "alice", action: "codex", state: "requested", device: { id: DEVICE_ID, userCode: "WXYZ-1234", verificationUri: "https://auth.openai.com/codex/device", interval: 2, expiresAt: "2999-01-01T00:00:00Z" } }],
    http: async call => call.path.includes("/codex/device/") ? Response.json(device("connected")) : Response.json(POOL)
  })
  h.seam.resumeCodingProviders()
  for (let index = 0; index < 5; index += 1) await tick()
  expect(h.accounts()?.pending).toEqual({ userCode: "WXYZ-1234", verificationUri: "https://auth.openai.com/codex/device" })
  wait.resolve()
  expect(await h.work[0]).toBe(true)
  expect(h.accounts()?.pending).toBeUndefined()
})

test("Claude accepts an Anthropic API key and refuses a subscription token", async () => {
  for (const token of ["sk-ant-api03-fixture"]) {
    const h = harness({ card: true, http: async call => call.method === "POST"
      ? Response.json({ id: "conn-9", provider: "claude", state: "active", label: JSON.parse(call.body!).label })
      : Response.json(POOL) })
    expect(await h.seam.connectCodingProvider(writeOnlyGesture("secrets.connect", { value: token }))).toEqual({ value: "Requested" })
    expect(await h.work[0]).toBe(true)
    const body = JSON.parse(h.calls[0]!.body!)
    expect(body).toEqual({ provider: "claude", label: `web-${h.rows()[0]!.id}`, access_token: token })
    expect(h.calls.at(-1)).toEqual({ method: "GET", path: "/api/user/provider-connections" })
    expect(JSON.stringify(h.accounts())).not.toContain(token)
  }
  const h = harness({ http: async () => Response.json(POOL) })
  expect(await h.seam.connectCodingProvider(writeOnlyGesture("secrets.connect", { value: "sk-ant-oat01-fixture" }))).toBe("Enter an Anthropic API key.")
  expect(h.calls).toEqual([])
  expect(await h.seam.connectCodingProvider(writeOnlyGesture("secrets.connect", { value: "sk-other" }))).toBe("Enter an Anthropic API key.")
})

test("connecting Claude while a move is pending sends the token instead of joining the move", async () => {
  const h = harness({
    rows: [{ id: "order-1", owner: "alice", action: "order", provider: "claude", ids: ["b", "a"], state: "requested" }],
    http: async call => call.method === "POST"
      ? Response.json({ id: "conn-9", provider: "claude", state: "active", label: JSON.parse(call.body!).label })
      : new Response(null, { status: 204 })
  })
  expect(await h.seam.connectCodingProvider(writeOnlyGesture("secrets.connect", { value: "sk-ant-api03-fixture" }))).toEqual({ value: "Requested" })
  expect(await h.work.at(-1)).toBe(true)
  expect(h.calls.find(call => call.method === "POST")?.body).toContain("sk-ant-api03-fixture")
})

test("two quick presses while persistence is held compute from each other", async () => {
  const persisted = deferred<void>()
  const bodies: string[] = []
  const h = harness({ card: true, persist: () => persisted.promise, http: async call => {
    if (call.method === "PUT") { bodies.push(call.body!); return new Response(null, { status: 204 }) }
    return new Promise<Response>(() => {})
  } })
  h.setAccounts(cardOf(["a", "b", "c"]))
  const first = h.seam.moveCodingProvider("c", "up")
  const second = h.seam.moveCodingProvider("c", "up")
  expect(h.accounts()?.accounts.map(row => row.id)).toEqual(["c", "a", "b"])
  persisted.resolve()
  await first; await second
  await Promise.all(h.work)
  expect(bodies.map(body => JSON.parse(body).ids).at(-1)).toEqual(["c", "a", "b"])
})

test("an older read answering last never reverts the card, and a pending order keeps its local order", async () => {
  const older = deferred<Response>()
  const newer = deferred<Response>()
  const reads = [older.promise, newer.promise]
  const h = harness({ http: async () => reads.shift() ?? Response.json(POOL) })
  const first = h.seam.listCodingProviders()
  const second = h.seam.listCodingProviders()
  newer.resolve(Response.json(POOL.filter(row => row.id !== "b")))
  await second
  older.resolve(Response.json(POOL))
  await first
  expect(h.accounts()?.accounts.map(row => row.id)).toEqual(["a", "c", "x"])

  const held = harness({
    card: true,
    rows: [{ id: "order-1", owner: "alice", action: "order", provider: "claude", ids: ["c", "b", "a"], state: "requested" }],
    http: async () => Response.json(POOL)
  })
  await held.seam.listCodingProviders()
  expect(held.accounts()?.accounts.map(row => row.id)).toEqual(["c", "b", "a", "x"])
})

/*
 * Hosted smithers.sh does not store subscription logins: plue answers every
 * provider-connections route with the feature gate's 403. The Accounts card
 * then drops its connect buttons and every door says the feature is absent.
 */
const gated = () => Response.json({ message: "feature not available" }, { status: 403 })
const UNAVAILABLE = "Coding accounts are not available on this deployment."

test("a feature-gated connections list shows the Accounts card without connect buttons", async () => {
  const h = harness({ http: async () => gated() })
  expect(await h.seam.listCodingProviders()).toBe(UNAVAILABLE)
  expect(h.accounts()).toEqual({ accounts: [], unavailable: true })
})

test("a feature-gated Claude or Codex connect fails its toast plainly and hides the buttons", async () => {
  const claude = harness({ card: true, http: async () => gated() })
  expect(await claude.seam.connectCodingProvider(writeOnlyGesture("secrets.connect", { value: "sk-ant-api03-fixture" }))).toEqual({ value: "Requested" })
  expect(await claude.work[0]).toBe(UNAVAILABLE)
  expect(claude.accounts()?.unavailable).toBe(true)
  expect(claude.rows()[0]).toMatchObject({ state: "failed" })

  const codex = harness({ card: true, http: async () => gated() })
  expect(await codex.seam.connectCodex()).toEqual({ value: "Requested" })
  expect(await codex.work[0]).toBe(UNAVAILABLE)
  expect(codex.accounts()?.unavailable).toBe(true)
})

test("any other 403 keeps the connect buttons", async () => {
  const h = harness({ http: async () => Response.json({ message: "forbidden" }, { status: 403 }) })
  expect(await h.seam.listCodingProviders()).toBe("Coding connections unavailable (HTTP 403).")
  expect(h.accounts()).toBeUndefined()
})

const unreadablePools = [
  { label: "malformed JSON", response: () => new Response("{") },
  { label: "null", response: () => Response.json(null) },
  { label: "object", response: () => Response.json({}) },
  { label: "scalar", response: () => Response.json(42) },
  { label: "one invalid required row", response: () => Response.json([POOL[0], { provider: "claude", state: "active", label: "missing id" }]) },
  { label: "body read failure", response: () => new Response(new ReadableStream<Uint8Array>({ start: controller => controller.error(new Error("controlled pool read failure")) })) }
]
test.each(unreadablePools)("$label cannot turn the last observed pool into verified empty accounts, and a later read recovers", async ({ response }) => {
  const replies = [Response.json(POOL), response(), Response.json([])]
  const h = harness({ http: async () => { const reply = replies.shift(); if (!reply) throw new Error("Unexpected pool read"); return reply } })
  await h.seam.listCodingProviders()
  const before = h.accounts()
  expect(await h.seam.listCodingProviders()).toBe("Coding connections unavailable.")
  expect(h.accounts()).toEqual(before)
  expect(await h.seam.listCodingProviders()).toEqual({ value: "No coding connections." })
  expect(h.accounts()).toEqual({ accounts: [] })
  expect(h.calls).toEqual([
    { method: "GET", path: "/api/user/provider-connections" },
    { method: "GET", path: "/api/user/provider-connections" },
    { method: "GET", path: "/api/user/provider-connections" }
  ])
})

test("pool projection groups providers, keeps equal ranks stable, and omits revoked rows with a literal model result", async () => {
  const h = harness({ http: async () => Response.json([
    { id: "y", provider: "codex", state: "active", label: "Codex Y", sort_order: 2 },
    { id: "c", provider: "claude", state: "refresh_failed", label: "Claude C", sort_order: 2 },
    { id: "gone", provider: "claude", state: "revoked", label: "Gone", sort_order: 0 },
    { id: "b", provider: "claude", state: "active", label: "Claude B", account_email: "b@example.test", sort_order: 1 },
    { id: "a", provider: "claude", state: "active", label: "Claude A", limited_until: "2026-09-30T00:00:00Z", sort_order: 1 },
    { id: "x", provider: "codex", state: "active", label: "Codex X", sort_order: 0 }
  ]) })
  expect(await h.seam.listCodingProviders()).toEqual({ value: "b · claude · b@example.test · active\na · claude · Claude A · active · limited until 2026-09-30T00:00:00Z\nc · claude · Claude C · refresh_failed\nx · codex · Codex X · active\ny · codex · Codex Y · active" })
  expect(h.accounts()).toEqual({ accounts: [
    { id: "b", provider: "claude", state: "active", label: "Claude B", email: "b@example.test", limitedUntil: null },
    { id: "a", provider: "claude", state: "active", label: "Claude A", email: null, limitedUntil: "2026-09-30T00:00:00Z" },
    { id: "c", provider: "claude", state: "refresh_failed", label: "Claude C", email: null, limitedUntil: null },
    { id: "x", provider: "codex", state: "active", label: "Codex X", email: null, limitedUntil: null },
    { id: "y", provider: "codex", state: "active", label: "Codex Y", email: null, limitedUntil: null }
  ] })
})

const invalidStarts = [
  { label: "non-object", body: null },
  { label: "invalid device id", body: device("pending", { id: "not-a-device-id" }) },
  { label: "non-string code", body: device("pending", { user_code: 4 }) },
  { label: "non-HTTPS verification", body: device("pending", { verification_uri: "http://auth.openai.com/device" }) },
  { label: "malformed verification URL", body: device("pending", { verification_uri: "missing-origin" }) },
  { label: "non-string expiry", body: device("pending", { expires_at: null }) },
  { label: "unknown state", body: device("unknown") },
  { label: "already connected", body: device("connected") }
]
test.each(invalidStarts)("Codex $label start fails without admitting a code or polling", async ({ body }) => {
  const h = harness({ http: async () => Response.json(body, { status: 201 }) })
  expect(await h.seam.connectCodex()).toEqual({ value: "Requested" })
  expect(await h.work[0]).toBe("Codex sign-in failed.")
  expect(h.rows()).toEqual([{ id: expect.any(String), owner: "alice", action: "codex", state: "failed" }])
  expect(h.accounts()).toBeUndefined()
  expect(h.sleeps).toEqual([])
  expect(h.calls).toEqual([{ method: "POST", path: "/api/user/provider-connections/codex/device" }])
})

const invalidPolls = [
  { label: "different valid device id", response: () => Response.json(device("connected", { id: "1f9ed5c2-989d-4311-9a35-37e68a219088" })) },
  { label: "malformed JSON", response: () => new Response("{") },
  { label: "null body", response: () => Response.json(null) },
  { label: "unknown state", response: () => Response.json(device("unknown")) },
  { label: "body reader failure", response: () => new Response(new ReadableStream<Uint8Array>({ start: controller => controller.error(new Error("controlled poll read failure")) })) }
]
test.each(invalidPolls)("Codex $label poll cannot complete sign-in and clears its pending code", async ({ response }) => {
  const h = harness({ http: async call => call.path.endsWith("/codex/device") ? Response.json(device("pending"))
    : call.path.endsWith(`/codex/device/${DEVICE_ID}`) ? response() : Response.json([]) })
  await h.seam.connectCodex()
  expect(await h.work[0]).toBe("Codex sign-in failed.")
  expect(h.rows()[0]?.state).toBe("failed")
  expect(h.accounts()?.pending).toBeUndefined()
  expect(h.sleeps).toEqual([5000])
  expect(h.calls.filter(call => call.method === "POST")).toEqual([
    { method: "POST", path: "/api/user/provider-connections/codex/device" },
    { method: "POST", path: `/api/user/provider-connections/codex/device/${DEVICE_ID}` }
  ])
})

test("a rate-limited Codex poll waits again and only a matching connected reply completes it", async () => {
  const responses = [new Response(null, { status: 429 }), Response.json(device("connected"))]
  const h = harness({ http: async call => call.path.endsWith("/codex/device") ? Response.json(device("pending", { interval_seconds: 2 }))
    : call.path.includes("/codex/device/") ? responses.shift()! : Response.json([]) })
  await h.seam.connectCodex()
  expect(await h.work[0]).toBe(true)
  expect(h.sleeps).toEqual([2000, 2000])
  expect(h.rows()[0]?.state).toBe("completed")
  expect(h.calls.filter(call => call.path.includes("/codex/device/"))).toHaveLength(2)
})

test.each(["owner change", "retirement"])("%s while Codex is waiting prevents any poll or terminal publication", async change => {
  const wait = deferred<void>()
  const h = harness({ sleep: () => wait.promise, http: async call => call.path.endsWith("/codex/device") ? Response.json(device("pending")) : Response.json([]) })
  await h.seam.connectCodex()
  await h.sleepEntered
  if (change === "owner change") h.login("bob")
  else h.retire()
  const request = h.rows()
  const card = h.accounts()
  wait.resolve()
  expect(await h.work[0]).not.toBe(true)
  await tick()
  expect(h.rows()).toEqual(request)
  expect(h.accounts()).toEqual(card)
  expect(h.calls.some(call => call.path.includes("/codex/device/"))).toBe(false)
  expect(h.messages).toEqual([])
})

test("user and Smithers seams over one store join a held Codex sign-in", async () => {
  const start = deferred<Response>()
  const h = harness({ http: async call => call.path.endsWith("/codex/device") ? start.promise
    : call.path.includes("/codex/device/") ? Response.json(device("connected")) : Response.json([]) })
  const agent = h.anotherSeam("smithers")
  const answers = await Promise.all([h.seam.connectCodex(), agent.connectCodex()])
  expect(answers).toEqual([{ value: "Requested" }, { value: "Requested" }])
  expect(h.rows()).toHaveLength(1)
  expect(h.work).toHaveLength(1)
  expect(h.calls).toEqual([{ method: "POST", path: "/api/user/provider-connections/codex/device" }])
  start.resolve(Response.json(device("pending")))
  expect(await h.work[0]).toBe(true)
  expect(h.rows()[0]?.state).toBe("completed")
})

const signedOutActions = [
  { label: "Claude", run: (seam: ReturnType<typeof createSecretsSeam>) => seam.connectCodingProvider(writeOnlyGesture("secrets.connect", { value: "sk-ant-oat01-unsigned-fixture" })), expected: "Sign in to connect Claude." },
  { label: "Codex", run: (seam: ReturnType<typeof createSecretsSeam>) => seam.connectCodex(), expected: "Sign in to connect Codex." },
  { label: "list", run: (seam: ReturnType<typeof createSecretsSeam>) => seam.listCodingProviders(), expected: "Sign in to list coding connections." },
  { label: "move", run: (seam: ReturnType<typeof createSecretsSeam>) => seam.moveCodingProvider("a", "down"), expected: "Sign in to reorder coding connections." },
  { label: "revoke", run: (seam: ReturnType<typeof createSecretsSeam>) => seam.revokeCodingProvider("a"), expected: "Sign in to revoke a coding connection." }
]
test.each(signedOutActions)("signed-out $label admission causes no HTTP, request, card, or toast", async ({ run, expected }) => {
  const h = harness({ http: async () => { throw new Error("Unsigned request must not run") } })
  h.login(null)
  expect(await run(h.seam)).toBe(expected)
  expect(h.calls).toEqual([])
  expect(h.rows()).toEqual([])
  expect(h.accounts()).toBeUndefined()
  expect(h.toasts).toEqual([])
})

const orderedPool = [
  { id: "a", provider: "claude", state: "active", label: "A", sort_order: 0 },
  { id: "b", provider: "claude", state: "active", label: "B", sort_order: 1 },
  { id: "c", provider: "claude", state: "active", label: "C", sort_order: 2 },
  { id: "x", provider: "codex", state: "active", label: "X", sort_order: 0 },
  { id: "y", provider: "codex", state: "active", label: "Y", sort_order: 1 }
]

test.each(["success", "HTTP refusal", "transport throw"])("queued orders serialize a held first PUT and recover after %s", async firstOutcome => {
  const firstEntered = deferred<void>(), secondEntered = deferred<void>()
  const firstReply = deferred<Response>(), secondReply = deferred<Response>()
  let server = orderedPool
  let puts = 0
  const h = harness({ http: async call => {
    if (call.method === "GET") return Response.json(server)
    if (call.method !== "PUT") throw new Error("Only pool reads and order writes are expected")
    if (++puts === 1) { firstEntered.resolve(); return firstReply.promise }
    if (puts === 2) { secondEntered.resolve(); return secondReply.promise }
    throw new Error("An order must not be retried automatically")
  } })
  await h.seam.listCodingProviders()
  await tick()
  expect(await h.seam.moveCodingProvider("a", "down")).toEqual({ value: "Requested" })
  await firstEntered.promise
  expect(await h.seam.moveCodingProvider("c", "up")).toEqual({ value: "Requested" })
  await tick()
  expect(h.calls.filter(call => call.method === "PUT")).toEqual([
    { method: "PUT", path: "/api/user/provider-connections/order", body: '{"provider":"claude","ids":["b","a","c"]}' }
  ])
  expect(h.accounts()?.accounts.map(row => row.id)).toEqual(["b", "c", "a", "x", "y"])
  expect(h.rows().filter(row => row.action === "order" && row.state === "requested").map(row => row.ids)).toEqual([["b", "c", "a"]])
  if (firstOutcome === "success") {
    server = [
      { id: "a", provider: "claude", state: "active", label: "A", sort_order: 1 },
      { id: "b", provider: "claude", state: "active", label: "B", sort_order: 0 },
      { id: "c", provider: "claude", state: "active", label: "C", sort_order: 2 },
      { id: "x", provider: "codex", state: "active", label: "X", sort_order: 0 },
      { id: "y", provider: "codex", state: "active", label: "Y", sort_order: 1 }
    ]
    firstReply.resolve(new Response(null, { status: 204 }))
  } else if (firstOutcome === "HTTP refusal") firstReply.resolve(new Response(null, { status: 503 }))
  else firstReply.reject(new Error("controlled order transport failure"))
  await secondEntered.promise
  const firstResult = await h.work[0]
  if (firstOutcome === "success") expect(firstResult).toBe(true)
  else if (firstOutcome === "HTTP refusal") expect(firstResult).toBe("Connection move failed (HTTP 503).")
  else {
    expect(typeof firstResult).toBe("string")
    expect(firstResult).not.toBe("")
  }
  let secondSettled = false
  void h.work[1]?.then(() => { secondSettled = true })
  await tick()
  expect(secondSettled).toBe(false)
  expect(h.calls.filter(call => call.method === "PUT")).toEqual([
    { method: "PUT", path: "/api/user/provider-connections/order", body: '{"provider":"claude","ids":["b","a","c"]}' },
    { method: "PUT", path: "/api/user/provider-connections/order", body: '{"provider":"claude","ids":["b","c","a"]}' }
  ])
  server = [
    { id: "a", provider: "claude", state: "active", label: "A", sort_order: 2 },
    { id: "b", provider: "claude", state: "active", label: "B", sort_order: 0 },
    { id: "c", provider: "claude", state: "active", label: "C", sort_order: 1 },
    { id: "x", provider: "codex", state: "active", label: "X", sort_order: 0 },
    { id: "y", provider: "codex", state: "active", label: "Y", sort_order: 1 }
  ]
  secondReply.resolve(new Response(null, { status: 204 }))
  expect(await h.work[1]).toBe(true)
  await tick()
  expect(h.accounts()?.accounts.map(row => row.id)).toEqual(["b", "c", "a", "x", "y"])
  expect(h.rows().find(row => row.action === "order" && row.ids?.join(",") === "b,c,a")?.state).toBe("completed")
  expect(puts).toBe(2)
})

const directionCases = [
  { label: "Claude down", id: "a", direction: "down", body: '{"provider":"claude","ids":["b","a","c"]}', ids: ["b", "a", "c", "x", "y"], wire: [
    { id: "a", provider: "claude", state: "active", label: "A", sort_order: 1 },
    { id: "b", provider: "claude", state: "active", label: "B", sort_order: 0 },
    { id: "c", provider: "claude", state: "active", label: "C", sort_order: 2 },
    { id: "x", provider: "codex", state: "active", label: "X", sort_order: 0 },
    { id: "y", provider: "codex", state: "active", label: "Y", sort_order: 1 }
  ] },
  { label: "Codex up", id: "y", direction: "up", body: '{"provider":"codex","ids":["y","x"]}', ids: ["a", "b", "c", "y", "x"], wire: [
    { id: "a", provider: "claude", state: "active", label: "A", sort_order: 0 },
    { id: "b", provider: "claude", state: "active", label: "B", sort_order: 1 },
    { id: "c", provider: "claude", state: "active", label: "C", sort_order: 2 },
    { id: "x", provider: "codex", state: "active", label: "X", sort_order: 1 },
    { id: "y", provider: "codex", state: "active", label: "Y", sort_order: 0 }
  ] }
] as const
test.each([...directionCases])("$label writes only its provider's complete order and preserves its peer pool", async ({ id, direction, body, ids, wire }) => {
  let server: ReadonlyArray<(typeof orderedPool)[number]> = orderedPool
  const h = harness({ http: async call => {
    if (call.method === "GET") return Response.json(server)
    if (call.method !== "PUT") throw new Error("Only an order write is expected")
    server = wire
    return new Response(null, { status: 204 })
  } })
  await h.seam.listCodingProviders()
  await tick()
  expect(await h.seam.moveCodingProvider(id, direction)).toEqual({ value: "Requested" })
  expect(await h.work[0]).toBe(true)
  await tick()
  expect(h.calls.filter(call => call.method === "PUT")).toEqual([{ method: "PUT", path: "/api/user/provider-connections/order", body }])
  expect(h.accounts()?.accounts.map(row => row.id)).toEqual([...ids])
  expect(h.rows()).toHaveLength(1)
  expect(h.rows()[0]?.state).toBe("completed")
})

const remainingMoveEdges = [
  { label: "last Claude down", id: "c", direction: "down" },
  { label: "single Codex up", id: "x", direction: "up" },
  { label: "single Codex down", id: "x", direction: "down" }
] as const
test.each([...remainingMoveEdges])("$label is already in place without creating durable work", async ({ id, direction }) => {
  const h = harness({ http: async () => Response.json(orderedPool.filter(row => row.id !== "y")) })
  await h.seam.listCodingProviders()
  await tick()
  const before = h.accounts()
  expect(await h.seam.moveCodingProvider(id, direction)).toEqual({ value: "Already in place." })
  expect(h.accounts()).toEqual(before)
  expect(h.calls).toEqual([{ method: "GET", path: "/api/user/provider-connections" }])
  expect(h.rows()).toEqual([])
  expect(h.work).toEqual([])
})

const invalidResumedOrders = [
  { label: "missing provider", row: { id: "order-no-provider", owner: "alice", action: "order", ids: ["a", "b"], state: "requested" } },
  { label: "missing ids", row: { id: "order-no-ids", owner: "alice", action: "order", provider: "claude", state: "requested" } },
  { label: "invalid id", row: { id: "order-bad-id", owner: "alice", action: "order", provider: "claude", ids: ["a", "bad_id"], state: "requested" } }
] satisfies Array<{ label: string; row: RequestRow }>
test.each(invalidResumedOrders)("a schema-valid resumed order with $label fails before any outbound write", async ({ row }) => {
  expect(SessionSchema.shape.codingProviderRequests.unwrap().safeParse([row]).success).toBe(true)
  const h = harness({ rows: [row], http: async () => { throw new Error("Invalid resumed order must not reach HTTP") } })
  h.seam.resumeCodingProviders()
  expect(await h.work[0]).toBe("Invalid connection.")
  expect(h.rows()).toEqual([{ ...row, state: "failed" }])
  expect(h.calls).toEqual([])
})
