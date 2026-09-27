import { strict as assert } from "node:assert"
import { test } from "node:test"
import { runDeliveries } from "./delivery.ts"

const flush = async () => { for (let i = 0; i < 300; i++) await Promise.resolve() }
const fixture = () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const requests: RequestInit[] = []
  const request = async (_path: string, init?: RequestInit) => {
    requests.push(init ?? {})
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller
        const abort = () => { try { controller.close() } catch {} }
        init?.signal?.addEventListener("abort", abort, { once: true })
      }
    }), { headers: { "content-type": "text/event-stream" } })
  }
  return { request, requests, event: (id: number, type = "issue.fact") => stream.enqueue(new TextEncoder().encode(`id: ${id}\r\nevent: ${type}\r\ndata: {}\r\n\r\n`)), close: () => stream.close() }
}

test("an idle hour with two providers stays well below the repository budget; a signal delivers immediately", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  const f = fixture(), stop = new AbortController()
  let checks = 0
  const run = runDeliveries({ request: f.request, owner: "will", repo: "chat", drain: async () => { checks += 2; return 0 }, signal: stop.signal })
  await flush()
  for (let second = 0; second < 3600; second++) { t.mock.timers.tick(1000); await flush() }
  assert.ok(checks < 40, `delivery checks: ${checks}`)
  t.diagnostic(`idle hour: ${checks} delivery-list requests + ${f.requests.length} stream connection`)
  assert.equal(f.requests.length, 1, "the stream stays open for the hour")
  const before = checks
  f.event(1)
  await flush()
  assert.equal(checks, before + 2, "no fallback timer must elapse")
  f.event(2, "issue.sync")
  await flush()
  assert.equal(checks, before + 4, "reactions and retries wake without a new fact")
  stop.abort()
  await run
})

test("wakeups during a drain are coalesced and never lost or run concurrently", async () => {
  const f = fixture(), stop = new AbortController()
  let release!: () => void, calls = 0
  const run = runDeliveries({ request: f.request, owner: "will", repo: "chat", signal: stop.signal, drain: async () => {
    if (++calls === 1) await new Promise<void>(resolve => { release = resolve })
    return 0
  } })
  await flush()
  for (let id = 1; id <= 50; id++) f.event(id)
  await flush()
  assert.equal(calls, 1)
  release()
  await flush()
  assert.equal(calls, 2)
  stop.abort()
  await run
})

for (const retryAfter of ["120", "Thu, 01 Jan 1970 00:02:00 GMT"]) {
  test(`429 receipt Retry-After ${retryAfter} survives notifications`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
    const f = fixture(), stop = new AbortController()
    let calls = 0
    const run = runDeliveries({ request: f.request, owner: "will", repo: "chat", signal: stop.signal, drain: async () => {
      if (++calls === 1) throw new AggregateError([Object.assign(new Error("receipt"), { status: 429, retryAfter })])
      return 0
    } })
    await flush()
    f.event(1)
    await flush()
    t.mock.timers.tick(119_999)
    await flush()
    assert.equal(calls, 1)
    t.mock.timers.tick(1)
    await flush()
    assert.equal(calls, 2)
    stop.abort()
    await run
  })
}

test("stream refusals back off, honor Retry-After, and repair polls remain bounded for an hour", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  const stop = new AbortController()
  let connections = 0, checks = 0
  const run = runDeliveries({ owner: "will", repo: "chat", signal: stop.signal,
    request: async () => { connections++; return new Response(null, { status: 429, headers: { "Retry-After": "120" } }) },
    drain: async () => { checks += 2; return 0 }
  })
  await flush()
  t.mock.timers.tick(119_999)
  await flush()
  assert.equal(connections, 1)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(connections, 2)
  for (let second = 120; second < 3600; second++) { t.mock.timers.tick(1000); await flush() }
  assert.ok(connections + checks < 100, `${connections} connections + ${checks} checks`)
  stop.abort()
  await run
})

test("reconnect resumes the cursor and rechecks persisted deliveries", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  const f = fixture(), stop = new AbortController()
  let checks = 0
  const run = runDeliveries({ request: f.request, owner: "will", repo: "chat", signal: stop.signal, drain: async () => { checks++; return 0 } })
  await flush()
  f.event(7)
  await flush()
  f.close()
  await flush()
  t.mock.timers.tick(30_000)
  await flush()
  assert.equal(f.requests.length, 2)
  assert.equal(new Headers(f.requests[1]?.headers).get("Last-Event-ID"), "7")
  assert.ok(checks >= 3)
  stop.abort()
  await run
})

test("an hour with a delivery each minute remains under budget with low wake latency", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  const { make } = await import("../../smithers/agent/integrations/src/core/IssueSync.ts")
  const f = fixture(), stop = new AbortController()
  let calls = 0, sent = 0, queuedAt = 0, latency = 0
  let pending: unknown[] = []
  const request = async (path: string, init?: RequestInit) => {
    calls++
    if (path.endsWith("/stream")) return f.request(path, init)
    if (init?.method === "POST") return Response.json({ state: "dispatching", token: "claim" })
    if (init?.method === "PUT") { pending = []; return Response.json({}) }
    return Response.json(pending)
  }
  const bridge = (provider: string) => make({ owner: "will", repo: "chat", request, connector: {
    accepts: mapping => mapping.provider === provider,
    deliver: async () => { sent++; latency = Math.max(latency, Date.now() - queuedAt); return { messageId: "100.1" } },
    reconcile: async () => undefined
  } })
  const slack = bridge("slack"), telegram = bridge("telegram")
  const run = runDeliveries({ owner: "will", repo: "chat", request, signal: stop.signal,
    drain: async () => await slack.drain() + await telegram.drain()
  })
  await flush()
  for (let minute = 0; minute < 60; minute++) {
    t.mock.timers.tick(60_000)
    await flush()
    queuedAt = Date.now()
    pending = [{ id: minute + 1, key: String(minute), issue_id: 42, state: "pending", event: "comment.created",
      payload: { comment: { id: minute, body: "hello" } }, message_id: "",
      mapping: { provider: "slack", connection_id: "slack", scope_id: "T001", conversation_id: "C001", thread_id: "" }
    }]
    f.event(minute + 1)
    await flush()
    assert.equal(sent, minute + 1, "every wake delivers before another clock tick")
  }
  assert.ok(calls < 500, `${calls} API requests in an active hour`)
  assert.equal(latency, 0)
  t.diagnostic(`active hour: ${calls} API requests for ${sent} deliveries; simulated wake latency ${latency}ms`)
  stop.abort()
  await run
})
