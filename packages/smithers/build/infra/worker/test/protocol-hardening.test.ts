import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import {
  type ActionCache,
  canonicalJson,
  type ContentStore,
  createHandler,
  describeFailure,
  invalidKeyDigest,
  maxActionCacheBodyBytes,
  maxActionCacheRowBytes,
  maxD1RowBytes,
  maxFindMissingBodyBytes,
  maxBodyChunks,
  maxCanonicalJsonBytes,
  maxConcurrentActionCachePublications,
  maxConcurrentArtifactTransfers,
  maxConcurrentCacheRequests,
  maxConcurrentFindMissingRequests,
  maxFindMissingDigests,
  maxJsonDepth,
  maxJsonMembers,
  maxKeyDigestLength,
  maxRecordedRunIdLength,
  maxReferencedDigests
} from "../protocol.ts"
import { CacheFailure } from "../cache-failure.ts"
import { MemoryActionCache, MemoryContentStore } from "./MemoryStores.ts"

const token = "test-token-with-sufficient-entropy-for-unit-tests"
/** These cases exercise hardening, not the credential split, so `token` publishes. */
const writeTokenHash = createHash("sha256").update(token, "utf8").digest("hex")
const readTokenHash = createHash("sha256").update("a-reader-that-never-publishes", "utf8").digest("hex")
const keyDigest = "a".repeat(64)
const textEncoder = new TextEncoder()

interface HandlerOverrides {
  readonly actionCache?: ActionCache
  readonly contentStore?: ContentStore
  readonly health?: () => Promise<void>
  readonly maxArtifactBytes?: number
  readonly readTokenHash?: string
  readonly writeTokenHash?: string
}

const makeHandler = (overrides: HandlerOverrides = {}) =>
  createHandler({
    actionCache: overrides.actionCache ?? new MemoryActionCache(),
    contentStore: overrides.contentStore ?? new MemoryContentStore(),
    readTokenHash: overrides.readTokenHash ?? readTokenHash,
    writeTokenHash: overrides.writeTokenHash ?? writeTokenHash,
    ...(overrides.health === undefined ? {} : { health: overrides.health }),
    ...(overrides.maxArtifactBytes === undefined
      ? {}
      : { maxArtifactBytes: overrides.maxArtifactBytes })
  })

const request = (path: string, init: RequestInit = {}): Request => {
  const headers = new Headers(init.headers)
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`)
  return new Request(`https://cache.test${path}`, { ...init, headers })
}

const jsonRequest = (path: string, body: unknown, init: RequestInit = {}): Request =>
  request(path, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  })

interface InstrumentedOptions {
  readonly chunks?: ReadonlyArray<unknown>
  readonly failCancel?: boolean
  readonly failRead?: boolean
  readonly failRelease?: boolean
}

const instrumentedBody = (options: InstrumentedOptions = {}) => {
  const log: Array<string> = []
  const chunks = options.chunks ?? []
  let index = 0
  const body = {
    async cancel(): Promise<void> {
      log.push("body-cancel")
      if (options.failCancel === true) throw new Error("sender disappeared")
    },
    getReader() {
      log.push("get-reader")
      return {
        async read(): Promise<{ readonly done: boolean; readonly value: unknown }> {
          if (options.failRead === true) {
            log.push("read-failed")
            throw Object.assign(new Error("secret request text"), { code: "ECONNRESET" })
          }
          if (index >= chunks.length) return { done: true, value: undefined }
          const value = chunks[index]
          index += 1
          return { done: false, value }
        },
        async cancel(): Promise<void> {
          log.push("reader-cancel")
          if (options.failCancel === true) throw new Error("sender disappeared")
        },
        releaseLock(): void {
          log.push("release")
          if (options.failRelease === true) throw new Error("reader wedged")
        }
      }
    }
  }
  return { body, log }
}

const rawRequest = (
  path: string,
  options: {
    readonly body?: unknown
    readonly headers?: HeadersInit
    readonly method?: string
  } = {}
): Request =>
  ({
    url: `https://cache.test${path}`,
    method: options.method ?? "GET",
    headers: new Headers({ authorization: `Bearer ${token}`, ...options.headers }),
    body: options.body ?? null
  }) as Request

const digestOf = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

