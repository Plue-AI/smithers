import { strict as assert } from "node:assert"
import { createServer } from "node:http"
import { setImmediate } from "node:timers/promises"
import { test } from "node:test"
import { make } from "../../smithers/agent/integrations/src/core/IssueSync.ts"
import { runDeliveries } from "./delivery.ts"

// Only time is simulated. HTTP, SSE parsing, and the durable bridge's refusal
// classification use their real public boundaries; no provider write is needed.
test("real HTTP 429 receipts keep Retry-After despite SSE and idle drains stay below quota", async t => {
  let checks = 0, connections = 0
  let stream: import("node:http").ServerResponse | undefined
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/stream")) {
      connections++
      stream = response
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      response.write(": connected\n\n")
      return
    }
    assert.match(request.url ?? "", /\/issues\/sync\/deliveries/)
    checks++
    response.writeHead(checks === 1 ? 429 : 200, {
      "Content-Type": "application/json", ...(checks === 1 ? { "Retry-After": "120" } : {})
    })
    response.end(checks === 1 ? '{"message":"rate limit exceeded"}' : "[]")
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as import("node:net").AddressInfo
  const stop = new AbortController()
  const request = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, signal: stop.signal })
  const bridge = make({ owner: "owner", repo: "repository", request, connector: {
    accepts: () => true,
    deliver: async () => { throw new Error("idle bridge must not call a provider") },
    reconcile: async () => { throw new Error("idle bridge must not call a provider") }
  } })
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  const run = runDeliveries({ owner: "owner", repo: "repository", request, drain: bridge.drain, signal: stop.signal })
  const settle = async () => { for (let i = 0; i < 20; i++) await setImmediate() }
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 1000 && !condition(); i++) await setImmediate()
    assert.ok(condition(), "HTTP exchange did not settle")
    await settle()
  }
  try {
    await until(() => checks === 1 && connections === 1)
    stream!.write("id: 1\nevent: issue.fact\ndata: {}\n\n")
    await settle()
    t.mock.timers.tick(119_999)
    await settle()
    assert.equal(checks, 1, "SSE cannot shorten the actual HTTP Retry-After")
    t.mock.timers.tick(1)
    await until(() => checks === 2)
    for (let seconds = 120; seconds < 3600; seconds++) {
      t.mock.timers.tick(1000)
      await settle()
    }
    assert.ok(checks + connections < 30, `${checks} list calls + ${connections} stream connects`)
    assert.equal(connections, 1)
    const before = checks
    stream!.write("id: 2\nevent: issue.sync\ndata: {}\n\n")
    await until(() => checks > before)
    t.diagnostic(`${checks} real HTTP list calls and ${connections} stream connection across a simulated hour`)
  } finally {
    stop.abort()
    await run
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
