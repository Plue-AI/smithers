import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as Effect from "effect/Effect"
import { CLIENT_ERRORS_PATH, createClientErrorReporter } from "./ClientErrors"
import { runRequest } from "smithers-server/Boundary"
import { ClientErrorLog } from "smithers-server/clientErrorLog"
import { memoryStorage } from "smithers-server/DurableStorage"
import type { NativeNamespace } from "smithers-server/DurableStorage"
import { ExecutionContext, executionContextFrom, layersFromEnv } from "smithers-server/Environment"
import type { WorkerEnv } from "smithers-server/Environment"
import { Transport, transportFrom } from "smithers-server/Http"
import { handleRequest } from "smithers-server/index"

const TOKEN = "synthetic-worker-telemetry-token"
let log = spyOn(console, "error")
log.mockRestore()
beforeEach(() => { log = spyOn(console, "error").mockImplementation(() => {}) })
afterEach(() => { log.mockRestore() })

/** Real router, admission and DO storage; every outbound request stays in this double. */
const fixture = (options: {
  readonly env?: Partial<WorkerEnv>
  readonly backend?: (request: Request) => Response | Promise<Response>
} = {}) => {
  const storage = memoryStorage()
  const object = new ClientErrorLog({ storage })
  const namespace: NativeNamespace = { idFromName: name => name, get: () => object }
  const forbidden: NativeNamespace = {
    idFromName: name => name,
    get: () => ({ fetch: async () => { throw new Error("unexpected non-telemetry DO call") } })
  }
  const env: WorkerEnv = {
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    TURN_CANCELS: forbidden,
    CLIENT_ERRORS: namespace,
    SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test/prefix",
    PLUE_WORKER_EXCHANGE_TOKEN: TOKEN,
    SMITHERS_BUILD_SHA: "test-build",
    ...options.env
  }
  const requests: Request[] = []
  const exports: Promise<unknown>[] = []
  let webCounter = 0
  const transport = transportFrom(async (input, init) => {
    const request = new Request(input, init)
    requests.push(request)
    if (options.backend !== undefined) return options.backend(request)
    // Mirrors PostClientError's canonical envelope and authenticated Worker
    // quota contract. The real Go router/counter is tested in Plue separately.
    expect(request.url).toBe("https://cloud.test/api/telemetry/errors")
    expect(request.method).toBe("POST")
    expect(request.redirect).toBe("manual")
    expect(Object.fromEntries(request.headers)).toEqual({ authorization: `Bearer ${TOKEN}`, "content-type": "application/json" })
    expect(await request.clone().json()).toEqual({ client: "web", version: "test-build", error: { type: "Error" } })
    webCounter += 1
    return new Response(null, { status: 204 })
  })
  const layers = layersFromEnv(env)
  const call = (request: Request) => runRequest(handleRequest(request).pipe(
    Effect.provideService(Transport, transport),
    Effect.provideService(ExecutionContext, executionContextFrom({ waitUntil: work => { exports.push(work) } })),
    Effect.provide(layers)
  ), request.signal)
  const post = (body = "{}", headers: Record<string, string> = {}) => call(new Request(`https://app.test${CLIENT_ERRORS_PATH}`, {
    method: "POST", headers: { origin: "https://app.test", "cf-connecting-ip": "192.0.2.1", ...headers }, body
  }))
  return { call, post, requests, exports, storage, object, webCounter: () => webCounter, drain: () => Promise.all(exports) }
}

const telemetryDiagnostics = () => log.mock.calls.filter(call => String(call[0]).startsWith("client-error telemetry"))