describe("remote-cache hardening", () => {
  it("fails construction on invalid security and allocation settings", () => {
    expect(() => makeHandler({ readTokenHash: "not-a-digest" })).toThrow("readTokenHash")
    expect(() => makeHandler({ writeTokenHash: "not-a-digest" })).toThrow("writeTokenHash")
    expect(() => makeHandler({ maxArtifactBytes: 0 })).toThrow("maxArtifactBytes")
    expect(() => makeHandler({ maxArtifactBytes: Number.MAX_SAFE_INTEGER })).toThrow("maxArtifactBytes")
  })

  it("keeps readiness public, bodyless for HEAD, method-limited, and coalesced", async () => {
    let healthCalls = 0
    let releaseHealth: (() => void) | undefined
    const healthGate = new Promise<void>((resolve) => {
      releaseHealth = resolve
    })
    const handler = makeHandler({
      health: async () => {
        healthCalls += 1
        await healthGate
      }
    })
    const first = handler(new Request("https://cache.test/healthz"))
    const second = handler(new Request("https://cache.test/healthz", { method: "HEAD" }))
    await vi.waitFor(() => expect(healthCalls).toBe(1))
    releaseHealth?.()

    expect((await first).status).toBe(200)
    const head = await second
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
    expect((await handler(new Request("https://cache.test/healthz"))).status).toBe(200)
    expect(healthCalls).toBe(1)
    const refused = await handler(new Request("https://cache.test/healthz", { method: "POST" }))
    expect(refused.status).toBe(405)
    expect(refused.headers.get("allow")).toBe("GET, HEAD")
  })

  it("accepts RFC case-insensitive bearer syntax and cancels unauthorized bodies", async () => {
    const handler = makeHandler()
    const lower = await handler(
      new Request(`https://cache.test/ac/${keyDigest}`, {
        headers: { authorization: `bearer   ${token}` }
      })
    )
    expect(lower.status).toBe(404)

    const refusedBody = instrumentedBody()
    const refused = await handler(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { authorization: "Bearer wrong", "content-type": "application/json" },
        body: refusedBody.body
      })
    )
    expect(refused.status).toBe(401)
    expect(refused.headers.get("www-authenticate")).toBe("Bearer realm=\"smithers-build-cache\"")
    expect(refusedBody.log).toEqual(["body-cancel"])
  })

  it("does not let a non-settling cancellation hold an admission slot", async () => {
    const body = {
      cancel: () => new Promise<void>(() => undefined)
    }
    const response = await makeHandler()(
      rawRequest(`/ac/${keyDigest}`, {
        headers: { authorization: "Bearer wrong" },
        body
      })
    )
    expect(response.status).toBe(401)
  })

  it("rejects malformed, oversized, and control-bearing action keys", async () => {
    const handler = makeHandler()
    const oversized = encodeURIComponent("é".repeat(maxKeyDigestLength))

    expect((await handler(request("/ac/%"))).status).toBe(400)
    expect((await handler(request("/ac/%00"))).status).toBe(400)
    expect((await handler(request(`/ac/${oversized}`))).status).toBe(400)
    expect((await handler(request("/ac/normal:key/extra"))).status).toBe(404)
  })

  it("names every action-key fault directly", () => {
    const tooLong = `key-${"a".repeat(maxKeyDigestLength)}`
    const multiByteTooLong = "é".repeat(Math.floor(maxKeyDigestLength / 2) + 1)
    expect(multiByteTooLong.length).toBeLessThanOrEqual(maxKeyDigestLength)
    expect(textEncoder.encode(multiByteTooLong).byteLength).toBeGreaterThan(maxKeyDigestLength)

    expect(invalidKeyDigest("")).toBe("empty keyDigest")
    expect(invalidKeyDigest("\uD800")).toBe("keyDigest must be well-formed Unicode text")
    expect(invalidKeyDigest("valid\uD800")).toBe("keyDigest must be well-formed Unicode text")
    expect(invalidKeyDigest(tooLong)).toBe(`keyDigest must be at most ${maxKeyDigestLength} UTF-8 bytes`)
    expect(invalidKeyDigest(multiByteTooLong)).toBe(
      `keyDigest must be at most ${maxKeyDigestLength} UTF-8 bytes`
    )
    expect(invalidKeyDigest("key\u0000digest")).toBe("keyDigest must not contain control characters")
    expect(invalidKeyDigest("normal:key")).toBeNull()
  })

  it("exposes the URL boundary around lone surrogates", async () => {
    const handler = makeHandler()
    const encoded = await handler(request("/ac/%ED%A0%80"))
    expect(encoded.status).toBe(400)
    await expect(encoded.json()).resolves.toEqual({ error: "keyDigest must be valid URL encoding" })

    const normalized = request("/ac/\uD800")
    expect(new URL(normalized.url).pathname).toBe("/ac/%EF%BF%BD")
    expect((await handler(normalized)).status).toBe(404)
  })

  it("requires strict, paired publication provenance", async () => {
    const actionCache = new MemoryActionCache()
    const handler = makeHandler({ actionCache })
    const base = { keyDigest, result: { exitOk: true } }
    const cases = [
      { ...base, createdAtMs: -1 },
      { ...base, createdAtMs: 1.5 },
      { ...base, recordedRunId: "run" },
      { ...base, recordedEventSeq: 1 },
      { ...base, recordedRunId: "", recordedEventSeq: 1 },
      { ...base, recordedRunId: "bad\u0000run", recordedEventSeq: 1 },
      { ...base, recordedRunId: "\ud800", recordedEventSeq: 1 },
      { ...base, recordedRunId: "r", recordedEventSeq: -1 }
    ]
    for (const body of cases) {
      const response = await handler(jsonRequest(`/ac/${keyDigest}`, body, { method: "PUT" }))
      expect(response.status).toBe(400)
    }
    expect(actionCache.entries.size).toBe(0)
  })

  it("does not reinterpret a bare document merely because it has a result member", async () => {
    const handler = makeHandler()
    const first = { result: { same: true }, metadata: "one" }
    const second = { result: { same: true }, metadata: "two" }

    expect((await handler(jsonRequest(`/ac/${keyDigest}`, first, { method: "PUT" }))).status).toBe(201)
    expect((await handler(jsonRequest(`/ac/${keyDigest}`, second, { method: "PUT" }))).status).toBe(409)
  })

  it("validates declared artifact metadata and stores accepted bytes verbatim", async () => {
    const actionCache = new MemoryActionCache()
    const handler = makeHandler({ actionCache })
    const malformed = JSON.stringify({
      keyDigest,
      result: { exitOk: true },
      meta: { boundary: { declaredOutputs: { outputs: [{ digest: "not-a-digest" }] } } }
    })
    const refused = await handler(request(`/ac/${keyDigest}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: malformed
    }))

    expect(refused.status).toBe(400)
    await expect(refused.json()).resolves.toEqual({ error: "body contains invalid or unsupported cache metadata" })
    expect(actionCache.entries.size).toBe(0)

    const body = JSON.stringify({
      keyDigest,
      result: { exitOk: true },
      meta: {
        boundary: {
          declaredOutputs: { outputs: [{ digest: "b".repeat(64) }, { digest: "c".repeat(64) }] }
        }
      }
    })

    const stored = await handler(request(`/ac/${keyDigest}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body
    }))
    const fetched = await handler(request(`/ac/${keyDigest}`))

    expect(stored.status).toBe(201)
    expect(actionCache.entries.get(keyDigest)?.body).toBe(body)
    expect(await fetched.text()).toBe(body)
  })

  it("rejects malformed or excessive declared artifact references", async () => {
    const actionCache = new MemoryActionCache()
    const handler = makeHandler({ actionCache })
    const tooMany = Array.from({ length: maxReferencedDigests + 1 }, (_, index) => ({
      digest: index.toString(16).padStart(64, "0")
    }))

    for (const outputs of ["not-an-array", [null], tooMany]) {
      const response = await handler(jsonRequest(`/ac/${keyDigest}`, {
        keyDigest,
        result: { exitOk: true },
        meta: { boundary: { declaredOutputs: { outputs } } }
      }, { method: "PUT" }))

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        error: "body contains invalid or unsupported cache metadata"
      })
    }
    expect(actionCache.entries.size).toBe(0)
  })

  it("rejects lossy or structurally hostile canonical JSON", () => {
    expect(() => canonicalJson(-0)).toThrow()
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow()
    // A cycle cannot reach this function from a parser, and the depth bound is
    // what stops one anyway: rendering recurses until a bound refuses it,
    // never forever.
    const cycle: Array<unknown> = []
    cycle.push(cycle)
    expect(() => canonicalJson(cycle)).toThrow("JSON is nested too deeply")
    expect(() => canonicalJson("x".repeat(maxCanonicalJsonBytes + 1))).toThrow("byte bound")
    let deep: unknown = null
    for (let index = 0; index <= maxJsonDepth; index += 1) deep = [deep]
    expect(() => canonicalJson(deep)).toThrow("deeply")
  })

  it("returns 400 rather than overflowing on an excessively deep JSON body", async () => {
    const handler = makeHandler()
    const body = `${"[".repeat(10_000)}null${"]".repeat(10_000)}`
    const response = await handler(jsonRequest(`/ac/${keyDigest}`, body, { method: "PUT" }))
    expect(response.status).toBe(400)
  })

  it("enforces content-length exactly and cleans up every refused reader", async () => {
    const handler = makeHandler()
    const malformed = instrumentedBody()
    const malformedResponse = await handler(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-length": "1.5", "content-type": "application/json" },
        body: malformed.body
      })
    )
    expect(malformedResponse.status).toBe(400)
    expect(malformed.log).toEqual(["body-cancel"])

    const mismatch = instrumentedBody({ chunks: [textEncoder.encode("{}")] })
    const mismatchResponse = await handler(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-length": "1", "content-type": "application/json" },
        body: mismatch.body
      })
    )
    expect(mismatchResponse.status).toBe(400)
    expect(mismatch.log).toEqual(["get-reader", "reader-cancel", "release"])
  })

  it("bounds empty chunks and rejects a non-byte stream", async () => {
    const handler = makeHandler()
    const emptyChunks = instrumentedBody({
      chunks: Array.from({ length: maxBodyChunks + 1 }, () => new Uint8Array())
    })
    const chunksResponse = await handler(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: emptyChunks.body
      })
    )
    expect(chunksResponse.status).toBe(413)
    expect(emptyChunks.log.at(-2)).toBe("reader-cancel")
    expect(emptyChunks.log.at(-1)).toBe("release")

    const wrongType = instrumentedBody({ chunks: ["not bytes"] })
    const typeResponse = await handler(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: wrongType.body
      })
    )
    expect(typeResponse.status).toBe(400)
    expect(wrongType.log).toEqual(["get-reader", "reader-cancel", "release"])
  })

  it("applies deletion fences to legacy rows strictly and rejects duplicates", async () => {
    const actionCache = new MemoryActionCache()
    const handler = makeHandler({ actionCache })
    const body = {
      keyDigest,
      result: { exitOk: true },
      recordedRunId: "run-1",
      recordedEventSeq: 7
    }
    // Seed a row retained from before the hosted protocol refused provenance.
    await expect(actionCache.put(keyDigest, {
      body: JSON.stringify(body),
      resultJson: JSON.stringify(body.result),
      createdAtMs: null,
      recordedRunId: body.recordedRunId,
      recordedEventSeq: body.recordedEventSeq
    })).resolves.toBe("inserted")
    expect(
      (
        await handler(
          request(`/ac/${keyDigest}?recordedRunId=run-1&recordedRunId=run-1&recordedEventSeq=7`, {
            method: "DELETE"
          })
        )
      ).status
    ).toBe(400)
    expect(
      (
        await handler(
          request(`/ac/${keyDigest}?recordedRunId=run-1&recordedEventSeq=7x`, { method: "DELETE" })
        )
      ).status
    ).toBe(400)
    expect(
      (
        await handler(
          request(`/ac/${keyDigest}?recordedRunId=run-1&recordedEventSeq=7`, { method: "DELETE" })
        )
      ).status
    ).toBe(200)
  })

  it("names allowed methods on every protocol route", async () => {
    const handler = makeHandler()
    const action = await handler(request(`/ac/${keyDigest}`, { method: "PATCH" }))
    const artifact = await handler(request(`/cas/${"b".repeat(64)}`, { method: "PATCH" }))
    const missing = await handler(request("/cas/findMissing", { method: "GET" }))

    expect(action.status).toBe(405)
    expect(action.headers.get("allow")).toBe("GET, PUT, DELETE")
    expect(artifact.status).toBe(405)
    expect(artifact.headers.get("allow")).toBe("GET, HEAD, PUT")
    expect(missing.status).toBe(405)
    expect(missing.headers.get("allow")).toBe("POST")
  })

  it("enforces the configured CAS bound and verifies the address", async () => {
    const handler = makeHandler({ maxArtifactBytes: 4 })
    const exact = textEncoder.encode("four")
    const tooLarge = textEncoder.encode("five!")
    const exactDigest = digestOf("four")

    const inserted = await handler(
      request(`/cas/${exactDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: exact
      })
    )
    const oversized = await handler(
      request(`/cas/${digestOf("five!")}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: tooLarge
      })
    )
    const mismatch = await handler(
      request(`/cas/${"0".repeat(64)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: exact
      })
    )
    expect(inserted.status).toBe(201)
    expect(oversized.status).toBe(413)
    expect(mismatch.status).toBe(400)
  })

  it("bounds findMissing before storage and preserves first-occurrence order", async () => {
    const contentStore = new MemoryContentStore()
    const present = digestOf("present")
    const missing = digestOf("missing")
    await contentStore.put(present, new Uint8Array(textEncoder.encode("present")))
    const handler = makeHandler({ contentStore })

    const empty = await handler(jsonRequest("/cas/findMissing", { digests: [] }, { method: "POST" }))
    expect(await empty.json()).toEqual({ missing: [] })
    expect(contentStore.presentCalls).toBe(0)

    const response = await handler(
      jsonRequest("/cas/findMissing", { digests: [present, missing, present] }, { method: "POST" })
    )
    expect(await response.json()).toEqual({ missing: [missing] })

    const tooMany = Array.from({ length: maxFindMissingDigests + 1 }, () => missing)
    const refused = await handler(
      jsonRequest("/cas/findMissing", { digests: tooMany }, { method: "POST" })
    )
    expect(refused.status).toBe(413)
    expect(contentStore.presentCalls).toBe(1)

    const ambiguous = await handler(
      jsonRequest("/cas/findMissing", { digests: [], ignored: true }, { method: "POST" })
    )
    expect(ambiguous.status).toBe(400)
  })

  it("turns malformed storage answers into retryable refusals", async () => {
    const invalidActionCache = {
      get: async () => "not-json",
      put: async () => "unexpected",
      delete: async () => "yes"
    } as unknown as ActionCache
    const invalidContentStore = {
      get: async () => ({
        get body() {
          throw new Error("must not invoke body getter")
        }
      }),
      has: async () => "yes",
      put: async () => "unexpected",
      presentDigests: async () => ({ has: () => true })
    } as unknown as ContentStore
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const actionHandler = makeHandler({ actionCache: invalidActionCache })
      expect((await actionHandler(request(`/ac/${keyDigest}`))).status).toBe(503)
      expect((await actionHandler(jsonRequest(`/ac/${keyDigest}`, { ok: true }, { method: "PUT" }))).status)
        .toBe(503)
      expect((await actionHandler(request(`/ac/${keyDigest}`, { method: "DELETE" }))).status).toBe(503)

      const contentHandler = makeHandler({ contentStore: invalidContentStore })
      const digest = "b".repeat(64)
      expect((await contentHandler(request(`/cas/${digest}`))).status).toBe(503)
      expect((await contentHandler(request(`/cas/${digest}`, { method: "HEAD" }))).status).toBe(503)
      expect((await contentHandler(jsonRequest("/cas/findMissing", { digests: [digest] }, { method: "POST" }))).status)
        .toBe(503)
    } finally {
      errors.mockRestore()
    }
  })

  it("snapshots dependencies and rejects dependency accessors without invoking them", async () => {
    const actionCache = new MemoryActionCache()
    const dependencies: {
      actionCache: ActionCache
      contentStore: ContentStore
      readTokenHash: string
      writeTokenHash: string
    } = {
      actionCache,
      contentStore: new MemoryContentStore(),
      readTokenHash,
      writeTokenHash
    }
    const handler = createHandler(dependencies)
    dependencies.actionCache = {
      get: async () => "corrupt",
      put: async () => "conflict",
      delete: async () => false
    }
    expect((await handler(request(`/ac/${keyDigest}`))).status).toBe(404)

    let reads = 0
    const accessor = Object.defineProperty(
      {
        actionCache,
        contentStore: new MemoryContentStore(),
        readTokenHash
      },
      "writeTokenHash",
      {
        enumerable: true,
        get: () => {
          reads += 1
          return writeTokenHash
        }
      }
    )
    expect(() => createHandler(accessor as never)).toThrow(/data property/)
    expect(reads).toBe(0)
  })

  it("admits no more than the configured number of simultaneous requests", async () => {
    const handler = makeHandler()
    const admitted = Array.from({ length: maxConcurrentCacheRequests }, () => handler(request(`/ac/${keyDigest}`)))
    const overflow = await handler(request(`/ac/${keyDigest}`))

    expect(overflow.status).toBe(429)
    expect(overflow.headers.get("retry-after")).toBe("1")
    await Promise.all(admitted)
  })

  it("bounds large artifact transfers independently of total requests", async () => {
    let entered = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const contentStore = new MemoryContentStore()
    const blockingStore: ContentStore = {
      get: async () => {
        entered += 1
        await gate
        return null
      },
      has: (digest) => contentStore.has(digest),
      put: (digest, bytes) => contentStore.put(digest, bytes),
      presentDigests: (digests) => contentStore.presentDigests(digests)
    }
    const handler = makeHandler({ contentStore: blockingStore })
    const digest = "b".repeat(64)
    const admitted = Array.from({ length: maxConcurrentArtifactTransfers }, () => handler(request(`/cas/${digest}`)))
    await vi.waitFor(() => expect(entered).toBe(maxConcurrentArtifactTransfers))

    const overflow = await handler(request(`/cas/${digest}`))
    expect(overflow.status).toBe(429)
    release?.()
    await Promise.all(admitted)
  })

  it("bounds memory-heavy action-cache publications independently of reads", async () => {
    let entered = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const memory = new MemoryActionCache()
    const actionCache: ActionCache = {
      get: (key) => memory.get(key),
      delete: (key, fence) => memory.delete(key, fence),
      put: async (key, publication) => {
        entered += 1
        await gate
        return memory.put(key, publication)
      }
    }
    const handler = makeHandler({ actionCache })
    const body = { keyDigest, result: { exitOk: true } }
    const admitted = Array.from(
      { length: maxConcurrentActionCachePublications },
      () => handler(jsonRequest(`/ac/${keyDigest}`, body, { method: "PUT" }))
    )
    await vi.waitFor(() => expect(entered).toBe(maxConcurrentActionCachePublications))

    const overflow = await handler(jsonRequest(`/ac/${keyDigest}`, body, { method: "PUT" }))
    expect(overflow.status).toBe(429)
    release?.()
    await Promise.all(admitted)
  })

  it("bounds simultaneous findMissing materialization", async () => {
    let entered = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const memory = new MemoryContentStore()
    const contentStore: ContentStore = {
      get: (digest) => memory.get(digest),
      has: (digest) => memory.has(digest),
      put: (digest, bytes) => memory.put(digest, bytes),
      presentDigests: async (digests) => {
        entered += 1
        await gate
        return memory.presentDigests(digests)
      }
    }
    const handler = makeHandler({ contentStore })
    const body = { digests: ["b".repeat(64)] }
    const admitted = Array.from(
      { length: maxConcurrentFindMissingRequests },
      () => handler(jsonRequest("/cas/findMissing", body, { method: "POST" }))
    )
    await vi.waitFor(() => expect(entered).toBe(maxConcurrentFindMissingRequests))

    const overflow = await handler(jsonRequest("/cas/findMissing", body, { method: "POST" }))
    expect(overflow.status).toBe(429)
    release?.()
    await Promise.all(admitted)
  })

  it("cancels and releases a failed request stream without logging its message", async () => {
    const body = instrumentedBody({ failRead: true })
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const response = await makeHandler()(
        rawRequest(`/ac/${keyDigest}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: body.body
        })
      )
      expect(response.status).toBe(503)
      expect(body.log).toEqual(["get-reader", "read-failed", "reader-cancel", "release"])
      expect(String(error.mock.calls[0]?.[0])).toContain("code=ECONNRESET")
      expect(String(error.mock.calls[0]?.[0])).not.toContain("secret request text")
    } finally {
      error.mockRestore()
    }
  })

  it("logs only allowlisted failure attribution", async () => {
    const secret = "postgres://user:password@database/cache"
    const failure = Object.assign(new Error(secret), {
      code: "ECONNRESET",
      query: `SELECT '${secret}'`
    })
    const actionCache: ActionCache = {
      get: async () => Promise.reject(failure),
      put: async () => Promise.reject(failure),
      delete: async () => Promise.reject(failure)
    }
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const response = await makeHandler({ actionCache })(request(`/ac/${keyDigest}`))
      expect(response.status).toBe(503)
      expect(error).toHaveBeenCalledOnce()
      const diagnostic = String(error.mock.calls[0]?.[0])
      expect(diagnostic).toContain("name=CacheFailure")
      expect(diagnostic).toContain("code=ECONNRESET")
      expect(diagnostic).not.toContain(secret)
    } finally {
      error.mockRestore()
    }
  })

  it("answers a tagged cache refusal with the fixed body and logs its name, code, and operation", async () => {
    const failure = new CacheFailure("D1_RESULT_INVALID", "actionCache.get", "D1 row for tenant-secret was invalid")
    const actionCache: ActionCache = {
      get: async () => Promise.reject(failure),
      put: async () => Promise.reject(failure),
      delete: async () => Promise.reject(failure)
    }
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const response = await makeHandler({ actionCache })(request(`/ac/${keyDigest}`))
      expect(response.status).toBe(503)
      const body = await response.text()
      expect(JSON.parse(body)).toEqual({ error: "the cache tier failed to answer" })
      expect(body).not.toContain("tenant-secret")
      expect(String(error.mock.calls[0]?.[0])).toBe(
        "smithers build cache: request failed (name=CacheFailure code=DEPENDENCY_FAILED operation=actionCache.get cause1.code=D1_RESULT_INVALID)"
      )
    } finally {
      error.mockRestore()
    }
  })

  it("names the media type it requires on every body-bearing route", async () => {
    const handler = makeHandler()
    const publication = await handler(
      request(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: "{}"
      })
    )
    const artifact = await handler(
      request(`/cas/${digestOf("bytes")}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "bytes"
      })
    )
    const findMissing = await handler(
      request("/cas/findMissing", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })
    )

    expect(publication.status).toBe(415)
    await expect(publication.json()).resolves.toEqual({ error: "content-type must be application/json" })
    expect(artifact.status).toBe(415)
    await expect(artifact.json()).resolves.toEqual({ error: "content-type must be application/octet-stream" })
    expect(findMissing.status).toBe(415)
    await expect(findMissing.json()).resolves.toEqual({ error: "content-type must be application/json" })
  })

  it("refuses a declared length over the bound before reading the body", async () => {
    const body = instrumentedBody({ chunks: [textEncoder.encode("{}")] })
    const response = await makeHandler()(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-length": String(1024 * 1024 + 1), "content-type": "application/json" },
        body: body.body
      })
    )

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({ error: "request body exceeds the configured bound" })
    expect(body.log).toEqual(["body-cancel"])
  })

  it("refuses a body shorter than its declared length", async () => {
    const short = instrumentedBody({ chunks: [textEncoder.encode("{}")] })
    const response = await makeHandler()(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-length": "3", "content-type": "application/json" },
        body: short.body
      })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: "content-length does not match the request body" })
  })

  it("grows an undeclared-length body past its starting buffer and still bounds it", async () => {
    // The route limit is above the 64 KiB starting capacity and the payload is
    // above it too, so acceptance can only come from the growth path copying
    // every earlier chunk forward: the digest check would fail otherwise.
    const limit = 200 * 1024
    const handler = makeHandler({ maxArtifactBytes: limit })
    const payload = "x".repeat(100 * 1024)
    const bytes = textEncoder.encode(payload)
    const accepted = instrumentedBody({
      chunks: [bytes.subarray(0, 40 * 1024), bytes.subarray(40 * 1024, 90 * 1024), bytes.subarray(90 * 1024)]
    })
    const stored = await handler(
      rawRequest(`/cas/${digestOf(payload)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: accepted.body
      })
    )

    const exactPayload = "y".repeat(limit)
    const exactBytes = textEncoder.encode(exactPayload)
    const exact = instrumentedBody({
      chunks: [exactBytes.subarray(0, limit - 1), exactBytes.subarray(limit - 1)]
    })
    const atLimit = await handler(
      rawRequest(`/cas/${digestOf(exactPayload)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: exact.body
      })
    )

    const oversized = instrumentedBody({ chunks: [new Uint8Array(limit), new Uint8Array(1)] })
    const refused = await handler(
      rawRequest(`/cas/${digestOf("unused")}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: oversized.body
      })
    )

    expect(stored.status).toBe(201)
    expect(atLimit.status).toBe(201)
    expect(refused.status).toBe(413)
  })

  it("refuses a body that is not UTF-8 and one that is not JSON", async () => {
    const handler = makeHandler()
    const invalidUtf8 = instrumentedBody({ chunks: [Uint8Array.from([0xff, 0xfe])] })
    const decoded = await handler(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: invalidUtf8.body
      })
    )
    const malformed = await handler(
      request(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{\"unterminated\":"
      })
    )

    expect(decoded.status).toBe(400)
    await expect(decoded.json()).resolves.toEqual({ error: "body must be UTF-8 JSON" })
    expect(malformed.status).toBe(400)
    await expect(malformed.json()).resolves.toEqual({ error: "body must be valid JSON" })
  })

  it("refuses JSON whose parse is not reversible", async () => {
    const handler = makeHandler()
    const duplicate = await handler(
      request(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        // JSON.parse keeps only the last member, so two divergent results
        // would compare identical and answer 200 where 409 is promised.
        body: "{\"keyDigest\":\"" + keyDigest + "\",\"result\":{\"a\":1,\"a\":2}}"
      })
    )
    const imprecise = await handler(
      request(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{\"keyDigest\":\"" + keyDigest + "\",\"result\":{\"n\":9007199254740993}}"
      })
    )
    const overflowing = await handler(
      request(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{\"keyDigest\":\"" + keyDigest + "\",\"result\":{\"n\":1e400}}"
      })
    )
    const accepted = await handler(
      jsonRequest(`/ac/${keyDigest}`, { keyDigest, result: { n: 9007199254740992, e: 1e21 } }, { method: "PUT" })
    )

    expect(duplicate.status).toBe(400)
    await expect(duplicate.json()).resolves.toEqual({ error: "body contains a duplicate object member name" })
    expect(imprecise.status).toBe(400)
    expect(overflowing.status).toBe(400)
    expect(accepted.status).toBe(201)
  })

  it("accepts every document a JSON serializer produces", async () => {
    const handler = makeHandler()
    // A deterministic walk over the shapes the prescan has to step past:
    // strings holding braces, quotes, escapes and digits; numbers in every
    // rendering `JSON.stringify` emits; and objects nested inside arrays,
    // where each object needs its own member-name scope.
    let seed = 0x2f6e2b1
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const strings = [
      "",
      "{\"a\":1,\"a\":2}",
      "quote\" brace} comma, colon:",
      "back\\slash",
      "digits 9007199254740993 and 1e400",
      "é 😀"
    ]
    const numbers = [0, 1, -1, 0.1, -0.5, 1e21, 1e-7, 9007199254740992, -9007199254740992, 1.7976931348623157e308]
    const value = (depth: number): unknown => {
      const choice = next()
      if (depth > 3 || choice < 0.25) {
        const leaf = next()
        if (leaf < 0.3) return strings[Math.floor(next() * strings.length)] ?? ""
        if (leaf < 0.6) return numbers[Math.floor(next() * numbers.length)] ?? 0
        if (leaf < 0.8) return next() < 0.5
        return null
      }
      if (choice < 0.6) return Array.from({ length: Math.floor(next() * 4) }, () => value(depth + 1))
      return Object.fromEntries(
        Array.from(
          { length: Math.floor(next() * 4) },
          (_, index) => [`k${index}${strings[index] ?? ""}`, value(depth + 1)]
        )
      )
    }

    for (let round = 0; round < 60; round += 1) {
      const body = JSON.stringify({ keyDigest, result: value(0) })
      const response = await handler(
        request(`/ac/${keyDigest}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body
        })
      )
      expect([200, 201, 409]).toContain(response.status)
    }
  })

  it("does not confuse a member name inside a string with a duplicate", async () => {
    const handler = makeHandler()
    const response = await handler(
      jsonRequest(
        `/ac/${keyDigest}`,
        { keyDigest, result: { a: "\"a\":1,\"a\"", nested: { a: 1 }, list: [{ a: 1 }, { a: 2 }] } },
        { method: "PUT" }
      )
    )

    expect(response.status).toBe(201)
  })

  it("refuses a publication whose key disagrees with the request path", async () => {
    const response = await makeHandler()(
      jsonRequest(`/ac/${keyDigest}`, { keyDigest: "other", result: { exitOk: true } }, { method: "PUT" })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "keyDigest must match the request path when supplied"
    })
  })

  it("refuses malformed artifact digests and malformed artifact paths", async () => {
    const handler = makeHandler()

    const shape = await handler(request("/cas/not-a-digest"))
    const uppercase = await handler(request(`/cas/${"A".repeat(64)}`))
    const encoding = await handler(request("/cas/%"))
    const emptyKey = await handler(request("/ac/"))

    expect(shape.status).toBe(400)
    await expect(shape.json()).resolves.toEqual({ error: "digest must be 64 lowercase hex characters" })
    expect(uppercase.status).toBe(400)
    expect(encoding.status).toBe(400)
    await expect(encoding.json()).resolves.toEqual({ error: "digest must be valid URL encoding" })
    expect(emptyKey.status).toBe(400)
    await expect(emptyKey.json()).resolves.toEqual({ error: "empty keyDigest" })
  })

  it("refuses an unpaired or unbounded deletion fence", async () => {
    const handler = makeHandler()
    const runIdOnly = await handler(request(`/ac/${keyDigest}?recordedRunId=run-1`, { method: "DELETE" }))
    const emptyRunId = await handler(
      request(`/ac/${keyDigest}?recordedRunId=&recordedEventSeq=1`, { method: "DELETE" })
    )
    const oversized = await handler(
      request(
        `/ac/${keyDigest}?recordedRunId=${"r".repeat(maxRecordedRunIdLength + 1)}&recordedEventSeq=1`,
        { method: "DELETE" }
      )
    )
    const control = await handler(
      request(`/ac/${keyDigest}?recordedRunId=run%001&recordedEventSeq=1`, { method: "DELETE" })
    )

    expect(runIdOnly.status).toBe(400)
    await expect(runIdOnly.json()).resolves.toEqual({
      error: "recordedRunId and recordedEventSeq must be supplied together"
    })
    expect(emptyRunId.status).toBe(400)
    expect(oversized.status).toBe(400)
    expect(control.status).toBe(400)
    await expect(control.json()).resolves.toEqual({
      error: "recordedRunId must be a non-empty bounded string"
    })
  })

  it("refuses a findMissing body that is not a digest array", async () => {
    const handler = makeHandler()
    const notAnArray = await handler(jsonRequest("/cas/findMissing", { digests: "all" }, { method: "POST" }))
    const notDigests = await handler(
      jsonRequest("/cas/findMissing", { digests: ["not-a-digest"] }, { method: "POST" })
    )

    expect(notAnArray.status).toBe(400)
    await expect(notAnArray.json()).resolves.toEqual({ error: "body must be {\"digests\":[...]}" })
    expect(notDigests.status).toBe(400)
    await expect(notDigests.json()).resolves.toEqual({
      error: "every digest must be 64 lowercase hex characters"
    })
  })

  it("refuses a stored row that names a different key and a store that invents digests", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const foreignRow = makeHandler({
        actionCache: {
          get: async () => JSON.stringify({ keyDigest: "someone-else" }),
          put: async () => "inserted",
          delete: async () => false
        }
      })
      const inventingStore = makeHandler({
        contentStore: {
          get: async () => null,
          has: async () => false,
          put: async () => "inserted",
          presentDigests: async () => new Set([digestOf("never requested")])
        }
      })

      expect((await foreignRow(request(`/ac/${keyDigest}`))).status).toBe(503)
      expect(
        (await inventingStore(
          jsonRequest("/cas/findMissing", { digests: [digestOf("asked")] }, { method: "POST" })
        )).status
      ).toBe(503)
    } finally {
      errors.mockRestore()
    }
  })

  it("refuses every dependency shape it cannot snapshot safely", () => {
    const actionCache = new MemoryActionCache()
    const contentStore = new MemoryContentStore()
    const base = { actionCache, contentStore, readTokenHash, writeTokenHash }

    expect(() => createHandler({ ...base, actionCache: 5 } as never)).toThrow("actionCache must be an object")
    expect(() => createHandler({ ...base, actionCache: { get: async () => null } } as never)).toThrow(
      "actionCache.put must be a method"
    )
    expect(() =>
      createHandler({
        ...base,
        contentStore: Object.defineProperty({ ...contentStore }, "get", { get: () => async () => null })
      } as never)
    ).toThrow("contentStore.get must be a data method")
    expect(() => createHandler(Object.assign(Object.create({ inherited: true }), base) as never)).toThrow(
      "must be a plain object"
    )
    expect(() => createHandler({ ...base, unexpected: true } as never)).toThrow("unknown property: unexpected")
    expect(() =>
      createHandler(Object.defineProperty({ ...base }, "readTokenHash", {
        enumerable: false,
        value: readTokenHash
      }) as never)
    ).toThrow("enumerable data property")
    expect(() => createHandler({ ...base, health: 5 } as never)).toThrow("health must be a function")
    expect(() => createHandler([] as never)).toThrow("must be a plain object")
  })

  it("renders object and array shapes a parser cannot produce instead of inspecting them", () => {
    // The JSDoc precondition, not the renderer, excludes shapes `JSON.parse`
    // cannot build. Rendering reads own enumerable keys and member values and
    // nothing else, so these render rather than refuse.
    expect(canonicalJson(Object.create({ inherited: 1 }))).toBe("{}")
    expect(canonicalJson({ [Symbol("hidden")]: 1 })).toBe("{}")
    const extended: Array<number> & { extra?: number } = [1]
    extended.extra = 2
    expect(canonicalJson(extended)).toBe("[1]")
    const hiddenElement = [1]
    Object.defineProperty(hiddenElement, "0", { enumerable: false })
    expect(canonicalJson(hiddenElement)).toBe("[1]")
    const hiddenMember = Object.defineProperty({}, "key", { enumerable: false, value: 1 })
    expect(canonicalJson(hiddenMember)).toBe("{}")
    // The bounds parsed JSON can still break stay enforced.
    expect(() => canonicalJson(new Array(maxJsonMembers + 1).fill(0))).toThrow("too many members")
    expect(() => canonicalJson(undefined)).toThrow("unsupported JSON value")
  })

  it("runs the traps a proxy installs, so only parser-owned values may be canonicalized", () => {
    const traps: Array<string> = []
    const proxy = new Proxy({ value: "safe" }, {
      getPrototypeOf(target) {
        traps.push("getPrototypeOf")
        return Reflect.getPrototypeOf(target)
      },
      ownKeys(target) {
        traps.push("ownKeys")
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, property) {
        traps.push("getOwnPropertyDescriptor")
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
      get(target, property, receiver) {
        traps.push("get")
        return Reflect.get(target, property, receiver)
      }
    })

    expect(canonicalJson(proxy)).toBe("{\"value\":\"safe\"}")
    // The JSDoc precondition is the guarantee, not inertness: a proxy that
    // reaches this function does run code, so no caller may pass one. It runs
    // only the reads an own-key enumeration and a member read need; the
    // prototype is no longer walked.
    expect(traps).toEqual(["ownKeys", "getOwnPropertyDescriptor", "get"])

    const revocable = Proxy.revocable({ value: 1 }, {})
    revocable.revoke()
    expect(() => canonicalJson(revocable.proxy)).toThrow()
  })

  it("holds the request cap while action-cache response bodies remain unread", async () => {
    const body = JSON.stringify({ keyDigest, result: { exitOk: true } })
    const actionCache = new MemoryActionCache()
    actionCache.entries.set(keyDigest, {
      body,
      resultJson: canonicalJson({ exitOk: true }),
      createdAtMs: null,
      recordedRunId: null,
      recordedEventSeq: null
    })
    const handler = makeHandler({ actionCache })

    const held = await Promise.all(
      Array.from({ length: maxConcurrentCacheRequests }, () => handler(request(`/ac/${keyDigest}`)))
    )
    expect(held.every((response) => response.status === 200)).toBe(true)

    const refused = await handler(request(`/ac/${keyDigest}`))
    expect(refused.status).toBe(429)
    expect(refused.headers.get("retry-after")).toBe("1")

    await Promise.all(held.map((response) => response.body?.cancel()))
  })

  it("releases exactly one action-cache request permit on body cancel, drain, or error", async () => {
    const body = JSON.stringify({ keyDigest, result: { exitOk: true } })
    const nativeResponse = globalThis.Response

    for (const completion of ["cancel", "drain", "error"] as const) {
      const streams: Array<{
        readonly controller: ReadableStreamDefaultController<Uint8Array<ArrayBufferLike>>
        readonly cancellations: number
      }> = []
      class ControlledResponse extends nativeResponse {
        constructor(responseBody?: BodyInit | null, init?: ResponseInit) {
          if (responseBody === body && init?.status === 200) {
            let controller!: ReadableStreamDefaultController<Uint8Array<ArrayBufferLike>>
            let cancellations = 0
            const stream = new ReadableStream<Uint8Array<ArrayBufferLike>>({
              start(value) {
                controller = value
              },
              cancel() {
                cancellations += 1
              }
            })
            super(stream, init)
            streams.push({
              controller,
              get cancellations() {
                return cancellations
              }
            })
            return
          }
          super(responseBody, init)
        }
      }
      vi.stubGlobal("Response", ControlledResponse)

      try {
        const actionCache = new MemoryActionCache()
        actionCache.entries.set(keyDigest, {
          body,
          resultJson: canonicalJson({ exitOk: true }),
          createdAtMs: null,
          recordedRunId: null,
          recordedEventSeq: null
        })
        const handler = makeHandler({ actionCache })
        const held: Array<Response> = []
        for (let index = 0; index < maxConcurrentCacheRequests; index += 1) {
          held.push(await handler(request(`/ac/${keyDigest}`)))
        }
        expect(held.every((response) => response.status === 200)).toBe(true)
        expect((await handler(request(`/ac/${keyDigest}`))).status).toBe(429)

        const firstResponse = held[0]
        const firstStream = streams[0]
        if (firstResponse === undefined || firstResponse.body === null || firstStream === undefined) {
          throw new Error("action-cache response did not expose a controlled body")
        }
        if (completion === "cancel") {
          await firstResponse.body.cancel()
          expect(firstStream.cancellations).toBe(1)
        } else if (completion === "drain") {
          firstStream.controller.enqueue(textEncoder.encode("done"))
          firstStream.controller.close()
          expect(await firstResponse.text()).toBe("done")
        } else {
          firstStream.controller.error(new Error("stream failed"))
          await expect(firstResponse.arrayBuffer()).rejects.toThrow("stream failed")
        }

        const admitted = await handler(request(`/ac/${keyDigest}`))
        expect(admitted.status).toBe(200)
        // Exactly one permit was released: the other original responses and
        // this replacement still occupy the request ceiling.
        expect((await handler(request(`/ac/${keyDigest}`))).status).toBe(429)
        await Promise.all(held.slice(1).map((response) => response.body?.cancel()))
        await admitted.body?.cancel()
      } finally {
        vi.unstubAllGlobals()
      }
    }
  })

  it("holds an artifact transfer slot until the response body is done", async () => {
    const bytes = textEncoder.encode("streamed artifact")
    const digest = digestOf("streamed artifact")
    const contentStore = new MemoryContentStore()
    await contentStore.put(digest, new Uint8Array(bytes))
    const handler = makeHandler({ contentStore })

    const held = await Promise.all(
      Array.from({ length: maxConcurrentArtifactTransfers }, () => handler(request(`/cas/${digest}`)))
    )
    expect(held.map((response) => response.status)).toEqual(
      Array.from({ length: maxConcurrentArtifactTransfers }, () => 200)
    )

    // Every slot is still held: the bodies have not been consumed, so the
    // transfers the ceiling exists to bound are still in flight.
    const refused = await handler(request(`/cas/${digest}`))
    expect(refused.status).toBe(429)

    await held[0]?.body?.cancel()
    const afterCancel = await handler(request(`/cas/${digest}`))
    expect(afterCancel.status).toBe(200)
    expect(await afterCancel.text()).toBe("streamed artifact")

    expect(await held[1]?.text()).toBe("streamed artifact")
    const afterDrain = await handler(request(`/cas/${digest}`))
    expect(afterDrain.status).toBe(200)
    await afterDrain.text()
  })

  it("reports a malformed request URL as a client error", async () => {
    const response = await makeHandler()(
      {
        url: "https://cache.test:99999/ac/key",
        method: "GET",
        headers: new Headers({ authorization: `Bearer ${token}` }),
        body: null
      } as Request
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: "request URL is malformed" })
  })

  it("validates declared digests without materializing an unused reference array", async () => {
    const handler = makeHandler()
    const digest = "d".repeat(64)
    const publication = jsonRequest(`/ac/${keyDigest}`, {
      keyDigest,
      result: { ok: true },
      meta: { boundary: { declaredOutputs: { outputs: [{ digest }] } } }
    }, { method: "PUT" })
    const iterate = vi.spyOn(Set.prototype, Symbol.iterator)
    try {
      expect((await handler(publication)).status).toBe(201)
      expect(iterate.mock.contexts.filter((set) => set instanceof Set && set.size === 1 && set.has(digest))).toHaveLength(0)
    } finally {
      iterate.mockRestore()
    }
  })

  it("canonicalizes a bare publication only once", async () => {
    const handler = makeHandler()
    const publication = jsonRequest(`/ac/${keyDigest}`, { output: "canonical-render-marker" }, { method: "PUT" })
    const encode = vi.spyOn(TextEncoder.prototype, "encode")
    try {
      expect((await handler(publication)).status).toBe(201)
      expect(encode.mock.calls.filter(([value]) => value === '"canonical-render-marker"')).toHaveLength(1)
    } finally {
      encode.mockRestore()
    }
  })

  it("attributes provider failures to their operation without logging provider messages", async () => {
    const secret = "provider bearer=private-token"
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const health = async () => {
      throw new Error(secret, { cause: Object.assign(new Error(secret), { code: "ECONNRESET" }) })
    }
    try {
      expect((await makeHandler({ health })(request("/healthz"))).status).toBe(503)
      const line = String(errors.mock.calls[0]?.[0])
      expect(line).toContain("code=DEPENDENCY_FAILED operation=health")
      expect(line).toContain("cause2.code=ECONNRESET")
      expect(line).not.toContain(secret)
    } finally {
      errors.mockRestore()
    }
  })

  it("bounds cyclic cause diagnostics and rejects unsafe operation and cause fields", () => {
    const cycle = Object.assign(new Error("private provider message"), { code: "ELOOP", operation: "health" })
    Object.defineProperty(cycle, "cause", { value: cycle })
    const line = describeFailure(cycle)
    expect(line.match(/cause[1-4]\.code=ELOOP/g)).toHaveLength(4)
    expect(line).not.toContain("cause5")
    expect(line).not.toContain("private")

    let reads = 0
    const nested = Object.defineProperty({}, "code", { get() { reads += 1; return "private" } })
    const failure = Object.assign(new Error("private"), { operation: "private operation", cause: nested })
    expect(describeFailure(failure)).toBe("smithers build cache: request failed (name=Error)")
    expect(describeFailure({ operation: 123, cause: { code: "Bearer private" } })).toBe(
      "smithers build cache: request failed (unattributed)"
    )
    expect(describeFailure(Object.defineProperty({}, "cause", { get() { reads += 1; return nested } }))).toBe(
      "smithers build cache: request failed (unattributed)"
    )
    expect(describeFailure({ cause: null })).toBe("smithers build cache: request failed (unattributed)")
    expect(reads).toBe(0)
  })

  it("survives diagnostics with throwing fields and primitive failures", () => {
    let reads = 0
    const hostile = Object.defineProperty({}, "name", {
      get: () => {
        reads += 1
        throw new Error("diagnostic trap")
      }
    })
    expect(describeFailure(hostile)).toBe("smithers build cache: request failed (unattributed)")
    expect(reads).toBe(0)
    expect(describeFailure("secret string")).toBe("smithers build cache: request failed (kind=string)")
  })

  it("attributes numeric diagnostics and survives a cause that traps inspection", () => {
    const trapped = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("descriptor trap")
      }
    })

    expect(describeFailure(null)).toBe("smithers build cache: request failed (kind=null)")
    expect(describeFailure(Object.assign(new Error("host"), { errno: -2 }))).toBe(
      "smithers build cache: request failed (name=Error errno=-2)"
    )
    expect(describeFailure(Object.assign(new Error("host"), { errno: 1.5 }))).toBe(
      "smithers build cache: request failed (name=Error)"
    )
    expect(describeFailure(trapped)).toBe("smithers build cache: request failed (unattributed)")
  })

  it("names every surrogate fault in an action key", () => {
    expect(invalidKeyDigest("\uD800a")).toBe("keyDigest must be well-formed Unicode text")
    expect(invalidKeyDigest("\uDC00")).toBe("keyDigest must be well-formed Unicode text")
    expect(invalidKeyDigest("key:😀")).toBeNull()
  })

  it("reads the media type without its parameters and refuses a body that declares none", async () => {
    const handler = makeHandler()
    const withParameters = await handler(
      jsonRequest(`/ac/${keyDigest}`, { exitOk: true }, {
        method: "PUT",
        headers: { "content-type": "Application/JSON; charset=utf-8" }
      })
    )
    const undeclared = await handler(rawRequest(`/ac/${keyDigest}`, { method: "PUT", body: instrumentedBody().body }))

    expect(withParameters.status).toBe(201)
    expect(undeclared.status).toBe(415)
  })

  it("does not let a body that refuses cancellation replace the answer", async () => {
    const handler = makeHandler()
    const refused = instrumentedBody({ failCancel: true })
    const unauthorized = await handler(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { authorization: "Bearer wrong", "content-type": "application/json" },
        body: refused.body
      })
    )
    const abandoned = instrumentedBody({ chunks: [textEncoder.encode("{}")], failCancel: true })
    const mismatch = await handler(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-length": "1", "content-type": "application/json" },
        body: abandoned.body
      })
    )

    expect(unauthorized.status).toBe(401)
    expect(refused.log).toEqual(["body-cancel"])
    expect(mismatch.status).toBe(400)
    expect(abandoned.log).toEqual(["get-reader", "reader-cancel", "release"])
  })

  it("treats a request without a body as empty unless a length claims otherwise", async () => {
    const handler = makeHandler()
    const emptyArtifact = digestOf("")
    const octets = { "content-type": "application/octet-stream" }

    const undeclared = await handler(rawRequest(`/cas/${emptyArtifact}`, { method: "PUT", headers: octets }))
    const zero = await handler(
      rawRequest(`/cas/${emptyArtifact}`, { method: "PUT", headers: { ...octets, "content-length": "0" } })
    )
    const claimed = await handler(
      rawRequest(`/cas/${emptyArtifact}`, { method: "PUT", headers: { ...octets, "content-length": "5" } })
    )

    expect(undeclared.status).toBe(201)
    expect(zero.status).toBe(200)
    expect(claimed.status).toBe(400)
    await expect(claimed.json()).resolves.toEqual({ error: "content-length does not match the request body" })
  })

  it("answers 404 for a deletion and a HEAD that find nothing", async () => {
    const handler = makeHandler()

    expect((await handler(request(`/ac/${keyDigest}`, { method: "DELETE" }))).status).toBe(404)
    expect((await handler(request(`/cas/${digestOf("absent")}`, { method: "HEAD" }))).status).toBe(404)
  })

  it("refuses canonicalization inputs past the member and byte bounds", () => {
    const wide = Object.fromEntries(Array.from({ length: maxJsonMembers + 1 }, (_, index) => [String(index), 0]))
    const chunk = "x".repeat(maxCanonicalJsonBytes / 2)

    expect(() => canonicalJson(wide)).toThrow("JSON has too many members")
    expect(() => canonicalJson([chunk, chunk, chunk])).toThrow("canonical JSON exceeds its byte bound")
  })

  it("turns a bodyless content object and an unknown publication outcome into refusals", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const handler = makeHandler({
        contentStore: {
          get: async () => "not an object" as never,
          has: async () => false,
          put: async () => "stored" as never,
          presentDigests: async () => new Set()
        }
      })
      const artifact = textEncoder.encode("artifact")

      expect((await handler(request(`/cas/${digestOf("artifact")}`))).status).toBe(503)
      expect(
        (await handler(
          request(`/cas/${digestOf("artifact")}`, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: artifact
          })
        )).status
      ).toBe(503)
    } finally {
      errors.mockRestore()
    }
  })

  it("stores provenance and skips declared outputs that name no artifact", async () => {
    const actionCache = new MemoryActionCache()
    const handler = makeHandler({ actionCache })
    const response = await handler(
      jsonRequest(`/ac/${keyDigest}`, {
        keyDigest,
        result: { exitOk: true },
        createdAtMs: 1_700_000_000_000,
        meta: {
          boundary: {
            declaredOutputs: {
              outputs: [
                { path: "declared-without-digest" },
                { digest: null },
                { digest: digestOf("inline"), content: "inline" },
                { digest: digestOf("stored") }
              ]
            }
          }
        }
      }, { method: "PUT" })
    )

    expect(response.status).toBe(201)
    expect(actionCache.entries.get(keyDigest)?.createdAtMs).toBe(1_700_000_000_000)
  })

  it("refuses dependencies that trap inspection", () => {
    const base = {
      actionCache: new MemoryActionCache(),
      contentStore: new MemoryContentStore(),
      readTokenHash,
      writeTokenHash
    }
    const trapping = (trap: "getPrototypeOf" | "getOwnPropertyDescriptor", target: object = {}) =>
      new Proxy(target, {
        [trap]: () => {
          throw new Error("trap")
        }
      })

    expect(() => createHandler(trapping("getPrototypeOf") as never)).toThrow(
      "protocol dependencies could not be inspected safely"
    )
    expect(() => createHandler(trapping("getOwnPropertyDescriptor", { ...base }) as never)).toThrow(
      "protocol dependency actionCache could not be inspected safely"
    )
    expect(() => createHandler({ ...base, actionCache: trapping("getOwnPropertyDescriptor") } as never)).toThrow(
      "actionCache.get could not be inspected safely"
    )
    expect(() => createHandler({ ...base, actionCache: trapping("getPrototypeOf") } as never)).toThrow(
      "actionCache.get could not be inspected safely"
    )
  })

  it("answers findMissing from its own snapshot of the request", async () => {
    const asked = digestOf("asked")
    const injected = digestOf("never requested")
    const store = (answer: ReadonlySet<string>): ContentStore => ({
      get: async () => null,
      has: async () => false,
      put: async () => "inserted",
      presentDigests: async (digests) => {
        // A store that writes into the array it was handed must not be able
        // to put a digest the client never asked for into the answer.
        expect(Object.isFrozen(digests)).toBe(true)
        Reflect.set(digests, 0, injected)
        return answer
      }
    })
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const injecting = makeHandler({ contentStore: store(new Set([injected])) })
      expect(
        (await injecting(jsonRequest("/cas/findMissing", { digests: [asked] }, { method: "POST" }))).status
      ).toBe(503)
    } finally {
      errors.mockRestore()
    }

    const quiet = makeHandler({ contentStore: store(new Set()) })
    const response = await quiet(jsonRequest("/cas/findMissing", { digests: [asked] }, { method: "POST" }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ missing: [asked] })
  })

  it("releases a stalled artifact transfer exactly once when the client cancels it", async () => {
    const digest = digestOf("stalled")
    const stalled: ContentStore = {
      get: async () => ({
        body: new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) })
      }),
      has: async () => true,
      put: async () => "present",
      presentDigests: async () => new Set()
    }
    const handler = makeHandler({ contentStore: stalled })
    const held = await Promise.all(
      Array.from({ length: maxConcurrentArtifactTransfers }, () => handler(request(`/cas/${digest}`)))
    )
    expect(held.map((response) => response.status)).toEqual([200, 200])
    expect((await handler(request(`/cas/${digest}`))).status).toBe(429)

    // The cancelled transfer's source read settles after the cancel and
    // reaches the release a second time; the slot must come back once.
    await held[0]?.body?.cancel()
    const readmitted = await handler(request(`/cas/${digest}`))
    expect(readmitted.status).toBe(200)
    expect((await handler(request(`/cas/${digest}`))).status).toBe(429)

    await Promise.all([held[1]?.body?.cancel(), readmitted.body?.cancel()])
  })
})

describe("admitted body deadlines", () => {
  it.each([false, true])("bounds an admitted body with periodic progress: %s", async (progress) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value },
      cancel
    })
    const handler = makeHandler()
    let settled = false
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    try {
      const pending = handler(request(`/ac/${keyDigest}`, {
        method: "PUT", body, headers: { "content-type": "application/json" }, duplex: "half"
      } as RequestInit)).then((response) => {
        settled = true
        return response
      })
      await vi.waitFor(() => expect(body.locked).toBe(true))
      if (progress) {
        for (let index = 0; index < 7; index += 1) {
          await vi.advanceTimersByTimeAsync(8_000)
          expect(settled).toBe(false)
          controller.enqueue(textEncoder.encode(" "))
          await vi.advanceTimersByTimeAsync(0)
        }
        await vi.advanceTimersByTimeAsync(4_001)
      } else {
        await vi.advanceTimersByTimeAsync(10_001)
      }
      expect(settled).toBe(true)
      expect((await pending).status).toBe(503)
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(body.locked).toBe(false)
      expect((await handler(jsonRequest(`/ac/${keyDigest}`, {}, { method: "PUT" }))).status).toBe(201)
    } finally {
      vi.useRealTimers()
      errors.mockRestore()
    }
  })
})

describe("admitted body cancellation edges", () => {
  it.each(["GET", "PUT"])("does not start work for a pre-aborted %s", async (method) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const cancel = vi.fn()
    const get = vi.fn(async () => null)
    const memory = new MemoryActionCache()
    const handler = makeHandler({ actionCache: {
      get, put: (key, publication) => memory.put(key, publication),
      delete: (key, fence) => memory.delete(key, fence)
    } })
    const aborter = new AbortController()
    aborter.abort()
    const body = new ReadableStream<Uint8Array>({ cancel })
    try {
      const response = await handler(request(`/ac/${keyDigest}`, {
        method, signal: aborter.signal, headers: { "content-type": "application/json" },
        ...(method === "PUT" ? { body, duplex: "half" } : {})
      }))
      expect(response.status).toBe(503)
      expect(get).not.toHaveBeenCalled()
      expect(body.locked).toBe(false)
      if (method === "PUT") expect(cancel).toHaveBeenCalledTimes(1)
    } finally {
      errors.mockRestore()
    }
  })

  it.each(["synchronous read failure", "total deadline between reads"])("releases the reader after %s", async (failure) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    let now = 0
    const time = vi.spyOn(performance, "now").mockImplementation(() => now)
    const cancel = vi.fn(async () => undefined)
    const releaseLock = vi.fn()
    const read = vi.fn(() => {
      if (failure === "synchronous read failure") throw new Error("reader failed")
      // Microtask-only producers can advance elapsed time without giving the
      // timer queue a turn. The total deadline must be checked between reads.
      now = 60_001
      return Promise.resolve({ done: false, value: textEncoder.encode(" ") })
    })
    try {
      const response = await makeHandler()(rawRequest(`/ac/${keyDigest}`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: { getReader: () => ({ read, cancel, releaseLock }) }
      }))
      expect(response.status).toBe(503)
      expect(read).toHaveBeenCalledTimes(1)
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(releaseLock).toHaveBeenCalledTimes(1)
    } finally {
      time.mockRestore()
      errors.mockRestore()
    }
  })
})

// Include an ASCII suffix so odd byte lengths remain exact for multibyte text.
const boundedText = (bytes: number, multibyte: boolean): string =>
  multibyte ? "é".repeat(Math.floor(bytes / 2)) + "x".repeat(bytes % 2) : "x".repeat(bytes)

const boundaryOffsets = [-1, 0, 1] as const

describe("exact protocol boundaries", () => {
  describe.each([false, true])("UTF-8 identifiers (multibyte: %s)", (multibyte) => {
    it.each(boundaryOffsets)("pins action-key bytes at limit offset %i", async (offset) => {
      const key = boundedText(maxKeyDigestLength + offset, multibyte)
      expect(textEncoder.encode(key)).toHaveLength(maxKeyDigestLength + offset)
      expect(invalidKeyDigest(key)).toBe(
        offset > 0 ? `keyDigest must be at most ${maxKeyDigestLength} UTF-8 bytes` : null
      )
      const actionCache = new MemoryActionCache()
      const handler = makeHandler({ actionCache })
      const response = await handler(jsonRequest(`/ac/${encodeURIComponent(key)}`, "{}", { method: "PUT" }))
      expect(response.status).toBe(offset > 0 ? 400 : 201)
      expect(await actionCache.get(key)).toBe(offset > 0 ? null : "{}")
    })

    it.each(boundaryOffsets)("pins publication and deletion run-ID bytes at limit offset %i", async (offset) => {
      const runId = boundedText(maxRecordedRunIdLength + offset, multibyte)
      expect(textEncoder.encode(runId)).toHaveLength(maxRecordedRunIdLength + offset)
      const actionCache = new MemoryActionCache()
      const handler = makeHandler({ actionCache })
      const response = await handler(jsonRequest(`/ac/${keyDigest}`, {
        keyDigest,
        result: {},
        recordedRunId: runId,
        recordedEventSeq: 0
      }, { method: "PUT" }))
      expect(response.status).toBe(offset > 0 ? 400 : 422)
      // Valid provenance reaches the hosted-tier refusal; invalid provenance fails validation first.
      expect(await response.json()).toEqual(
        offset > 0
          ? { error: "publication provenance is invalid" }
          : {
            code: "UNSUPPORTED_PROVENANCE",
            error: "the hosted cache supports result-only arbitration, not journal provenance"
          }
      )
      expect(actionCache.entries.size).toBe(0)
      const legacy = { body: "{}", resultJson: "{}", createdAtMs: null, recordedRunId: runId, recordedEventSeq: 0 }
      await actionCache.put(keyDigest, legacy)
      const deleted = await handler(request(
        `/ac/${keyDigest}?${new URLSearchParams({
          recordedRunId: runId,
          recordedEventSeq: "0"
        })}`,
        { method: "DELETE" }
      ))
      expect(deleted.status).toBe(offset > 0 ? 400 : 200)
      expect(actionCache.entries.get(keyDigest)).toEqual(offset > 0 ? legacy : undefined)
    })
  })

  it.each(boundaryOffsets)("pins findMissing digest count at limit offset %i before deduplication", async (offset) => {
    const contentStore = new MemoryContentStore()
    const digest = "b".repeat(64)
    const response = await makeHandler({ contentStore })(jsonRequest("/cas/findMissing", {
      digests: Array.from({ length: maxFindMissingDigests + offset }, () => digest)
    }, { method: "POST" }))
    expect(response.status).toBe(offset > 0 ? 413 : 200)
    expect(contentStore.presentCalls).toBe(offset > 0 ? 0 : 1)
    if (offset <= 0) expect(await response.json()).toEqual({ missing: [digest] })
  })

  it.each(boundaryOffsets)("pins unique artifact-reference count at limit offset %i", async (offset) => {
    const actionCache = new MemoryActionCache()
    const outputs = Array.from({ length: maxReferencedDigests + offset }, (_, index) => ({
      digest: index.toString(16).padStart(64, "0")
    }))
    // Duplicate references do not consume the independent unique-digest budget.
    const body = JSON.stringify({
      keyDigest,
      result: {},
      meta: {
        boundary: { declaredOutputs: { outputs: [...outputs, ...outputs] } }
      }
    })
    const response = await makeHandler({ actionCache })(jsonRequest(`/ac/${keyDigest}`, body, { method: "PUT" }))
    expect(response.status).toBe(offset > 0 ? 400 : 201)
    expect(await actionCache.get(keyDigest)).toBe(offset > 0 ? null : body)
  })

  it("pins the canonical rendering of parser-owned documents", () => {
    // The discriminator these strings become is what decides 200 against 409,
    // so a renderer change that moves any of them has to move this table
    // first. Every input is JSON text, because a parser is the only source
    // this function accepts.
    const corpus: ReadonlyArray<readonly [string, string]> = [
    ["{\"b\":1,\"a\":[1,2,{\"z\":null,\"y\":\"\u00e9 \ud83d\ude00 \\\"quote\\\" \\u0001\"}],\"c\":true,\"d\":1e21,\"e\":0.1,\"f\":-1.5,\"g\":9007199254740992}", "{\"a\":[1,2,{\"y\":\"\u00e9 \ud83d\ude00 \\\"quote\\\" \\u0001\",\"z\":null}],\"b\":1,\"c\":true,\"d\":1e+21,\"e\":0.1,\"f\":-1.5,\"g\":9007199254740992}"],
    ["[]", "[]"],
    ["{}", "{}"],
    ["\"plain\"", "\"plain\""],
    ["[[[[{\"k\":[]}]]]]", "[[[[{\"k\":[]}]]]]"],
    ["{\"key\\u0000\":\"v\",\"10\":1,\"2\":2,\"a\":3,\"B\":4}", "{\"10\":1,\"2\":2,\"B\":4,\"a\":3,\"key\\u0000\":\"v\"}"],
    ["{\"\\ud800\":\"\\udfff lone\",\"ok\":\"\\ud83d\\ude00\"}", "{\"ok\":\"\ud83d\ude00\",\"\\ud800\":\"\\udfff lone\"}"],
    ["[true,false,null,0,-1.5,1e-7,1e21,9007199254740992]", "[true,false,null,0,-1.5,1e-7,1e+21,9007199254740992]"],
    ["{\"nested\":{\"a\":{\"b\":{\"c\":[1,{\"d\":2}]}}},\"\":\"empty key\"}", "{\"\":\"empty key\",\"nested\":{\"a\":{\"b\":{\"c\":[1,{\"d\":2}]}}}}"],
    ["{\"tab\":\"a\\tb\",\"nl\":\"a\\nb\",\"quote\":\"\\\"\",\"backslash\":\"\\\\\",\"del\":\"\\u007f\"}", "{\"backslash\":\"\\\\\",\"del\":\"\u007f\",\"nl\":\"a\\nb\",\"quote\":\"\\\"\",\"tab\":\"a\\tb\"}"],
    ]

    for (const [text, expected] of corpus) {
      expect(canonicalJson(JSON.parse(text) as unknown)).toBe(expected)
      // Canonical text is parser-owned too, and renders to itself.
      expect(canonicalJson(JSON.parse(expected) as unknown)).toBe(expected)
    }
  })

  describe.each(["array", "object"] as const)("canonical %s bounds", (shape) => {
    it.each(boundaryOffsets)("pins depth at limit offset %i", async (offset) => {
      let value: unknown = null
      for (let depth = 0; depth < maxJsonDepth + offset; depth += 1) {
        value = shape === "array" ? [value] : { child: value }
      }
      const body = JSON.stringify(value)
      if (offset > 0) expect(() => canonicalJson(value)).toThrow("JSON is nested too deeply")
      else expect(canonicalJson(value)).toBe(body)
      const response = await makeHandler()(jsonRequest(`/ac/${keyDigest}`, body, { method: "PUT" }))
      expect(response.status).toBe(offset > 0 ? 400 : 201)
    })

    it.each(boundaryOffsets)("pins aggregate members across nested containers at limit offset %i", (offset) => {
      const members = maxJsonMembers + offset
      const left = Math.floor((members - 2) / 2)
      const right = members - 2 - left
      const object = (count: number) =>
        Object.fromEntries(Array.from({ length: count }, (_, index) => [String(index), 0]))
      // Two parent members plus both children; neither child alone exceeds the budget.
      const value = shape === "array"
        ? { left: new Array(left).fill(0), right: new Array(right).fill(0) }
        : [object(left), object(right)]
      if (offset > 0) expect(() => canonicalJson(value)).toThrow("JSON has too many members")
      else expect(JSON.parse(canonicalJson(value))).toEqual(value)
    })
  })

  describe.each(["ascii", "multibyte", "escaped", "aggregate"] as const)("canonical %s bytes", (shape) => {
    it.each(boundaryOffsets)("pins encoded bytes at limit offset %i", (offset) => {
      const bytes = maxCanonicalJsonBytes + offset
      const stringBytes = bytes - 2
      const value = shape === "escaped"
        ? "\u0000".repeat(Math.floor(stringBytes / 6)) + "x".repeat(stringBytes % 6)
        : shape === "aggregate"
        ? [boundedText(Math.floor((bytes - 7) / 2), true), boundedText(Math.ceil((bytes - 7) / 2), true)]
        : boundedText(stringBytes, shape === "multibyte")
      const expected = JSON.stringify(value)
      expect(textEncoder.encode(expected)).toHaveLength(bytes)
      if (offset > 0) expect(() => canonicalJson(value)).toThrow("canonical JSON exceeds its byte bound")
      else expect(canonicalJson(value)).toBe(expected)
    })
  })

  describe.each([
    {
      route: "action cache",
      path: `/ac/${keyDigest}`,
      method: "PUT",
      limit: maxActionCacheBodyBytes,
      json: "{}",
      status: 201
    },
    {
      route: "findMissing",
      path: "/cas/findMissing",
      method: "POST",
      limit: maxFindMissingBodyBytes,
      json: "{\"digests\":[]}",
      status: 200
    }
  ])("$route body bytes", ({ path, method, limit, json, status }) => {
    describe.each([false, true])("declared length: %s", (declared) => {
      it.each(boundaryOffsets)("pins body bytes at limit offset %i", async (offset) => {
        const actionCache = new MemoryActionCache()
        const contentStore = new MemoryContentStore()
        const text = json + " ".repeat(limit + offset - json.length)
        const bytes = textEncoder.encode(text)
        const stream = instrumentedBody({ chunks: [bytes.subarray(0, limit - 1), bytes.subarray(limit - 1)] })
        const response = await makeHandler({ actionCache, contentStore })(rawRequest(path, {
          method,
          headers: {
            "content-type": "application/json",
            ...(declared ? { "content-length": String(bytes.byteLength) } : {})
          },
          body: stream.body
        }))
        expect(response.status).toBe(offset > 0 ? 413 : status)
        if (method === "PUT") expect(await actionCache.get(keyDigest)).toBe(offset > 0 ? null : text)
        else if (offset <= 0) expect(await response.json()).toEqual({ missing: [] })
        if (offset > 0) {
          expect(stream.log).toEqual(declared ? ["body-cancel"] : ["get-reader", "reader-cancel", "release"])
        }
      })
    })
  })

  /**
   * A document without an envelope is its own discriminator, so D1 stores it
   * twice in one row. A compact document near the body bound therefore makes
   * a row past D1's row limit, which D1 refuses at insert time and the client
   * would see as a `503`. The protocol has to refuse it first, as a `413`.
   */
  it.each([0, 1])("pins the stored row bytes of an unenveloped document at the largest fit plus %i", async (extra) => {
    // The row holds the key, the body, and the canonical body, which for a
    // compact document is the body again.
    const largestFit = Math.floor((maxActionCacheRowBytes - keyDigest.length) / 2)
    const document = `{"o":"${"x".repeat(largestFit + extra - 8)}"}`
    expect(document.length).toBe(largestFit + extra)
    expect(document.length).toBeLessThanOrEqual(maxActionCacheBodyBytes)
    const actionCache = new MemoryActionCache()
    const response = await makeHandler({ actionCache })(jsonRequest(`/ac/${keyDigest}`, document, { method: "PUT" }))
    expect(response.status).toBe(extra === 0 ? 201 : 413)
    expect(actionCache.entries.has(keyDigest)).toBe(extra === 0)
  })

  it("keeps every row the protocol admits under D1's row limit", () => {
    // The reserve covers the fixed-width columns and the record header.
    expect(maxActionCacheRowBytes).toBeLessThan(maxD1RowBytes)
    expect(maxD1RowBytes - maxActionCacheRowBytes).toBeGreaterThanOrEqual(512)
    // A body at its own bound can still make an oversized row, enveloped or
    // not, because the discriminator is stored beside it.
    expect(maxKeyDigestLength + 2 * maxActionCacheBodyBytes).toBeGreaterThan(maxActionCacheRowBytes)
  })

  it("refuses an enveloped publication whose result makes the row too large", async () => {
    const actionCache = new MemoryActionCache()
    const result = { output: "x".repeat(maxActionCacheBodyBytes - 128) }
    const body = JSON.stringify({ keyDigest, result })
    expect(body.length).toBeLessThanOrEqual(maxActionCacheBodyBytes)
    const response = await makeHandler({ actionCache })(jsonRequest(`/ac/${keyDigest}`, body, { method: "PUT" }))
    expect(response.status).toBe(413)
    expect(actionCache.entries.size).toBe(0)
  })

  it.each(boundaryOffsets)("pins stored action-cache body bytes at limit offset %i", async (offset) => {
    const actionCache = new MemoryActionCache()
    const body = JSON.stringify(boundedText(maxActionCacheBodyBytes + offset - 2, true))
    await actionCache.put(keyDigest, {
      body,
      resultJson: body,
      createdAtMs: null,
      recordedRunId: null,
      recordedEventSeq: null
    })
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const response = await makeHandler({ actionCache })(request(`/ac/${keyDigest}`))
      expect(response.status).toBe(offset > 0 ? 503 : 200)
      if (offset <= 0) expect(await response.text()).toBe(body)
    } finally {
      errors.mockRestore()
    }
  })

  it.each(boundaryOffsets)("pins body chunk count at limit offset %i", async (offset) => {
    const stream = instrumentedBody({
      chunks: [
        textEncoder.encode("{}"),
        ...Array.from({ length: maxBodyChunks + offset - 1 }, () => new Uint8Array())
      ]
    })
    const actionCache = new MemoryActionCache()
    const response = await makeHandler({ actionCache })(rawRequest(`/ac/${keyDigest}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: stream.body
    }))
    expect(response.status).toBe(offset > 0 ? 413 : 201)
    expect(await actionCache.get(keyDigest)).toBe(offset > 0 ? null : "{}")
    expect(stream.log).toEqual(offset > 0 ? ["get-reader", "reader-cancel", "release"] : ["get-reader", "release"])
  })

  it.each([0, 1, 2])("pins identifier lower bounds at %i bytes", async (bytes) => {
    const value = "x".repeat(bytes)
    expect(invalidKeyDigest(value)).toBe(bytes === 0 ? "empty keyDigest" : null)
    const actionCache = new MemoryActionCache()
    const legacy = { body: "{}", resultJson: "{}", createdAtMs: null, recordedRunId: value, recordedEventSeq: 0 }
    await actionCache.put(keyDigest, legacy)
    const handler = makeHandler({ actionCache })
    const publication = await handler(jsonRequest(`/ac/${keyDigest}`, {
      keyDigest,
      result: {},
      recordedRunId: value,
      recordedEventSeq: 0
    }, { method: "PUT" }))
    expect(publication.status).toBe(bytes === 0 ? 400 : 422)
    const deletion = await handler(
      request(`/ac/${keyDigest}?recordedRunId=${value}&recordedEventSeq=0`, { method: "DELETE" })
    )
    expect(deletion.status).toBe(bytes === 0 ? 400 : 200)
    expect(actionCache.entries.get(keyDigest)).toEqual(bytes === 0 ? legacy : undefined)
  })

  describe.each(["createdAtMs", "recordedEventSeq"] as const)("%s integer boundaries", (field) => {
    it.each([-1, 0, 1, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
      "pins %i",
      async (value) => {
        const accepted = value >= 0 && value <= Number.MAX_SAFE_INTEGER
        const actionCache = new MemoryActionCache()
        const handler = makeHandler({ actionCache })
        const body = JSON.stringify({
          keyDigest,
          result: {},
          [field]: value,
          ...(field === "recordedEventSeq" ? { recordedRunId: "run" } : {})
        })
        const response = await handler(jsonRequest(`/ac/${keyDigest}`, body, { method: "PUT" }))
        expect(response.status).toBe(accepted ? (field === "createdAtMs" ? 201 : 422) : 400)
        expect(await actionCache.get(keyDigest)).toBe(accepted && field === "createdAtMs" ? body : null)
        if (field === "recordedEventSeq") {
          const legacy = {
            body: "{}",
            resultJson: "{}",
            createdAtMs: null,
            recordedRunId: "run",
            recordedEventSeq: value
          }
          await actionCache.put(keyDigest, legacy)
          const deletion = await handler(
            request(`/ac/${keyDigest}?recordedRunId=run&recordedEventSeq=${value}`, { method: "DELETE" })
          )
          expect(deletion.status).toBe(accepted ? 200 : 400)
          expect(actionCache.entries.get(keyDigest)).toEqual(accepted ? undefined : legacy)
        }
      }
    )
  })
})
