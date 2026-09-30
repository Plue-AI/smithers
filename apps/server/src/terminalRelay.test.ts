import { afterEach, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { ExecutionContext, executionContextFrom, layersFromEnv } from "./Environment"
import { transportLayer } from "./Http"
import worker, { handleRequest } from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"
import { TerminalSockets } from "./terminalRelay"
import type { RelaySocket } from "./terminalRelay"

type Events = { message: MessageEvent<string | ArrayBuffer>; close: CloseEvent; error: Event }
class Socket implements RelaySocket {
  binaryType = "blob"
  accepted = false
  sent: Array<string | ArrayBuffer> = []
  closes: Array<{ code: number | undefined; reason: string | undefined }> = []
  listeners = new Map<string, Set<(event: never) => void>>()
  failSend = false
  accept() { this.accepted = true }
  send(data: string | ArrayBuffer) {
    if (this.failSend) throw new Error("gone")
    this.sent.push(data)
  }
  close(code?: number, reason?: string) { this.closes.push({ code, reason }) }
  addEventListener<K extends keyof Events>(type: K, listener: (event: Events[K]) => void) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener as (event: never) => void)
    this.listeners.set(type, listeners)
  }
  removeEventListener<K extends keyof Events>(type: K, listener: (event: Events[K]) => void) {
    this.listeners.get(type)?.delete(listener as (event: never) => void)
  }
  emit<K extends keyof Events>(type: K, event: Events[K]) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never)
  }
  message(data: string | ArrayBuffer) { this.emit("message", { data } as MessageEvent<string | ArrayBuffer>) }
  ended(code: number, reason: string) { this.emit("close", { code, reason } as CloseEvent) }
}

const active: Socket[] = []
afterEach(() => {
  for (const socket of active.splice(0)) socket.ended(1000, "test finished")
})

