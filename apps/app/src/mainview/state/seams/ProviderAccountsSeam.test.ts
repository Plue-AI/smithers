import { expect, test } from "bun:test"
import { writeOnlyGesture } from "../../flows/CommandGesture"
import type { Card } from "../AppState"
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
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
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
  const cards = new Map<string, Card>()
  const calls: Call[] = []
  const toasts: string[] = []
  const messages: string[] = []
  const work: Promise<unknown>[] = []
  const sleeps: number[] = []
  const watchers: Array<(payload: Extract<Card, { kind: "provider-accounts" }>["payload"]) => void> = []
  const ctx = {
    baseUrl: "https://smithers.sh", isDisposed: () => false, nextOrdinal: () => ++ordinal, actor: () => "user",
    store: { session: () => ({ codingProviderRequests: rows }), collections: {
      identitySessions: { get: () => ({ login: "alice", ownerRevision: 1 }) },
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
  const seam = createSecretsSeam(ctx, withToast, { sleep: async ms => { sleeps.push(ms); await options.sleep?.(ms) } })
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
  return { seam, calls, toasts, messages, work, sleeps, rows: () => rows, accounts, setAccounts, onCard }
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