describe("browser reporter → Worker → backend telemetry contract", () => {
  test("the real reporter increments the backend web counter without exporting browser content or credentials", async () => {
    const f = fixture()
    const accepted: Promise<Response>[] = []
    const reporter = createClientErrorReporter({
      pathname: () => "/private/repository",
      now: () => new Date("2026-09-21T12:00:00Z"),
      fetchImpl: (input, init) => {
        const headers = new Headers(init?.headers)
        headers.set("cookie", "smithers_session=private-session")
        headers.set("authorization", "Bearer browser-secret")
        headers.set("cf-connecting-ip", "192.0.2.2")
        headers.set("referer", "https://app.test/private/repository?secret=page-value")
        const pending = f.call(new Request(new URL(String(input), "https://app.test"), { ...init, headers }))
        accepted.push(pending)
        return pending
      }
    })
    reporter.report("error", new TypeError("private stack content"))
    await accepted[0]
    reporter.report("unhandledrejection", "private rejection content")
    expect(reporter.reported()).toBe(2)
    expect((await Promise.all(accepted)).map(response => response.status)).toEqual([202, 202])
    await f.drain()
    expect(f.webCounter()).toBe(2)
    const ring = await (await f.object.fetch(new Request("https://internal/read"))).text()
    expect(ring).toContain("private stack content")
    expect(ring).toContain("private rejection content")
    for (const request of f.requests) {
      const raw = await request.clone().text()
      expect(new TextEncoder().encode(raw).byteLength).toBeLessThan(1024)
      for (const privateValue of ["private", "browser-secret", "private-session", "192.0.2.2", "page-value", "TypeError"]) {
        expect(raw).not.toContain(privateValue)
      }
    }
    expect(telemetryDiagnostics()).toEqual([])
  })

  test("acceptance returns while export is unresolved, and waitUntil owns its completion", async () => {
    let release: (response: Response) => void = () => {}
    let completed = false
    const gate = new Promise<Response>(resolve => { release = resolve })
    const f = fixture({ backend: () => gate })
    expect((await f.post()).status).toBe(202)
    expect(f.exports).toHaveLength(1)
    const finish = f.drain().then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    // Another ordinary request remains answerable while the export waits.
    expect((await f.call(new Request("https://app.test/api/not-a-route"))).status).toBe(404)
    release(new Response(null, { status: 204 }))
    await finish
    expect(completed).toBe(true)
  })

  test("the Durable Object source and deployment limits bound export attempts too", async () => {
    const own = fixture()
    for (let index = 0; index < 21; index += 1) expect((await own.post()).status).toBe(index < 20 ? 202 : 429)
    await own.drain()
    expect(own.requests).toHaveLength(20)
    const shared = fixture()
    for (let index = 0; index < 121; index += 1) {
      expect((await shared.post("{}", { "cf-connecting-ip": `192.0.2.${Math.floor(index / 20) + 1}` })).status).toBe(index < 120 ? 202 : 429)
    }
    await shared.drain()
    expect(shared.requests).toHaveLength(120)
  })

  test("rejected bodies and cross-origin requests never reach either telemetry sink", async () => {
    const f = fixture()
    expect((await f.post("x".repeat(16 * 1024 + 1))).status).toBe(413)
    expect((await f.post("{}", { origin: "https://elsewhere.test" })).status).toBe(403)
    expect((await f.call(new Request(`https://app.test${CLIENT_ERRORS_PATH}`))).status).toBe(404)
    expect(f.storage.data.size).toBe(0)
    expect(f.requests).toHaveLength(0)
    expect(f.exports).toHaveLength(0)
  })

  test("an unavailable throttle or unconfigured Cloud API cannot create unbounded or default-host egress", async () => {
    const failed: NativeNamespace = { idFromName: name => name, get: () => ({ fetch: async () => new Response(null, { status: 500 }) }) }
    for (const [env, reason] of [
      [{ CLIENT_ERRORS: undefined }, "unbound"],
      [{ CLIENT_ERRORS: failed }, "failed"],
      [{ SMITHERS_CLOUD_API_BASE_URL: undefined }, "unconfigured"],
      [{ PLUE_WORKER_EXCHANGE_TOKEN: undefined }, "unconfigured"],
      [{ PLUE_WORKER_EXCHANGE_TOKEN: "  " }, "unconfigured"]
    ] as const) {
      log.mockClear()
      const f = fixture({ env })
      expect((await f.post()).status).toBe(202)
      await f.drain()
      expect(f.requests).toHaveLength(0)
      expect(telemetryDiagnostics()).toEqual([["client-error telemetry skipped:", reason]])
      if (reason === "unconfigured") expect(f.storage.data.size).toBeGreaterThan(0)
    }
  })

  test("invalid Cloud origins never receive the worker bearer", async () => {
    for (const origin of ["http://cloud.test", "https://user:password@cloud.test", "not a URL"]) {
      log.mockClear()
      const f = fixture({ env: { SMITHERS_CLOUD_API_BASE_URL: origin } })
      expect((await f.post()).status).toBe(202)
      await f.drain()
      expect(f.requests).toHaveLength(0)
      expect(telemetryDiagnostics()).toHaveLength(1)
      expect(JSON.stringify(telemetryDiagnostics())).not.toContain(TOKEN)
    }
  })

  test("backend refusals remain observable without disclosing their bodies or retrying", async () => {
    for (const status of [200, 302, 403, 429, 500]) {
      log.mockClear()
      let cancelled = false
      const f = fixture({ backend: () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(`private echo ${TOKEN}`)) },
        cancel() { cancelled = true }
      }), { status, headers: { location: "https://elsewhere.test" } }) })
      expect((await f.post()).status).toBe(202)
      await f.drain()
      expect(f.requests).toHaveLength(1)
      expect(cancelled).toBe(true)
      expect(telemetryDiagnostics()).toEqual([["client-error telemetry failed:", { status }]])
    }
  })

  test("transport failures and deadlines settle background work with a bounded diagnostic", async () => {
    const failed = fixture({ backend: () => { throw new Error(`private echo ${TOKEN}`) } })
    expect((await failed.post()).status).toBe(202)
    await failed.drain()
    expect(telemetryDiagnostics()).toEqual([["client-error telemetry failed:", { reason: "UpstreamUnreachable" }]])
    log.mockClear()
    let aborted = false
    const silent = fixture({ env: { UPSTREAM_TIMEOUT_MS: "10" }, backend: request => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")) }, { once: true })
    }) })
    expect((await silent.post()).status).toBe(202)
    await silent.drain()
    expect(aborted).toBe(true)
    expect(telemetryDiagnostics()).toEqual([["client-error telemetry failed:", { reason: "UpstreamTimeout" }]])
  })
})
