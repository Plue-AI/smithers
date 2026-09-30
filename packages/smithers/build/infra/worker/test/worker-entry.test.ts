import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeTestDatabase, type TestDatabase } from "./d1.ts"

const readTokenHash = createHash("sha256").update("entry-point-read-token", "utf8").digest("hex")
const writeTokenHash = createHash("sha256").update("entry-point-write-token", "utf8").digest("hex")

const bucket = (): R2Bucket =>
  ({
    head: async () => null,
    get: async () => null,
    put: async () => null
  }) as unknown as R2Bucket

/** A Rate Limiting binding that records the keys it was asked to count. */
const budget = (success = true) => {
  const keys: Array<string> = []
  const binding = {
    limit: async ({ key }: { readonly key: string }) => {
      keys.push(key)
      return { success }
    }
  }
  return { binding, keys }
}

describe("worker entry point", () => {
  let d1: TestDatabase
  let errors: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    d1 = await makeTestDatabase()
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.resetModules()
  })

  afterEach(() => {
    d1.close()
    errors.mockRestore()
  })

  const env = (overrides: Partial<Record<string, unknown>> = {}) =>
    ({
      CACHE_DATABASE: d1.database,
      CACHE_BUCKET: bucket(),
      CACHE_READ_TOKEN: readTokenHash,
      CACHE_WRITE_TOKEN: writeTokenHash,
      CACHE_REQUEST_BUDGET: budget().binding,
      CACHE_FIND_MISSING_BUDGET: budget().binding,
      CACHE_BUDGET_SCOPE: "entry-stage",
      ...overrides
    }) as never

  const load = async () => (await import("../CacheWorker.ts")).default

  it("answers 503 rather than starting on an environment it cannot verify", async () => {
    const worker = await load()

    const response = await worker.fetch(
      new Request("https://cache.test/healthz"),
      env({ CACHE_READ_TOKEN: "not-a-digest" })
    )

    expect(response.status).toBe(503)
    expect(response.headers.get("smithers-cache-contract")).toBe("result-only-v1")
    await expect(response.json()).resolves.toEqual({ error: "the cache tier failed to initialize" })
    expect(String(errors.mock.calls[0]?.[0])).toContain("name=TypeError")
  })

  it("probes D1 and R2 on a readiness check", async () => {
    const worker = await load()
    let heads = 0
    const probe = { ...bucket(), head: async () => (heads += 1, null) } as unknown as R2Bucket

    const response = await worker.fetch(
      new Request("https://cache.test/healthz"),
      env({ CACHE_BUCKET: probe })
    )

    expect(response.status).toBe(200)
    expect(heads).toBe(1)
  })

  it("refuses readiness when D1 does not return its sentinel", async () => {
    const worker = await load()
    const wrongSentinel = {
      prepare: () => ({ bind: () => ({ first: async () => null }), first: async () => ({ ok: 0 }) })
    } as unknown as D1Database

    const response = await worker.fetch(
      new Request("https://cache.test/healthz"),
      env({ CACHE_DATABASE: wrongSentinel })
    )

    expect(response.status).toBe(503)
    expect(String(errors.mock.calls[0]?.[0])).toContain("cause1.code=D1_READINESS_INVALID")
    expect(String(errors.mock.calls[0]?.[0])).toContain("operation=health")
  })

  it("identifies corrupt D1 discriminators in request logs", async () => {
    const worker = await load()
    const corrupt = {
      prepare: (sql: string) => ({
        bind: () => ({ first: async () => sql.startsWith("INSERT") ? null : { result_json: '{ "ok": true }' } })
      })
    } as unknown as D1Database
    const response = await worker.fetch(new Request("https://cache.test/ac/key", {
      method: "PUT",
      headers: { authorization: "Bearer entry-point-write-token", "content-type": "application/json" },
      body: '{"ok":true}'
    }), env({ CACHE_DATABASE: corrupt }))
    expect(response.status).toBe(503)
    expect(String(errors.mock.calls[0]?.[0])).toContain("cause1.code=D1_RESULT_NON_CANONICAL")
    expect(String(errors.mock.calls[0]?.[0])).toContain("operation=actionCache.put")
  })

  it("identifies repeated R2 publication loss in request logs", async () => {
    const worker = await load()
    const digest = createHash("sha256").update("artifact").digest("hex")
    const response = await worker.fetch(new Request(`https://cache.test/cas/${digest}`, {
      method: "PUT",
      headers: { authorization: "Bearer entry-point-write-token", "content-type": "application/octet-stream" },
      body: "artifact"
    }), env())
    expect(response.status).toBe(503)
    expect(String(errors.mock.calls[0]?.[0])).toContain("cause1.code=R2_PUBLICATION_LOST")
    expect(String(errors.mock.calls[0]?.[0])).toContain("operation=contentStore.put")
  })

  it("counts every request under the presented credential's digest and refuses a spent budget", async () => {
    const worker = await load()
    const requests = budget()
    const probes = budget(false)
    const authorized = (path: string, init: RequestInit = {}) =>
      new Request(`https://cache.test${path}`, {
        ...init,
        headers: { authorization: "Bearer entry-point-read-token", ...(init.headers as Record<string, string>) }
      })
    const environment = env({ CACHE_REQUEST_BUDGET: requests.binding, CACHE_FIND_MISSING_BUDGET: probes.binding })

    const read = await worker.fetch(authorized(`/ac/${"a".repeat(64)}`), environment)
    const probe = await worker.fetch(
      authorized("/cas/findMissing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ digests: ["b".repeat(64)] })
      }),
      environment
    )

    expect(read.status).toBe(404)
    expect(probe.status).toBe(429)
    // The key is the stage and the digest the Worker already computes to
    // classify the credential, never the bearer value itself.
    expect(requests.keys).toEqual([`entry-stage/${readTokenHash}`, `entry-stage/${readTokenHash}`])
    expect(probes.keys).toEqual([`entry-stage/${readTokenHash}`])
  })

  it("writes one metrics datapoint per request, classified by route", async () => {
    const worker = await load()
    const points: Array<AnalyticsEngineDataPoint> = []
    const metrics = { writeDataPoint: (point: AnalyticsEngineDataPoint) => points.push(point) }
    const key = "a".repeat(64)

    await worker.fetch(new Request("https://cache.test/healthz"), env({ CACHE_REQUEST_METRICS: metrics }))
    await worker.fetch(new Request(`https://cache.test/ac/${key}`), env({ CACHE_REQUEST_METRICS: metrics }))
    await worker.fetch(
      new Request("https://cache.test/cas/findMissing", { method: "POST" }),
      env({ CACHE_REQUEST_METRICS: metrics })
    )
    await worker.fetch(new Request(`https://cache.test/cas/${key}`), env({ CACHE_REQUEST_METRICS: metrics }))
    await worker.fetch(new Request("https://cache.test/elsewhere"), env({ CACHE_REQUEST_METRICS: metrics }))

    // Route classes only: a key or digest in a blob would make every row unique.
    expect(points.map(({ indexes, blobs }) => ({ indexes, blobs }))).toEqual([
      { indexes: ["healthz"], blobs: ["healthz", "GET", "200"] },
      { indexes: ["ac"], blobs: ["ac", "GET", "401"] },
      { indexes: ["findMissing"], blobs: ["findMissing", "POST", "401"] },
      { indexes: ["cas"], blobs: ["cas", "GET", "401"] },
      { indexes: ["other"], blobs: ["other", "GET", "401"] }
    ])
    for (const point of points) {
      expect(point.doubles).toHaveLength(1)
      expect(point.doubles?.[0]).toBeGreaterThanOrEqual(0)
    }
  })

  it("reports a scheduled retention backlog in metrics", async () => {
    const worker = await load()
    const retentionBatchRows = 500
    const points: Array<AnalyticsEngineDataPoint> = []
    const clock = vi.spyOn(Date, "now").mockReturnValue(0)
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      await worker.scheduled({} as ScheduledController, env({
        CACHE_REQUEST_METRICS: { writeDataPoint: (point: AnalyticsEngineDataPoint) => points.push(point) },
        CACHE_DATABASE: { prepare: () => ({ bind: () => ({ all: async () => {
          clock.mockReturnValue(60_000)
          return { results: Array.from({ length: retentionBatchRows }, () => ({ key_digest: "key" })) }
        } }) }) }
      }))
      expect(points[0]?.doubles).toEqual([60_000, retentionBatchRows, 1])
    } finally {
      clock.mockRestore()
      logs.mockRestore()
    }
  })

  it("answers 400 to an unparseable request URL and counts it under other", async () => {
    const worker = await load()
    const points: Array<AnalyticsEngineDataPoint> = []
    const metrics = { writeDataPoint: (point: AnalyticsEngineDataPoint) => points.push(point) }
    const request = { url: "not a url", method: "GET", headers: new Headers(), body: null } as unknown as Request

    const response = await worker.fetch(request, env({ CACHE_REQUEST_METRICS: metrics }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: "request URL is malformed" })
    expect(points.map(({ indexes, blobs }) => ({ indexes, blobs }))).toEqual([
      { indexes: ["other"], blobs: ["other", "GET", "400"] }
    ])
  })

  it("records the initialization failure and never fails a request on a metrics write", async () => {
    const worker = await load()
    const points: Array<AnalyticsEngineDataPoint> = []
    const recording = { writeDataPoint: (point: AnalyticsEngineDataPoint) => points.push(point) }
    const refusing = {
      writeDataPoint: () => {
        throw new Error("analytics engine unavailable")
      }
    }

    const broken = await worker.fetch(
      new Request("https://cache.test/healthz"),
      env({ CACHE_READ_TOKEN: "not-a-digest", CACHE_REQUEST_METRICS: recording })
    )
    expect(broken.status).toBe(503)
    expect(points.map(({ blobs }) => blobs)).toEqual([["healthz", "GET", "503"]])

    vi.resetModules()
    const healthy = await (await load()).fetch(
      new Request("https://cache.test/healthz"),
      env({ CACHE_REQUEST_METRICS: refusing })
    )
    expect(healthy.status).toBe(200)
  })

  it("rotates both credentials and rebinds storage and budgets in the same isolate", async () => {
    const worker = await load()
    const replacement = await makeTestDatabase()
    const request = (token: string, method = "GET") => new Request("https://cache.test/ac/key", {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(method === "PUT" ? { body: '{"ok":true}' } : {})
    })
    try {
      expect((await worker.fetch(request("entry-point-write-token", "PUT"), env())).status).toBe(201)
      const requests = budget()
      const probes = budget(false)
      let heads = 0
      const next = env({
        CACHE_READ_TOKEN: createHash("sha256").update("next-reader").digest("hex"),
        CACHE_WRITE_TOKEN: createHash("sha256").update("next-writer").digest("hex"),
        CACHE_DATABASE: replacement.database,
        CACHE_BUCKET: { ...bucket(), head: async () => (heads += 1, null) },
        CACHE_REQUEST_BUDGET: requests.binding,
        CACHE_FIND_MISSING_BUDGET: probes.binding
      })
      expect((await worker.fetch(request("entry-point-write-token", "DELETE"), next)).status).toBe(401)
      expect((await worker.fetch(request("entry-point-read-token"), next)).status).toBe(401)
      expect((await worker.fetch(request("next-writer", "PUT"), next)).status).toBe(201)
      const read = await worker.fetch(request("next-reader"), next)
      expect(read.status).toBe(200)
      await read.text()
      expect((await worker.fetch(new Request("https://cache.test/healthz"), next)).status).toBe(200)
      expect(heads).toBe(1)
      expect(requests.keys).toHaveLength(2)
      expect((await worker.fetch(new Request("https://cache.test/cas/findMissing", {
        method: "POST", headers: { authorization: "Bearer next-reader" }
      }), next)).status).toBe(429)
      expect(probes.keys).toHaveLength(1)
      expect(d1.sqlite.prepare("SELECT COUNT(*) AS count FROM smithers_build_cache_entry").get()?.count).toBe(1)
    } finally {
      replacement.close()
    }
  })

  it("preserves streaming admission across binding rotations and returns each permit once", async () => {
    const worker = await load()
    const digest = createHash("sha256").update("artifact").digest("hex")
    const sources: Array<ReadableStreamDefaultController<Uint8Array>> = []
    const makeEnv = () => env({ CACHE_BUCKET: { ...bucket(), get: async () => ({
      key: digest, size: 8, checksums: { sha256: Uint8Array.from(Buffer.from(digest, "hex")).buffer },
      body: new ReadableStream<Uint8Array>({ start(controller) { sources.push(controller) } })
    }) } })
    const get = () => worker.fetch(new Request(`https://cache.test/cas/${digest}`, {
      headers: { authorization: "Bearer entry-point-read-token" }
    }), makeEnv())
    const first = await get()
    const second = await get()
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect((await get()).status).toBe(429)
    sources[0]!.error(new Error("download failed"))
    await expect(first.arrayBuffer()).rejects.toThrow()
    const third = await get()
    expect(third.status).toBe(200)
    expect((await get()).status).toBe(429)
    await second.body!.cancel()
    await second.body!.cancel()
    const fourth = await get()
    expect(fourth.status).toBe(200)
    expect((await get()).status).toBe(429)
    await third.body!.cancel()
    await fourth.body!.cancel()
  })

  it.each(["complete", "failed", "cancelled", "cancelled_during_read"])("records terminal stream %s after headers and releases admission", async (outcome) => {
    const worker = await load()
    const points: Array<AnalyticsEngineDataPoint> = []
    const digest = createHash("sha256").update("artifact").digest("hex")
    let source!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller } })
    const environment = env({
      CACHE_REQUEST_METRICS: { writeDataPoint: (point: AnalyticsEngineDataPoint) => points.push(point) },
      CACHE_BUCKET: { ...bucket(), get: async () => ({
        key: digest, size: 8, checksums: { sha256: Uint8Array.from(Buffer.from(digest, "hex")).buffer }, body
      }) }
    })
    const response = await worker.fetch(new Request(`https://cache.test/cas/${digest}`, {
      headers: { authorization: "Bearer entry-point-read-token" }
    }), environment)
    expect(response.status).toBe(200)
    expect(points.map((point) => point.blobs)).toEqual([["cas", "GET", "200"]])
    await new Promise((resolve) => setTimeout(resolve, 25))
    if (outcome === "failed") {
      source.error(new Error("private provider payload"))
      await expect(response.arrayBuffer()).rejects.toThrow()
      expect(errors).toHaveBeenCalledTimes(1)
      expect(String(errors.mock.calls[0]?.[0])).toContain("code=STREAM_READ_FAILED")
      expect(String(errors.mock.calls[0]?.[0])).toContain("operation=contentStore.get")
      expect(String(errors.mock.calls[0]?.[0])).not.toContain("private provider payload")
    } else if (outcome === "cancelled_during_read") {
      const reader = response.body!.getReader()
      const pending = reader.read()
      await Promise.resolve()
      await reader.cancel()
      await pending
      expect(errors).not.toHaveBeenCalled()
    } else if (outcome === "cancelled") {
      await response.body!.cancel()
      expect(errors).not.toHaveBeenCalled()
    } else {
      source.enqueue(new TextEncoder().encode("artifact"))
      source.close()
      expect(await response.text()).toBe("artifact")
    }
    expect(points.map((point) => point.blobs)).toEqual([
      ["cas", "GET", "200"], ["cas", "GET", `stream_${outcome === "cancelled_during_read" ? "cancelled" : outcome}`]
    ])
    expect(points[1]?.doubles?.[0]).toBeGreaterThanOrEqual(20)
  })
})