const path = "/api/cloud-ws/repos/ada/project/workspace/sessions/sess-1/terminal"
const env = () => ({
  ...memoryDurableObjects(),
  ASSETS: { fetch: async () => new Response("asset") },
  IDENTITY_UPSTREAM_URL: "https://identity.test",
  IDENTITY_SERVICE_TOKEN: "service-fixture",
  SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test/base"
})
const request = (options: { path?: string; cookie?: boolean; origin?: string; upgrade?: boolean; method?: string } = {}) =>
  new Request(`https://web.test${options.path ?? path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.cookie === false ? {} : { cookie: "session=fixture" }),
      ...(options.upgrade === false ? {} : { upgrade: "websocket" }),
      origin: options.origin ?? "https://web.test",
      "sec-websocket-protocol": "untrusted-page-protocol"
    }
  })

const run = (req = request(), options: { identity?: number; token?: boolean; status?: number; offline?: boolean } = {}) => {
  const calls: Request[] = []
  const upstream = new Socket()
  active.push(upstream)
  const downstream = new Socket()
  let pairs = 0
  const response = Effect.runPromise(handleRequest(req).pipe(
    Effect.provideService(ExecutionContext, executionContextFrom(undefined)),
    Effect.provideService(TerminalSockets, { pair: Effect.sync(() => {
      pairs++
      return { server: downstream, response: new Response(null, { status: 101 }) }
    }) }),
    Effect.provide(transportLayer(async (input, init) => {
      const call = new Request(input, init)
      calls.push(call)
      const target = new URL(call.url)
      if (target.pathname === "/api/identity/validate") {
        return Response.json({ login: "ada", admin: false, scopes: [] }, { status: options.identity ?? 200 })
      }
      if (target.pathname === "/api/identity/cloud-token") {
        return Response.json(options.token === false ? { found: false } : { found: true, token: "private-fixture-token" })
      }
      if (options.offline) throw new Error("private-fixture-token must not escape a failed transport")
      if (options.status !== undefined) return new Response("private-fixture-token must not escape a refusal", { status: options.status })
      return Object.assign(new Response(null, { status: 101 }), { webSocket: upstream })
    })),
    Effect.provide(layersFromEnv(env()))
  ))
  return { response, calls, upstream, downstream, pairs: () => pairs }
}

test("the deployed route refuses a missing session with HTTP 401 before creating a pair", async () => {
  const response = await worker.fetch(request({ cookie: false }), env())
  expect(response.status).toBe(401)
  expect((await response.json() as { code: string }).code).toBe("sign_in_required")
})

for (const status of [401, 503]) {
  test(`identity ${status} never exchanges a token or upgrades`, async () => {
    const relay = run(request(), { identity: status })
    expect((await relay.response).status).toBe(status === 401 ? 401 : 502)
    expect(relay.calls).toHaveLength(1)
    expect(relay.pairs()).toBe(0)
  })
}

test("missing cloud token is a private HTTP refusal", async () => {
  const relay = run(request(), { token: false })
  expect((await relay.response).status).toBe(503)
  expect(relay.calls).toHaveLength(2)
  expect(relay.pairs()).toBe(0)
})

test("cookie authenticates only identity; validated login obtains the upstream bearer and terminal subprotocol", async () => {
  const relay = run(request({ path: `${path}?ticket=untrusted` }))
  const response = await relay.response
  expect(response.status).toBe(101)
  expect(relay.calls).toHaveLength(3)
  expect(relay.calls[0]!.headers.get("cookie")).toBe("session=fixture")
  expect(await relay.calls[1]!.json()).toEqual({ login: "ada" })
  const dial = relay.calls[2]!
  expect(dial.url).toBe("https://cloud.test/api/repos/ada/project/workspace/sessions/sess-1/terminal")
  expect(dial.redirect).toBe("manual")
  expect(dial.headers.get("authorization")).toBe("Bearer private-fixture-token")
  expect(dial.headers.get("upgrade")).toBe("websocket")
  expect(dial.headers.get("sec-websocket-protocol")).toBe("terminal")
  for (const header of ["cookie", "origin", "x-smithers-service-token"]) expect(dial.headers.has(header)).toBe(false)
  expect(response.headers.has("sec-websocket-protocol")).toBe(false)
  expect(await response.text()).not.toContain("private-fixture-token")
  expect(relay.upstream.accepted).toBe(true)
  expect(relay.downstream.accepted).toBe(true)
  expect(relay.upstream.binaryType).toBe("arraybuffer")
  expect(relay.downstream.binaryType).toBe("arraybuffer")
})

for (const [options, status] of [
  [{ origin: "https://evil.test" }, 403],
  [{ method: "POST" }, 405],
  [{ upgrade: false }, 400],
  [{ path: path.replace("/terminal", "/lsp") }, 404],
  [{ path: path.replace("/ada/", "/a%2fb/") }, 404],
  [{ path: path.replace("/ada/", "/a%5cb/") }, 404],
  [{ path: path.replace("/ada/", "/%zz/") }, 404],
  [{ path: "/api/cloud-ws/api/admin/users" }, 404]
] as const) {
  test(`upgrade path/method/origin guard: ${JSON.stringify(options)}`, async () => {
    const relay = run(request(options))
    expect((await relay.response).status).toBe(status)
    expect(relay.calls.filter(call => call.url.startsWith("https://cloud.test"))).toEqual([])
    expect(relay.pairs()).toBe(0)
  })
}

test("binary PTY bytes and text resize frames pass unchanged in both directions", async () => {
  const relay = run()
  await relay.response
  for (const [from, to] of [[relay.downstream, relay.upstream], [relay.upstream, relay.downstream]]) {
    const binary = new Uint8Array([0, 255, 195, 10]).buffer
    const resize = JSON.stringify({ type: "resize", cols: 120, rows: 40 })
    from!.message(binary)
    from!.message(resize)
    expect(to!.sent).toEqual([binary, resize])
    expect(to!.sent[0]).toBe(binary)
    expect(typeof to!.sent[1]).toBe("string")
  }
})

for (const code of [1000, 1001, 1008, 1011, 4401, 4403, 4404, 4409, 4429]) {
  test(`upstream close ${code} and its reason reach the browser and release listeners`, async () => {
    const relay = run()
    await relay.response
    relay.upstream.ended(code, "session reason")
    expect(relay.downstream.closes).toEqual([{ code, reason: "session reason" }])
    expect(relay.upstream.closes).toEqual(relay.downstream.closes)
    expect([...relay.upstream.listeners.values()].every(listeners => listeners.size === 0)).toBe(true)
    expect([...relay.downstream.listeners.values()].every(listeners => listeners.size === 0)).toBe(true)
    relay.upstream.message("late")
    expect(relay.downstream.sent).toEqual([])
  })
}

test("browser disconnect closes upstream; abnormal upstream loss preserves reconnect behavior", async () => {
  const browserClose = run()
  await browserClose.response
  browserClose.downstream.ended(1000, "detached")
  expect(browserClose.upstream.closes).toEqual([{ code: 1000, reason: "detached" }])
  const abnormal = run()
  await abnormal.response
  abnormal.upstream.ended(1006, "")
  expect(abnormal.downstream.closes[0]!.code).toBe(1001)
})

for (const side of ["upstream", "downstream"] as const) {
  for (const binary of [true, false]) {
    test(`${side} ${binary ? "binary" : "UTF-8 text"} accepts 64 KiB and closes both ends at 64 KiB + 1`, async () => {
      const relay = run()
      await relay.response
      const to = side === "upstream" ? relay.downstream : relay.upstream
      const atCap = binary ? new ArrayBuffer(64 * 1024) : "é".repeat(32 * 1024)
      relay[side].message(atCap)
      expect(to.sent).toEqual([atCap])
      relay[side].message(binary ? new ArrayBuffer(64 * 1024 + 1) : `${atCap}x`)
      expect(to.sent).toHaveLength(1)
      expect(relay.downstream.closes[0]!.code).toBe(1009)
      expect(relay.upstream.closes[0]!.code).toBe(1009)
    })
  }
}

for (const [status, code] of [[401, 4401], [403, 4403], [404, 4404], [409, 4409], [425, 4409], [429, 4429], [503, 1011], [302, 1011]]) {
  test(`upstream HTTP ${status} becomes the native refusal ${code} with no extra recovery GET`, async () => {
    const relay = run(request(), { status })
    expect((await relay.response).status).toBe(101)
    expect(relay.calls).toHaveLength(3)
    expect(relay.downstream.closes[0]!.code).toBe(code)
    expect(relay.downstream.closes[0]!.reason).not.toContain("private-fixture-token")
  })
}

test("transport failures retry as 1011; a fresh attach can recover", async () => {
  const failed = run(request(), { offline: true })
  expect((await failed.response).status).toBe(101)
  expect(failed.downstream.closes).toEqual([{ code: 1011, reason: "failed to attach terminal" }])
  const recovered = run()
  expect((await recovered.response).status).toBe(101)
  recovered.upstream.message("ready")
  expect(recovered.downstream.sent).toEqual(["ready"])
})

for (const failure of ["error", "send"] as const) {
  test(`${failure} failure tears down both sockets once`, async () => {
    const relay = run()
    await relay.response
    if (failure === "send") {
      relay.upstream.failSend = true
      relay.downstream.message("input")
    } else relay.upstream.emit("error", new Event("error"))
    relay.downstream.emit("error", new Event("error"))
    expect(relay.downstream.closes).toEqual([{ code: 1011, reason: "cloud terminal upstream failed" }])
    expect(relay.upstream.closes).toEqual(relay.downstream.closes)
  })
}
