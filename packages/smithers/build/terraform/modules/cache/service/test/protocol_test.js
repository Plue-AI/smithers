/*
 * Protocol tests, run by `bun test`, against a fake storage boundary.
 *
 * Nothing here opens a listener or a database: createHandler takes its storage
 * as an argument, so every status this file asserts is decided by the protocol
 * alone.
 *
 * The file is named `_test.js` rather than `.test.js` because the repository's
 * vitest suite collects `*.test.*` and this suite is Bun's.
 */
import { describe, expect, test } from "bun:test"
import {
  canonicalJson,
  createHandler,
  describeFailure,
  maxBodyChunks,
  maxCanonicalJsonBytes,
  maxConcurrentActionCachePublications,
  maxConcurrentArtifactTransfers,
  maxConcurrentCacheRequests,
  maxConcurrentFindMissingRequests,
  maxFindMissingDigests,
  maxJsonDepth,
  maxJsonMembers,
  maxReferencedDigests
} from "../protocol.js"

import { createStorage } from "../storage.js"

const readToken = "read-token-with-sufficient-entropy-for-unit-tests"
const writeToken = "write-token-with-sufficient-entropy-for-unit-tests"
const readTokenHash = new Bun.CryptoHasher("sha256").update(readToken, "utf8").digest("hex")
const writeTokenHash = new Bun.CryptoHasher("sha256").update(writeToken, "utf8").digest("hex")
const keyDigest = "a".repeat(64)

const digestOf = (text) => new Bun.CryptoHasher("sha256").update(text, "utf8").digest("hex")

/** An in-memory action cache with the same outcome vocabulary as the SQL one. */
const memoryActionCache = () => {
  const entries = new Map()
  return {
    entries,
    get: async (key) => entries.get(key)?.body ?? null,
    put: async (key, publication) => {
      const stored = entries.get(key)
      if (stored === undefined) {
        entries.set(key, publication)
        return "inserted"
      }
      return stored.resultJson === publication.resultJson ? "identical" : "conflict"
    },
    delete: async (key, fence) => {
      const stored = entries.get(key)
      if (stored === undefined) return false
      if (
        fence !== null &&
        (stored.recordedRunId !== fence.runId || stored.recordedEventSeq !== fence.eventSeq)
      ) {
        return false
      }
      return entries.delete(key)
    }
  }
}

const memoryContentStore = () => {
  const objects = new Map()
  return {
    objects,
    has: async (digest) => objects.has(digest),
    get: async (digest) => (objects.has(digest) ? { body: objects.get(digest) } : null),
    put: async (digest, bytes) => {
      if (objects.has(digest)) return "present"
      objects.set(digest, new Uint8Array(bytes))
      return "inserted"
    },
    presentDigests: async (digests) => new Set(digests.filter((digest) => objects.has(digest)))
  }
}

const failingStorage = () => {
  const fail = async () => {
    throw new Error("the connection is gone")
  }
  return {
    actionCache: { get: fail, put: fail, delete: fail },
    contentStore: { get: fail, has: fail, put: fail, presentDigests: fail }
  }
}

const makeHandler = (overrides = {}, deadlines = {}) =>
  createHandler({
    actionCache: overrides.actionCache ?? memoryActionCache(),
    contentStore: overrides.contentStore ?? memoryContentStore(),
    health: overrides.health,
    readTokenHash: Object.hasOwn(overrides, "readTokenHash") ? overrides.readTokenHash : readTokenHash,
    writeTokenHash: Object.hasOwn(overrides, "writeTokenHash") ? overrides.writeTokenHash : writeTokenHash,
    maxArtifactBytes: overrides.maxArtifactBytes ?? 1024
  }, deadlines)

const requestAs = (credential, path, init = {}) => {
  const headers = new Headers(init.headers)
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${credential}`)
  return new Request(`http://cache.test${path}`, { ...init, headers })
}

const request = (path, init = {}) => requestAs(writeToken, path, init)
const readRequest = (path, init = {}) => requestAs(readToken, path, init)

test("a scoped read credential cannot fetch another action-cache namespace", async () => {
  const actionCache = memoryActionCache()
  const handler = createHandler({
    actionCache,
    contentStore: memoryContentStore(),
    readTokenHash,
    readNamespacePrefix: "pr-1/",
    writeTokenHash,
    maxArtifactBytes: 1024
  })
  for (const namespace of ["pr-1/", "main/", "pr-2/", "pr-10/"]) {
    const key = namespace + keyDigest
    expect(
      (await handler(
        jsonRequest(`/ac/${encodeURIComponent(key)}`, { keyDigest: key, result: { ok: true } }, { method: "PUT" })
      )).status
    ).toBe(201)
  }
  for (
    const [key, status] of [
      ["pr-1/" + keyDigest, 200],
      ["main/" + keyDigest, 403],
      ["pr-2/" + keyDigest, 403],
      ["pr-10/" + keyDigest, 403],
      [keyDigest, 403]
    ]
  ) {
    expect((await handler(readRequest(`/ac/${encodeURIComponent(key)}`))).status).toBe(status)
  }
  expect((await handler(readRequest(`/cas/${keyDigest}`))).status).toBe(403)
  expect(
    (await handler(readRequest("/cas/findMissing", { method: "POST", body: JSON.stringify({ digests: [] }) }))).status
  ).toBe(403)
})

/**
 * A request-shaped value the handler reads structurally.
 *
 * `Request` starts pumping a stream body as soon as it is constructed, which
 * hides whether the handler refused before reading. This carries the same
 * members the handler touches and nothing pulls the stream but the handler.
 */
const rawRequest = (path, { method = "GET", headers = {}, body = null } = {}) => ({
  url: `http://cache.test${path}`,
  method,
  headers: new Headers({ authorization: `Bearer ${writeToken}`, ...headers }),
  body
})

const jsonRequest = (path, body, init = {}) =>
  request(path, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  })

/** A body with no declared length, delivered in chunks. */
const chunked = (chunks) =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })

/**
 * A body whose reader records every acquisition, cancellation, and release.
 *
 * The handler must cancel what it will not read and release what it acquired,
 * on every exit. A real `ReadableStream` reports only that it ended up
 * unlocked, so the ordering is asserted against this instead, and each failure
 * mode is injected rather than waited for.
 */
const instrumentedBody = (
  { chunks = [], failRead = false, failCancel = false, failRelease = false } = {}
) => {
  const log = []
  let index = 0
  const body = {
    cancel: async () => {
      log.push("body-cancel")
      if (failCancel) throw new Error("the sender is gone")
    },
    getReader: () => {
      log.push("get-reader")
      return {
        read: async () => {
          if (failRead) {
            log.push("read-failed")
            throw Object.assign(new Error("connection reset by peer"), { code: "ECONNRESET" })
          }
          if (index >= chunks.length) return { done: true, value: undefined }
          index += 1
          return { done: false, value: chunks[index - 1] }
        },
        cancel: async () => {
          log.push("reader-cancel")
          if (failCancel) throw new Error("the sender is gone")
        },
        releaseLock: () => {
          log.push("release")
          if (failRelease) throw new Error("the reader is wedged")
        }
      }
    }
  }
  return { body, log }
}

/** Runs `body` with console.error captured, and returns what it logged. */
const captureErrors = async (body) => {
  const lines = []
  const original = console.error
  console.error = (...parts) => lines.push(parts)
  try {
    return { value: await body(), lines }
  } finally {
    console.error = original
  }
}

const envelope = {
  keyDigest,
  result: { key: keyDigest, rule: "install", label: "//:install", exitOk: true, output: null },
  meta: { rule: "install" },
  createdAtMs: 1_700_000_000_000,
  recordedRunId: "run-1",
  recordedEventSeq: 7
}

const cachedResult = {
  key: keyDigest,
  rule: "install",
  label: "//:install",
  exitOk: true,
  output: { packages: 12 },
  storedAt: "2026-08-14T00:00:00.000Z"
}

describe("authentication", () => {
  test("refuses every cache route without a token and reveals nothing", async () => {
    const handler = makeHandler()
    const anonymous = await handler(new Request(`http://cache.test/ac/${keyDigest}`))
    const wrong = await handler(
      new Request(`http://cache.test/ac/${keyDigest}`, { headers: { authorization: `Bearer ${writeToken}x` } })
    )
    const prefix = await handler(
      new Request(`http://cache.test/ac/${keyDigest}`, { headers: { authorization: writeToken } })
    )

    expect(anonymous.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(prefix.status).toBe(401)
    expect(await wrong.text()).toBe("")
    expect(wrong.headers.get("www-authenticate")).toBe("Bearer realm=\"smithers-build-cache\"")
  })

  test("answers the container healthcheck without a token", async () => {
    const handler = makeHandler()
    const health = await handler(new Request("http://cache.test/healthz"))
    const wrongMethod = await handler(new Request("http://cache.test/healthz", { method: "POST" }))

    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })
    expect(wrongMethod.status).toBe(405)
  })

  test("makes health a storage readiness check and keeps HEAD bodyless", async () => {
    const unavailable = makeHandler({
      health: async () => {
        throw new Error("database unavailable")
      }
    })
    const { value: failed, lines } = await captureErrors(() => unavailable(new Request("http://cache.test/healthz")))
    const ready = makeHandler({ health: async () => true })
    const head = await ready(new Request("http://cache.test/healthz", { method: "HEAD" }))

    expect(failed.status).toBe(503)
    expect(lines).toHaveLength(1)
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
  })

  test("coalesces concurrent and immediately repeated readiness probes", async () => {
    let checks = 0
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const handler = makeHandler({
      health: async () => {
        checks += 1
        await gate
      }
    })
    const probes = Array.from({ length: 20 }, () => handler(new Request("http://cache.test/healthz")))
    while (checks === 0) await Promise.resolve()
    expect(checks).toBe(1)
    release()
    expect((await Promise.all(probes)).every((response) => response.status === 200)).toBe(true)
    expect((await handler(new Request("http://cache.test/healthz"))).status).toBe(200)
    expect(checks).toBe(1)
  })

  test("accepts an unauthenticated request in the documented development mode", async () => {
    const handler = makeHandler({ readTokenHash: null, writeTokenHash: null })
    const response = await handler(new Request(`http://cache.test/ac/${keyDigest}`))
    expect(response.status).toBe(404)
  })

  test("refuses to construct a handler without two valid token hashes outside development mode", () => {
    expect(() => makeHandler({ readTokenHash: "not-a-digest" })).toThrow("readTokenHash")
    expect(() => makeHandler({ writeTokenHash: "not-a-digest" })).toThrow("writeTokenHash")
    expect(() => makeHandler({ readTokenHash: null })).toThrow("both be digests or both be null")
    expect(() => makeHandler({ writeTokenHash: null })).toThrow("both be digests or both be null")
    // Equal digests are one credential under two names, and the classifier
    // answers "write" for it, so admitting the pair would hand publication to
    // every holder of the nominal read credential.
    expect(() => makeHandler({ writeTokenHash: readTokenHash })).toThrow("must differ")
  })

  test("matches the bearer scheme the way RFC 9110 defines it", async () => {
    const handler = makeHandler()
    const lowercase = await handler(
      new Request(`http://cache.test/ac/${keyDigest}`, { headers: { authorization: `bearer ${writeToken}` } })
    )
    const padded = await handler(
      new Request(`http://cache.test/ac/${keyDigest}`, { headers: { authorization: `Bearer   ${writeToken}` } })
    )
    const other = await handler(
      new Request(`http://cache.test/ac/${keyDigest}`, { headers: { authorization: `Basic ${writeToken}` } })
    )

    expect(lowercase.status).toBe(404)
    expect(padded.status).toBe(404)
    expect(other.status).toBe(401)
  })

  test("never reflects the authorization header", async () => {
    const handler = makeHandler()
    const response = await handler(request(`/ac/${keyDigest}`))
    const serialized = JSON.stringify([...response.headers.entries()])
    expect(serialized).not.toContain(writeToken)
  })

  test("cancels an unauthorized request body without reading it", async () => {
    const streamed = instrumentedBody({ chunks: [new Uint8Array([1])] })
    const response = await makeHandler()(rawRequest(`/cas/${keyDigest}`, {
      method: "PUT",
      headers: { authorization: "Bearer wrong", "content-type": "application/octet-stream" },
      body: streamed.body
    }))
    expect(response.status).toBe(401)
    expect(streamed.log).toEqual(["body-cancel"])
  })

  test("does not wait forever for a sender's cancellation", async () => {
    const body = { cancel: () => new Promise(() => undefined) }
    const response = await makeHandler()(rawRequest(`/ac/${keyDigest}`, {
      headers: { authorization: "Bearer wrong" },
      body
    }))
    expect(response.status).toBe(401)
  })

  test("lets the read credential GET and HEAD but refuses every PUT and DELETE with 403", async () => {
    const actionCache = memoryActionCache()
    const contentStore = memoryContentStore()
    const bytes = new TextEncoder().encode("readable artifact")
    const digest = digestOf("readable artifact")
    actionCache.entries.set(keyDigest, { ...envelope, body: JSON.stringify(envelope), resultJson: "{}" })
    contentStore.objects.set(digest, bytes)
    const handler = makeHandler({ actionCache, contentStore })

    const readEntry = await handler(readRequest(`/ac/${keyDigest}`))
    const readArtifact = await handler(readRequest(`/cas/${digest}`))
    const headArtifact = await handler(readRequest(`/cas/${digest}`, { method: "HEAD" }))
    expect(readEntry.status).toBe(200)
    expect(readArtifact.status).toBe(200)
    expect(await readArtifact.text()).toBe("readable artifact")
    expect(headArtifact.status).toBe(200)

    const cases = [
      readRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope)
      }),
      readRequest(`/ac/${keyDigest}`, { method: "DELETE" }),
      readRequest(`/cas/${digest}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      }),
      readRequest(`/cas/${digest}`, { method: "DELETE" })
    ]
    for (const refused of cases) {
      const response = await handler(refused)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: "this credential may read the cache but not publish to it" })
    }
    expect(actionCache.entries.has(keyDigest)).toBe(true)
  })

  test("refuses a read credential before reading a publication body", async () => {
    const streamed = instrumentedBody({ chunks: [new TextEncoder().encode(JSON.stringify(envelope))] })
    const response = await makeHandler()(rawRequest(`/ac/${keyDigest}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${readToken}`, "content-type": "application/json" },
      body: streamed.body
    }))
    expect(response.status).toBe(403)
    expect(streamed.log).toEqual(["body-cancel"])
  })

  test("lets the write credential read, publish, and delete", async () => {
    const handler = makeHandler()
    const bytes = new TextEncoder().encode("writeable artifact")
    const digest = digestOf("writeable artifact")
    expect((await handler(jsonRequest(`/ac/${keyDigest}`, envelope, { method: "PUT" }))).status).toBe(201)
    expect((await handler(request(`/ac/${keyDigest}`))).status).toBe(200)
    expect(
      (await handler(request(`/cas/${digest}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      }))).status
    ).toBe(201)
    expect((await handler(request(`/cas/${digest}`, { method: "HEAD" }))).status).toBe(200)
    const fetched = await handler(request(`/cas/${digest}`))
    expect(fetched.status).toBe(200)
    expect(await fetched.text()).toBe("writeable artifact")
    expect((await handler(request(`/ac/${keyDigest}`, { method: "DELETE" }))).status).toBe(200)
  })
})

describe("action-cache publication", () => {
  test("accepts the CacheEntry envelope and returns it verbatim", async () => {
    const handler = makeHandler()
    const body = JSON.stringify(envelope)
    const put = await handler(jsonRequest(`/ac/${keyDigest}`, body, { method: "PUT" }))
    const get = await handler(request(`/ac/${keyDigest}`))

    expect(put.status).toBe(201)
    expect(await put.json()).toEqual({ keyDigest })
    expect(get.status).toBe(200)
    expect(get.headers.get("content-type")).toBe("application/json")
    expect(await get.text()).toBe(body)
  })

  test("accepts the CLI CachedResult document with no envelope", async () => {
    const handler = makeHandler()
    const body = JSON.stringify(cachedResult)
    const put = await handler(jsonRequest(`/ac/${keyDigest}`, body, { method: "PUT" }))
    const get = await handler(request(`/ac/${keyDigest}`))

    expect(put.status).toBe(201)
    expect(await get.text()).toBe(body)
  })

  test("does not reinterpret a bare result member as a CacheEntry envelope", async () => {
    const actionCache = memoryActionCache()
    const handler = makeHandler({ actionCache })
    const bare = { result: { nested: true }, status: "ok" }
    expect((await handler(jsonRequest(`/ac/${keyDigest}`, bare, { method: "PUT" }))).status).toBe(201)
    expect(actionCache.entries.get(keyDigest).resultJson).toBe(canonicalJson(bare))
    expect(actionCache.entries.get(keyDigest).digests).toEqual([])
  })

  test("treats a re-publication with reordered members as identical", async () => {
    const handler = makeHandler()
    const first = await handler(jsonRequest(`/ac/${keyDigest}`, envelope, { method: "PUT" }))
    const reordered = await handler(
      jsonRequest(`/ac/${keyDigest}`, {
        recordedEventSeq: 7,
        recordedRunId: "run-1",
        createdAtMs: 1_700_000_000_000,
        meta: { rule: "install" },
        result: { output: null, exitOk: true, label: "//:install", rule: "install", key: keyDigest },
        keyDigest
      }, { method: "PUT" })
    )

    expect(first.status).toBe(201)
    expect(reordered.status).toBe(200)
    expect(await reordered.text()).toBe("")
  })

  test("reports a different result under one key as a conflict", async () => {
    const handler = makeHandler()
    await handler(jsonRequest(`/ac/${keyDigest}`, envelope, { method: "PUT" }))
    const conflicting = await handler(
      jsonRequest(`/ac/${keyDigest}`, { ...envelope, result: { ...envelope.result, exitOk: false } }, {
        method: "PUT"
      })
    )
    expect(conflicting.status).toBe(409)
  })

  test("compares the whole document when there is no result member", async () => {
    const handler = makeHandler()
    await handler(jsonRequest(`/ac/${keyDigest}`, cachedResult, { method: "PUT" }))
    const same = await handler(
      jsonRequest(`/ac/${keyDigest}`, { storedAt: cachedResult.storedAt, ...cachedResult }, { method: "PUT" })
    )
    const different = await handler(
      jsonRequest(`/ac/${keyDigest}`, { ...cachedResult, exitOk: false }, { method: "PUT" })
    )

    expect(same.status).toBe(200)
    expect(different.status).toBe(409)
  })

  test("refuses an envelope filed under another key", async () => {
    const handler = makeHandler()
    const response = await handler(
      jsonRequest(`/ac/${keyDigest}`, { ...envelope, keyDigest: "b".repeat(64) }, { method: "PUT" })
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain("keyDigest")
  })

  test("records valid provenance and rejects malformed or half-supplied fences", async () => {
    const actionCache = memoryActionCache()
    const handler = makeHandler({ actionCache })
    await handler(jsonRequest("/ac/paired", { ...envelope, keyDigest: "paired" }, { method: "PUT" }))
    const negative = await handler(
      jsonRequest("/ac/half", { ...envelope, keyDigest: "half", recordedEventSeq: -1 }, { method: "PUT" })
    )
    const blank = await handler(
      jsonRequest("/ac/blank", { ...envelope, keyDigest: "blank", recordedRunId: "" }, { method: "PUT" })
    )
    const malformedText = await handler(
      jsonRequest("/ac/malformed-text", {
        ...envelope,
        keyDigest: "malformed-text",
        recordedRunId: "\ud800"
      }, { method: "PUT" })
    )
    const half = { ...envelope, keyDigest: "missing-half" }
    delete half.recordedEventSeq
    const missing = await handler(jsonRequest("/ac/missing-half", half, { method: "PUT" }))

    expect(actionCache.entries.get("paired").recordedRunId).toBe("run-1")
    expect(actionCache.entries.get("paired").recordedEventSeq).toBe(7)
    expect([negative.status, blank.status, malformedText.status, missing.status]).toEqual([400, 400, 400, 400])
    expect(actionCache.entries.has("half")).toBe(false)
    expect(actionCache.entries.has("blank")).toBe(false)
    expect(actionCache.entries.has("malformed-text")).toBe(false)
    expect(actionCache.entries.has("missing-half")).toBe(false)
  })

  test("records only exact declared-output artifact references", async () => {
    const actionCache = memoryActionCache()
    const handler = makeHandler({ actionCache })
    const blob = "c".repeat(64)
    const incidental = "d".repeat(64)
    await handler(
      jsonRequest(`/ac/${keyDigest}`, {
        ...envelope,
        result: { ...envelope.result, log: incidental },
        meta: {
          artifact: incidental,
          boundary: {
            declaredOutputs: {
              outputs: [
                { digest: blob },
                { digest: blob },
                { digest: incidental, content: "inline" },
                { path: "no-digest" }
              ]
            }
          }
        }
      }, {
        method: "PUT"
      })
    )
    expect(actionCache.entries.get(keyDigest).digests).toEqual([blob])
  })

  test("rejects too many declared references instead of silently truncating them", async () => {
    const actionCache = memoryActionCache()
    const handler = makeHandler({ actionCache })
    const outputs = Array.from({ length: maxReferencedDigests + 1 }, (_, index) => ({
      digest: digestOf(`blob-${index}`)
    }))
    const response = await handler(jsonRequest(`/ac/${keyDigest}`, {
      ...envelope,
      meta: { boundary: { declaredOutputs: { outputs } } }
    }, { method: "PUT" }))
    expect(response.status).toBe(400)
    expect(actionCache.entries.has(keyDigest)).toBe(false)
  })

  test("rejects malformed declared output metadata", async () => {
    const handler = makeHandler()
    for (const outputs of ["not-an-array", [null], [{ digest: "not-a-digest" }]]) {
      const response = await handler(jsonRequest(`/ac/${keyDigest}`, {
        ...envelope,
        meta: { boundary: { declaredOutputs: { outputs } } }
      }, { method: "PUT" }))
      expect(response.status).toBe(400)
    }
  })
})

describe("action-cache request bounds", () => {
  test("refuses a chunked body past the one-mebibyte bound before buffering it", async () => {
    const handler = makeHandler()
    const chunk = new Uint8Array(64 * 1024)
    chunk.fill(0x20)
    const response = await handler(
      request(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: chunked(Array.from({ length: 64 }, () => chunk)),
        duplex: "half"
      })
    )
    expect(response.status).toBe(413)
  })

  test("refuses a body that outgrows a small declared content-length", async () => {
    const handler = makeHandler()
    const chunk = new Uint8Array(256 * 1024)
    chunk.fill(0x20)
    const response = await handler(
      request(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "content-length": "2" },
        body: chunked(Array.from({ length: 8 }, () => chunk)),
        duplex: "half"
      })
    )
    expect(response.status).toBe(400)
  })

  test("refuses a malformed content-length", async () => {
    const handler = makeHandler()
    // Header values arrive with their optional whitespace already trimmed, so
    // the syntax that has to be refused is what survives that.
    for (const declared of ["abc", "-1", "1e6", "12.0", "0x10", "1_0", "+1", ""]) {
      const response = await handler(
        rawRequest(`/ac/${keyDigest}`, {
          method: "PUT",
          headers: { "content-type": "application/json", "content-length": declared },
          body: chunked([new TextEncoder().encode("{}")])
        })
      )
      expect(response.status).toBe(400)
    }
  })

  test("refuses a declared length past the bound without reading the body", async () => {
    const handler = makeHandler()
    let read = false
    const response = await handler(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "content-length": "1048577" },
        body: {
          getReader() {
            read = true
            throw new Error("the refused body must not be read")
          }
        }
      })
    )
    expect(response.status).toBe(413)
    expect(read).toBe(false)
  })

  test("cancels the reader of a body it refuses", async () => {
    const handler = makeHandler()
    let cancelled = false
    const chunk = new Uint8Array(512 * 1024)
    const response = await handler(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: new ReadableStream({
          pull(controller) {
            controller.enqueue(chunk)
          },
          cancel() {
            cancelled = true
          }
        })
      })
    )
    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
  })

  test("requires a JSON content type and accepts the structured suffix", async () => {
    const handler = makeHandler()
    const octet = await handler(
      request(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: JSON.stringify(envelope)
      })
    )
    const none = await handler(request(`/ac/${keyDigest}`, { method: "PUT", body: JSON.stringify(envelope) }))
    const suffixed = await handler(
      request(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/vnd.smithers-build+json; charset=utf-8" },
        body: JSON.stringify(envelope)
      })
    )
    const whitespace = await handler(
      request(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/vnd.smithers build+json; charset=utf-8" },
        body: JSON.stringify(envelope)
      })
    )

    expect(octet.status).toBe(415)
    expect(none.status).toBe(415)
    expect(suffixed.status).toBe(201)
    expect(whitespace.status).toBe(415)
  })

  test("refuses a body that is not UTF-8 and a body that is not JSON", async () => {
    const handler = makeHandler()
    const invalidUtf8 = await handler(
      request(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])
      })
    )
    const invalidJson = await handler(jsonRequest(`/ac/${keyDigest}`, "{not json", { method: "PUT" }))

    expect(invalidUtf8.status).toBe(400)
    expect((await invalidUtf8.json()).error).toContain("UTF-8")
    expect(invalidJson.status).toBe(400)
  })

  test("refuses a JSON value it could not render canonically", async () => {
    const handler = makeHandler()
    const response = await handler(jsonRequest(`/ac/${keyDigest}`, "1e400", { method: "PUT" }))
    expect(response.status).toBe(400)
  })

  test("rejects negative zero and documents beyond the structural depth limit", async () => {
    const handler = makeHandler()
    const negativeZero = await handler(jsonRequest(`/ac/${keyDigest}`, `{"result":-0}`, { method: "PUT" }))
    const nested = `${"[".repeat(maxJsonDepth + 1)}0${"]".repeat(maxJsonDepth + 1)}`
    const tooDeep = await handler(jsonRequest(`/ac/${keyDigest}`, nested, { method: "PUT" }))

    expect(negativeZero.status).toBe(400)
    expect(tooDeep.status).toBe(400)
  })

  test("refuses JSON whose parse is not reversible", async () => {
    const handler = makeHandler()
    // JSON.parse keeps only the last member, so two divergent results would
    // compare identical and answer 200 where 409 is promised.
    const duplicate = await handler(
      jsonRequest(`/ac/${keyDigest}`, `{"keyDigest":"${keyDigest}","result":{"a":1,"a":2}}`, { method: "PUT" })
    )
    const imprecise = await handler(
      jsonRequest(`/ac/${keyDigest}`, `{"keyDigest":"${keyDigest}","result":{"n":9007199254740993}}`, {
        method: "PUT"
      })
    )
    const accepted = await handler(
      jsonRequest(`/ac/${keyDigest}`, { keyDigest, result: { n: 9007199254740992, e: 1e21 } }, { method: "PUT" })
    )

    expect(duplicate.status).toBe(400)
    await expect(duplicate.json()).resolves.toEqual({ error: "body contains a duplicate object member name" })
    expect(imprecise.status).toBe(400)
    await expect(imprecise.json()).resolves.toEqual({
      error: "body contains a JSON number that does not round-trip through a double"
    })
    expect(accepted.status).toBe(201)
  })

  test("does not confuse a member name inside a string with a duplicate", async () => {
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

  test("bounds both empty and non-empty stream chunks", async () => {
    const handler = makeHandler()
    const oneByte = new Uint8Array([0x20])
    const nonEmpty = await handler(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: chunked(Array.from({ length: maxBodyChunks + 1 }, () => oneByte))
      })
    )
    const emptyBody = instrumentedBody({
      chunks: Array.from({ length: maxBodyChunks + 1 }, () => new Uint8Array())
    })
    const empty = await handler(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: emptyBody.body
      })
    )
    expect(nonEmpty.status).toBe(413)
    expect(empty.status).toBe(413)
  })

  test("refuses a document nested past the stack rather than failing the tier", async () => {
    const handler = makeHandler()
    const deep = `${"[".repeat(60_000)}1${"]".repeat(60_000)}`
    const response = await handler(jsonRequest(`/ac/${keyDigest}`, deep, { method: "PUT" }))
    expect([400, 413]).toContain(response.status)
  })

  test("keeps a document Postgres text cannot hold characters for intact", async () => {
    const actionCache = memoryActionCache()
    const handler = makeHandler({ actionCache })
    // An escaped NUL and a lone surrogate are legal JSON, and both must survive
    // as the escapes they arrived as: the stored text has to stay text.
    const body = `{"keyDigest":"${keyDigest}","result":{"a":"\\u0000\\ud800","b":"\\n"}}`
    const put = await handler(jsonRequest(`/ac/${keyDigest}`, body, { method: "PUT" }))
    const stored = actionCache.entries.get(keyDigest)

    expect(put.status).toBe(201)
    expect(stored.body).toBe(body)
    expect(stored.resultJson).toBe(`{"a":"\\u0000\\ud800","b":"\\n"}`)
    expect(/[\u0000-\u001f\ud800-\udfff]/.test(stored.resultJson)).toBe(false)
  })
})

describe("action-cache keys and deletion", () => {
  test("refuses malformed percent-encoding as client input", async () => {
    const handler = makeHandler()
    const entry = await handler(request("/ac/%E0%A4%A"))
    const artifact = await handler(request("/cas/%zz"))

    expect(entry.status).toBe(400)
    expect(artifact.status).toBe(400)
  })

  test("accepts the keys the real clients send", async () => {
    const handler = makeHandler()
    for (const key of [keyDigest, "//packages/smithers:test", "install-rule.cache-key", "a".repeat(512)]) {
      const response = await handler(request(`/ac/${encodeURIComponent(key)}`))
      expect(response.status).toBe(404)
    }
  })

  test("refuses an empty, oversized, or control-bearing key", async () => {
    const handler = makeHandler()
    const empty = await handler(request("/ac/%20", { method: "GET" }))
    const long = await handler(request(`/ac/${"a".repeat(513)}`))
    const control = await handler(request("/ac/%00"))
    const newline = await handler(request("/ac/a%0Ab"))

    expect(empty.status).toBe(404)
    expect(long.status).toBe(400)
    expect(control.status).toBe(400)
    expect(newline.status).toBe(400)
  })

  test("applies key and deletion-fence bounds in UTF-8 bytes", async () => {
    const handler = makeHandler()
    const atBound = "😀".repeat(128)
    const overBound = "😀".repeat(129)
    expect((await handler(request(`/ac/${encodeURIComponent(atBound)}`))).status).toBe(404)
    expect((await handler(request(`/ac/${encodeURIComponent(overBound)}`))).status).toBe(400)

    await handler(jsonRequest(`/ac/${keyDigest}`, envelope, { method: "PUT" }))
    const fenced = await handler(request(
      `/ac/${keyDigest}?recordedRunId=${encodeURIComponent(overBound)}&recordedEventSeq=7`,
      { method: "DELETE" }
    ))
    expect(fenced.status).toBe(400)
  })

  test("refuses a truly empty key", async () => {
    const handler = makeHandler()
    const response = await handler(request("/ac//"))
    expect(response.status).toBe(404)
  })

  test("deletes with and without a fence", async () => {
    const handler = makeHandler()
    await handler(jsonRequest(`/ac/${keyDigest}`, envelope, { method: "PUT" }))
    const wrongFence = await handler(
      request(`/ac/${keyDigest}?recordedRunId=run-2&recordedEventSeq=7`, { method: "DELETE" })
    )
    const rightFence = await handler(
      request(`/ac/${keyDigest}?recordedRunId=run-1&recordedEventSeq=7`, { method: "DELETE" })
    )
    const gone = await handler(request(`/ac/${keyDigest}`, { method: "DELETE" }))

    expect(wrongFence.status).toBe(404)
    expect(rightFence.status).toBe(200)
    expect(gone.status).toBe(404)
  })

  test("refuses a half or malformed fence rather than deleting unfenced", async () => {
    const actionCache = memoryActionCache()
    const handler = makeHandler({ actionCache })
    await handler(jsonRequest(`/ac/${keyDigest}`, envelope, { method: "PUT" }))
    const cases = [
      `/ac/${keyDigest}?recordedRunId=run-1`,
      `/ac/${keyDigest}?recordedEventSeq=7`,
      `/ac/${keyDigest}?recordedRunId=&recordedEventSeq=7`,
      `/ac/${keyDigest}?recordedRunId=run-1&recordedEventSeq=-1`,
      `/ac/${keyDigest}?recordedRunId=run-1&recordedEventSeq=1.5`,
      `/ac/${keyDigest}?recordedRunId=run-1&recordedEventSeq=abc`,
      `/ac/${keyDigest}?recordedRunId=run-1&recordedEventSeq=9007199254740993`,
      `/ac/${keyDigest}?recordedRunId=${"r".repeat(513)}&recordedEventSeq=7`,
      `/ac/${keyDigest}?recordedRunId=run-1&recordedRunId=run-2&recordedEventSeq=7`,
      `/ac/${keyDigest}?recordedRunId=run-1&recordedEventSeq=7&recordedEventSeq=8`
    ]
    for (const path of cases) {
      const response = await handler(request(path, { method: "DELETE" }))
      expect(response.status).toBe(400)
    }
    expect(actionCache.entries.has(keyDigest)).toBe(true)
  })

  test("refuses an unsupported method and names the ones the route accepts", async () => {
    const handler = makeHandler()
    const entry = await handler(request(`/ac/${keyDigest}`, { method: "PATCH" }))
    const artifact = await handler(request(`/cas/${keyDigest}`, { method: "PATCH" }))
    const findMissing = await handler(request("/cas/findMissing"))
    const health = await handler(new Request("http://cache.test/healthz", { method: "DELETE" }))
    const unknown = await handler(request("/nothing/here"))

    expect(entry.status).toBe(405)
    expect(entry.headers.get("allow")).toBe("GET, PUT, DELETE")
    expect(artifact.status).toBe(405)
    expect(artifact.headers.get("allow")).toBe("GET, HEAD, PUT")
    expect(findMissing.status).toBe(405)
    expect(findMissing.headers.get("allow")).toBe("POST")
    expect(health.status).toBe(405)
    expect(health.headers.get("allow")).toBe("GET, HEAD")
    expect(unknown.status).toBe(404)
  })
})

describe("content-addressed storage", () => {
  test("stores, probes, and serves a blob", async () => {
    const handler = makeHandler()
    const bytes = new TextEncoder().encode("artifact bytes")
    const digest = digestOf("artifact bytes")
    const put = await handler(
      request(`/cas/${digest}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
    const again = await handler(
      request(`/cas/${digest}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
    const head = await handler(request(`/cas/${digest}`, { method: "HEAD" }))
    const get = await handler(request(`/cas/${digest}`))
    const missing = await handler(request(`/cas/${"d".repeat(64)}`))

    expect(put.status).toBe(201)
    expect(again.status).toBe(200)
    expect(head.status).toBe(200)
    expect(get.status).toBe(200)
    expect(get.headers.get("content-type")).toBe("application/octet-stream")
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes)
    expect(missing.status).toBe(404)
  })

  test("refuses a ranged artifact upload so the client sends the blob whole", async () => {
    // `RemoteArtifacts.Options.chunkBytes` probes with an empty body under
    // `Content-Range: bytes */{total}` and reads a `400` as this service's
    // statement that it does not support partial PUT (RFC 9110 section 14.5),
    // falling back to one whole-blob `PUT`. The refusal is on the header, not
    // the digest: even a full matching body under `Content-Range` is refused.
    const contentStore = memoryContentStore()
    const handler = makeHandler({ contentStore })
    const bytes = new TextEncoder().encode("chunked artifact")
    const digest = digestOf("chunked artifact")

    const probe = await handler(
      request(`/cas/${digest}`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-range": `bytes */${bytes.byteLength}`
        }
      })
    )
    const rangedWhole = await handler(
      request(`/cas/${digest}`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-range": `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`
        },
        body: bytes
      })
    )
    expect(probe.status).toBe(400)
    expect(await probe.json()).toEqual({
      error: "content-range is not supported; send the whole blob in one request"
    })
    expect(rangedWhole.status).toBe(400)
    expect(contentStore.objects.has(digest)).toBe(false)

    const fallback = await handler(
      request(`/cas/${digest}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
    expect(fallback.status).toBe(201)
    expect(contentStore.objects.has(digest)).toBe(true)
  })

  test("answers a successful corrupt-row repair with 200 and serves the repaired bytes", async () => {
    const repairedBytes = new TextEncoder().encode("repaired artifact bytes")
    const digest = digestOf("repaired artifact bytes")
    let storedBytes = new TextEncoder().encode("corrupt bytes")
    const contentStore = {
      has: async () => true,
      get: async () => ({ body: storedBytes }),
      put: async (_digest, bytes) => {
        storedBytes = new Uint8Array(bytes)
        return "repaired"
      },
      presentDigests: async () => new Set([digest])
    }
    const handler = makeHandler({ contentStore })

    const repaired = await captureErrors(() =>
      handler(request(`/cas/${digest}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: repairedBytes
      }))
    )
    const fetched = await handler(request(`/cas/${digest}`))

    expect(repaired.value.status).toBe(200)
    expect(repaired.lines).toHaveLength(0)
    expect(storedBytes).toEqual(repairedBytes)
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(repairedBytes)
  })

  test("refuses bytes that do not hash to the address", async () => {
    const handler = makeHandler()
    const response = await handler(
      request(`/cas/${"e".repeat(64)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new TextEncoder().encode("not that")
      })
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain(digestOf("not that"))
  })

  test("requires an octet-stream content type", async () => {
    const handler = makeHandler()
    const response = await handler(
      request(`/cas/${digestOf("x")}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode("x")
      })
    )
    expect(response.status).toBe(415)
  })

  test("refuses an address that is not 64 lowercase hex characters", async () => {
    const handler = makeHandler()
    for (const digest of ["A".repeat(64), "a".repeat(63), `${"a".repeat(64)}a`, "zz"]) {
      const response = await handler(request(`/cas/${digest}`))
      expect(response.status).toBe(400)
    }
  })

  test("refuses an artifact past the configured bound, chunked or declared", async () => {
    const handler = makeHandler({ maxArtifactBytes: 1024 })
    const chunk = new Uint8Array(512)
    const streamed = await handler(
      request(`/cas/${"a".repeat(64)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: chunked([chunk, chunk, chunk]),
        duplex: "half"
      })
    )
    const declared = await handler(
      request(`/cas/${"a".repeat(64)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "content-length": "4096" },
        body: chunked([chunk]),
        duplex: "half"
      })
    )

    expect(streamed.status).toBe(413)
    expect(declared.status).toBe(413)
  })

  test("accepts an artifact exactly at the bound", async () => {
    const handler = makeHandler({ maxArtifactBytes: 8 })
    const bytes = new TextEncoder().encode("12345678")
    const response = await handler(
      request(`/cas/${digestOf("12345678")}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
    expect(response.status).toBe(201)
  })

  test("accepts a declared content-length exactly at the bound and refuses one byte past it", async () => {
    const handler = makeHandler({ maxArtifactBytes: 8 })
    const bytes = new TextEncoder().encode("87654321")
    const put = (declared) =>
      handler(
        request(`/cas/${digestOf("87654321")}`, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream", "content-length": declared },
          body: chunked([bytes]),
          duplex: "half"
        })
      )
    const overBound = await put("9")
    expect(overBound.status).toBe(413)
    const atBound = await put("8")
    expect(atBound.status).toBe(201)
  })

  test("bounds simultaneous artifact uploads and cancels excess bodies", async () => {
    let releaseUploads
    const gate = new Promise((resolve) => {
      releaseUploads = resolve
    })
    let entered = 0
    let reportFull
    const full = new Promise((resolve) => {
      reportFull = resolve
    })
    const contentStore = {
      ...memoryContentStore(),
      put: async () => {
        entered += 1
        if (entered === maxConcurrentArtifactTransfers) reportFull()
        await gate
        return "inserted"
      }
    }
    const handler = makeHandler({ contentStore })
    const uploads = Array.from({ length: maxConcurrentArtifactTransfers }, (_, index) => {
      const bytes = new TextEncoder().encode(`upload-${index}`)
      return handler(request(`/cas/${digestOf(`upload-${index}`)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      }))
    })
    await full

    const fifthBytes = new TextEncoder().encode("upload-fifth")
    const fifthBody = instrumentedBody({ chunks: [fifthBytes] })
    const refused = await handler(rawRequest(`/cas/${digestOf("upload-fifth")}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: fifthBody.body
    }))
    expect(refused.status).toBe(429)
    expect(refused.headers.get("retry-after")).toBe("1")
    expect(fifthBody.log).toEqual(["body-cancel"])

    releaseUploads()
    expect((await Promise.all(uploads)).map((response) => response.status)).toEqual(
      Array.from({ length: maxConcurrentArtifactTransfers }, () => 201)
    )
  })

  test("holds the request cap while action-cache response bodies remain unread", async () => {
    const body = JSON.stringify({ keyDigest, result: { exitOk: true } })
    const actionCache = memoryActionCache()
    actionCache.entries.set(keyDigest, {
      body,
      resultJson: canonicalJson({ exitOk: true }),
      createdAtMs: null,
      recordedRunId: null,
      recordedEventSeq: null,
      digests: []
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

  test("releases exactly one action-cache request permit on body cancel, drain, or error", async () => {
    const body = JSON.stringify({ keyDigest, result: { exitOk: true } })
    const nativeResponse = globalThis.Response

    for (const completion of ["cancel", "drain", "error"]) {
      const streams = []
      class ControlledResponse extends nativeResponse {
        constructor(responseBody, init) {
          if (responseBody === body && init?.status === 200) {
            let controller
            let cancellations = 0
            const stream = new ReadableStream({
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
      globalThis.Response = ControlledResponse

      try {
        const actionCache = memoryActionCache()
        actionCache.entries.set(keyDigest, {
          body,
          resultJson: canonicalJson({ exitOk: true }),
          createdAtMs: null,
          recordedRunId: null,
          recordedEventSeq: null,
          digests: []
        })
        const handler = makeHandler({ actionCache })
        const held = await Promise.all(
          Array.from({ length: maxConcurrentCacheRequests }, () => handler(request(`/ac/${keyDigest}`)))
        )
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
          firstStream.controller.enqueue(new TextEncoder().encode("done"))
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
        globalThis.Response = nativeResponse
      }
    }
  })

  test("holds streaming downloads through cancel, drain, and error, releasing exactly one slot", async () => {
    const digest = digestOf("streaming artifact")
    for (const completion of ["cancel", "drain", "error"]) {
      const streams = []
      const contentStore = {
        ...memoryContentStore(),
        get: async () => {
          let controller
          let cancellations = 0
          const body = new ReadableStream({
            start(value) {
              controller = value
            },
            cancel() {
              cancellations += 1
            }
          })
          const controlled = {
            body,
            controller,
            get cancellations() {
              return cancellations
            }
          }
          streams.push(controlled)
          return { body }
        }
      }
      const handler = makeHandler({ contentStore })
      const held = await Promise.all(
        Array.from({ length: maxConcurrentArtifactTransfers }, () => handler(request(`/cas/${digest}`)))
      )
      expect(held.map((response) => response.status)).toEqual([200, 200])
      expect((await handler(request(`/cas/${digest}`))).status).toBe(429)

      if (completion === "cancel") {
        await held[0].body.cancel()
        expect(streams[0].cancellations).toBe(1)
      } else if (completion === "drain") {
        streams[0].controller.enqueue(new TextEncoder().encode("done"))
        streams[0].controller.close()
        expect(await held[0].text()).toBe("done")
      } else {
        streams[0].controller.error(new Error("stream failed"))
        await expect(held[0].arrayBuffer()).rejects.toThrow("stream failed")
      }

      const admitted = await handler(request(`/cas/${digest}`))
      expect(admitted.status).toBe(200)
      // Exactly one permit was released: the other original transfer and this
      // replacement still occupy the two-slot ceiling.
      expect((await handler(request(`/cas/${digest}`))).status).toBe(429)
      await held[1].body.cancel()
      await admitted.body.cancel()
    }
  })

  test("rejects impossible artifact limits at handler construction", () => {
    for (const maxArtifactBytes of [0, -1, 1.5, Number.NaN, 16 * 1024 * 1024 + 1]) {
      expect(() => makeHandler({ maxArtifactBytes })).toThrow("maxArtifactBytes")
    }
  })
})

describe("findMissing", () => {
  test("answers in request order after deduplication", async () => {
    const contentStore = memoryContentStore()
    const present = digestOf("present")
    contentStore.objects.set(present, new Uint8Array())
    const handler = makeHandler({ contentStore })
    const first = digestOf("first")
    const second = digestOf("second")
    const response = await handler(
      jsonRequest("/cas/findMissing", { digests: [first, present, second, first] }, { method: "POST" })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ missing: [first, second] })
  })

  test("answers an empty probe without touching storage", async () => {
    const handler = makeHandler({ contentStore: failingStorage().contentStore })
    const response = await handler(jsonRequest("/cas/findMissing", { digests: [] }, { method: "POST" }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ missing: [] })
  })

  test("refuses more than the digest bound before reaching storage", async () => {
    const handler = makeHandler({ contentStore: failingStorage().contentStore })
    const digests = Array.from({ length: maxFindMissingDigests + 1 }, (_, index) => digestOf(`blob-${index}`))
    const response = await handler(jsonRequest("/cas/findMissing", { digests }, { method: "POST" }))

    expect(response.status).toBe(413)
    expect((await response.json()).error).toContain("1000")
  })

  test("accepts exactly the digest bound", async () => {
    const handler = makeHandler()
    const digests = Array.from({ length: maxFindMissingDigests }, (_, index) => digestOf(`blob-${index}`))
    const response = await handler(jsonRequest("/cas/findMissing", { digests }, { method: "POST" }))
    expect(response.status).toBe(200)
    expect((await response.json()).missing).toHaveLength(maxFindMissingDigests)
  })

  test("refuses a malformed request document", async () => {
    const handler = makeHandler()
    const cases = [
      { digests: "nope" },
      { digests: [1, 2] },
      { digests: [null] },
      { digests: ["A".repeat(64)] },
      { digests: [{ digest: "a".repeat(64) }] },
      { digests: [], ignored: true },
      {},
      []
    ]
    for (const body of cases) {
      const response = await handler(jsonRequest("/cas/findMissing", body, { method: "POST" }))
      expect(response.status).toBe(400)
    }
  })

  test("refuses a probe body past its own bound", async () => {
    const handler = makeHandler()
    const chunk = new Uint8Array(64 * 1024)
    chunk.fill(0x20)
    const response = await handler(
      request("/cas/findMissing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chunked(Array.from({ length: 8 }, () => chunk)),
        duplex: "half"
      })
    )
    expect(response.status).toBe(413)
  })
})

describe("request body cancel and release discipline", () => {
  const putJson = (handler, body, headers = {}) =>
    handler(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...headers },
        body
      })
    )

  test("cancels the body of a malformed content-length without reading it", async () => {
    const { body, log } = instrumentedBody({ chunks: [new TextEncoder().encode("{}")] })
    const response = await putJson(makeHandler(), body, { "content-length": "1e6" })

    expect(response.status).toBe(400)
    expect(log).toEqual(["body-cancel"])
  })

  test("cancels the body of an oversized content-length without reading it", async () => {
    const { body, log } = instrumentedBody({ chunks: [new TextEncoder().encode("{}")] })
    const response = await putJson(makeHandler(), body, { "content-length": "1048577" })

    expect(response.status).toBe(413)
    expect(log).toEqual(["body-cancel"])
  })

  test("cancels the body of a refused content type", async () => {
    const entry = instrumentedBody({ chunks: [new TextEncoder().encode("{}")] })
    const artifact = instrumentedBody({ chunks: [new TextEncoder().encode("x")] })
    const handler = makeHandler()
    const entryResponse = await putJson(handler, entry.body, { "content-type": "text/plain" })
    const artifactResponse = await handler(
      rawRequest(`/cas/${digestOf("x")}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: artifact.body
      })
    )

    expect(entryResponse.status).toBe(415)
    expect(artifactResponse.status).toBe(415)
    expect(entry.log).toEqual(["body-cancel"])
    expect(artifact.log).toEqual(["body-cancel"])
  })

  test("cancels and then releases the reader of a body that outgrows the bound", async () => {
    const chunk = new Uint8Array(512 * 1024)
    const { body, log } = instrumentedBody({ chunks: [chunk, chunk, chunk] })
    const response = await putJson(makeHandler(), body)

    expect(response.status).toBe(413)
    expect(log).toEqual(["get-reader", "reader-cancel", "release"])
  })

  test("releases the reader on normal completion without cancelling it", async () => {
    const { body, log } = instrumentedBody({ chunks: [new TextEncoder().encode(JSON.stringify(envelope))] })
    const response = await putJson(makeHandler(), body)

    expect(response.status).toBe(201)
    expect(log).toEqual(["get-reader", "release"])
  })

  test("cancels and releases when a read fails, and reports the read failure", async () => {
    const { body, log } = instrumentedBody({ failRead: true })
    const captured = await captureErrors(() => putJson(makeHandler(), body))

    expect(captured.value.status).toBe(503)
    expect(log).toEqual(["get-reader", "read-failed", "reader-cancel", "release"])
    // The read failure is what is attributed, not the cancel that followed it.
    expect(captured.lines.flat().join(" ")).toContain("ECONNRESET")
  })

  test("keeps the refusal when cancelling or releasing fails on the way out", async () => {
    const chunk = new Uint8Array(512 * 1024)
    const handler = makeHandler()
    const stubbornHeader = instrumentedBody({ chunks: [chunk], failCancel: true })
    const stubbornOverflow = instrumentedBody({ chunks: [chunk, chunk, chunk], failCancel: true })
    const wedged = instrumentedBody({ chunks: [chunk, chunk, chunk], failRelease: true })

    const header = await putJson(handler, stubbornHeader.body, { "content-length": "1048577" })
    const overflow = await putJson(handler, stubbornOverflow.body)
    const release = await putJson(handler, wedged.body)

    expect(header.status).toBe(413)
    expect(overflow.status).toBe(413)
    expect(release.status).toBe(413)
    // A cancel that threw must not skip the release that follows it.
    expect(stubbornOverflow.log).toEqual(["get-reader", "reader-cancel", "release"])
  })

  test("keeps a completed publication when releasing the reader fails", async () => {
    const { body } = instrumentedBody({
      chunks: [new TextEncoder().encode(JSON.stringify(envelope))],
      failRelease: true
    })
    const response = await putJson(makeHandler(), body)
    expect(response.status).toBe(201)
  })

  test("leaves a real stream unlocked and cancelled on every exit", async () => {
    const handler = makeHandler()
    let refusedCancelled = false
    const refused = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(512 * 1024))
      },
      cancel() {
        refusedCancelled = true
      }
    })
    const completed = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(envelope)))
        controller.close()
      }
    })

    const overflow = await putJson(handler, refused)
    const success = await putJson(handler, completed)

    expect(overflow.status).toBe(413)
    expect(refusedCancelled).toBe(true)
    expect(refused.locked).toBe(false)
    expect(success.status).toBe(201)
    expect(completed.locked).toBe(false)
  })
})

describe("failure diagnostics", () => {
  const hostile = () =>
    Object.assign(new Error("connect ECONNREFUSED 10.0.0.4:5432"), {
      name: "PostgresError",
      code: "28P01",
      errno: -61,
      syscall: "connect",
      query: "INSERT INTO smithers_build_cache_entry (key_digest, body) VALUES ($1, $2)",
      parameters: ["a".repeat(64), `{"secret":"payload"}`],
      databaseUrl: "postgres://smthrs:hunter2@cache-postgres:5432/smithers_build_cache",
      headers: { authorization: `Bearer ${writeToken}` },
      token: writeToken,
      body: `{"secret":"payload"}`,
      stack: "at connect (postgres://smthrs:hunter2@cache-postgres:5432)"
    })

  const secrets = [
    "hunter2",
    writeToken,
    "ECONNREFUSED",
    "10.0.0.4",
    "INSERT INTO",
    "secret",
    "postgres://",
    "authorization",
    "Bearer"
  ]

  test("attributes an error without serializing anything it carries", () => {
    const rendered = describeFailure(hostile())
    expect(rendered).toContain("name=PostgresError")
    expect(rendered).toContain("code=28P01")
    expect(rendered).toContain("errno=-61")
    expect(rendered).toContain("syscall=connect")
    for (const secret of secrets) expect(rendered).not.toContain(secret)
  })

  test("drops a tag that does not have the shape of an identifier", () => {
    const rendered = describeFailure({
      name: `Error: ${writeToken}`,
      code: `SELECT 1 -- ${writeToken}`,
      syscall: "a".repeat(64)
    })
    expect(rendered).toBe("smithers build cache: request failed (unattributed)")
  })

  test("survives a failure whose fields throw or are not errors at all", () => {
    const throwing = {}
    let reads = 0
    for (const field of ["name", "code", "errno", "syscall"]) {
      Object.defineProperty(throwing, field, {
        get() {
          reads += 1
          throw new Error(`getter leaked ${writeToken}`)
        }
      })
    }
    expect(describeFailure(throwing)).toBe("smithers build cache: request failed (unattributed)")
    expect(reads).toBe(0)
    expect(describeFailure(null)).toBe("smithers build cache: request failed (kind=null)")
    expect(describeFailure(writeToken)).toBe("smithers build cache: request failed (kind=string)")
    expect(describeFailure(undefined)).toBe("smithers build cache: request failed (kind=undefined)")
  })

  test("logs only the attribution and still answers the client a bare 503", async () => {
    const cause = hostile()
    const failing = async () => {
      throw cause
    }
    const handler = makeHandler({
      actionCache: { get: failing, put: failing, delete: failing },
      contentStore: { get: failing, has: failing, put: failing, presentDigests: failing }
    })
    const captured = await captureErrors(() => handler(request(`/ac/${keyDigest}`)))
    const logged = captured.lines.flat().map(String).join(" ")

    expect(captured.value.status).toBe(503)
    expect(await captured.value.json()).toEqual({ error: "the cache tier failed to answer" })
    expect(captured.lines).toHaveLength(1)
    for (const secret of secrets) expect(logged).not.toContain(secret)
    expect(logged).toContain("name=PostgresError")
  })
})

describe("storage failure", () => {
  test("answers every route with 503 rather than a miss", async () => {
    const handler = makeHandler(failingStorage())
    const cases = [
      request(`/ac/${keyDigest}`),
      jsonRequest(`/ac/${keyDigest}`, envelope, { method: "PUT" }),
      request(`/ac/${keyDigest}`, { method: "DELETE" }),
      request(`/cas/${"a".repeat(64)}`),
      request(`/cas/${"a".repeat(64)}`, { method: "HEAD" }),
      jsonRequest("/cas/findMissing", { digests: [digestOf("x")] }, { method: "POST" })
    ]
    const captured = await captureErrors(async () => {
      for (const failing of cases) {
        const response = await handler(failing)
        expect(response.status).toBe(503)
      }
    })
    expect(captured.lines).toHaveLength(cases.length)
  })

  test("turns malformed storage answers into retryable refusals", async () => {
    const invalidActionCache = {
      get: async () => "not-json",
      put: async () => "unexpected",
      delete: async () => "yes"
    }
    const invalidContentStore = {
      get: async () => Object.defineProperty({}, "body", { get: () => writeToken }),
      has: async () => "yes",
      put: async () => "unexpected",
      presentDigests: async () => ({ has: () => true })
    }
    const captured = await captureErrors(async () => {
      const actionHandler = makeHandler({ actionCache: invalidActionCache })
      expect((await actionHandler(request(`/ac/${keyDigest}`))).status).toBe(503)
      expect((await actionHandler(jsonRequest(`/ac/${keyDigest}`, cachedResult, { method: "PUT" }))).status)
        .toBe(503)
      expect((await actionHandler(request(`/ac/${keyDigest}`, { method: "DELETE" }))).status).toBe(503)

      const contentHandler = makeHandler({ contentStore: invalidContentStore })
      const digest = digestOf("invalid-storage")
      expect((await contentHandler(request(`/cas/${digest}`))).status).toBe(503)
      expect((await contentHandler(request(`/cas/${digest}`, { method: "HEAD" }))).status).toBe(503)
      expect(
        (await contentHandler(request(`/cas/${digest}`, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: new TextEncoder().encode("invalid-storage")
        }))).status
      ).toBe(503)
      expect((await contentHandler(jsonRequest("/cas/findMissing", { digests: [digest] }, { method: "POST" }))).status)
        .toBe(503)
    })
    expect(captured.lines).toHaveLength(7)
  })

  test("snapshots dependencies and rejects dependency accessors", async () => {
    const actionCache = memoryActionCache()
    const dependencies = {
      actionCache,
      contentStore: memoryContentStore(),
      health: async () => true,
      readTokenHash,
      writeTokenHash,
      maxArtifactBytes: 1024
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
        contentStore: memoryContentStore(),
        maxArtifactBytes: 1024
      },
      "readTokenHash",
      {
        enumerable: true,
        get: () => {
          reads += 1
          return readTokenHash
        }
      }
    )
    expect(() => createHandler(accessor)).toThrow("data property")
    expect(reads).toBe(0)
  })

  test("bounds publication and findMissing work independently", async () => {
    let releasePublications
    const publicationGate = new Promise((resolve) => {
      releasePublications = resolve
    })
    let publications = 0
    let publicationFull
    const publicationCapacity = new Promise((resolve) => {
      publicationFull = resolve
    })
    const memory = memoryActionCache()
    const actionCache = {
      ...memory,
      put: async (...args) => {
        publications += 1
        if (publications === maxConcurrentActionCachePublications) publicationFull()
        await publicationGate
        return memory.put(...args)
      }
    }
    const actionHandler = makeHandler({ actionCache })
    const admittedPublications = Array.from(
      { length: maxConcurrentActionCachePublications },
      () => actionHandler(jsonRequest(`/ac/${keyDigest}`, cachedResult, { method: "PUT" }))
    )
    await publicationCapacity
    expect((await actionHandler(jsonRequest(`/ac/${keyDigest}`, cachedResult, { method: "PUT" }))).status).toBe(429)
    releasePublications()
    expect((await Promise.all(admittedPublications)).every((response) => response.status < 300)).toBe(true)

    let releaseProbes
    const probeGate = new Promise((resolve) => {
      releaseProbes = resolve
    })
    let probes = 0
    let probesFull
    const probeCapacity = new Promise((resolve) => {
      probesFull = resolve
    })
    const contentStore = {
      ...memoryContentStore(),
      presentDigests: async () => {
        probes += 1
        if (probes === maxConcurrentFindMissingRequests) probesFull()
        await probeGate
        return new Set()
      }
    }
    const findHandler = makeHandler({ contentStore })
    const probe = { digests: [digestOf("probe")] }
    const admittedProbes = Array.from(
      { length: maxConcurrentFindMissingRequests },
      () => findHandler(jsonRequest("/cas/findMissing", probe, { method: "POST" }))
    )
    await probeCapacity
    expect((await findHandler(jsonRequest("/cas/findMissing", probe, { method: "POST" }))).status).toBe(429)
    releaseProbes()
    expect((await Promise.all(admittedProbes)).every((response) => response.status === 200)).toBe(true)
  })

  test("bounds simultaneous cache work independently of storage pool size", async () => {
    let entered = 0
    let reportFull
    const full = new Promise((resolve) => {
      reportFull = resolve
    })
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const actionCache = {
      ...memoryActionCache(),
      get: async () => {
        entered += 1
        if (entered === maxConcurrentCacheRequests) reportFull()
        await gate
        return null
      }
    }
    const handler = makeHandler({ actionCache })
    const admitted = Array.from(
      { length: maxConcurrentCacheRequests },
      () => handler(request(`/ac/${keyDigest}`))
    )
    await full
    const refused = await handler(request(`/ac/${keyDigest}`))
    expect(refused.status).toBe(429)
    expect(refused.headers.get("retry-after")).toBe("1")
    release()
    expect((await Promise.all(admitted)).every((response) => response.status === 404)).toBe(true)
  })
})

describe("canonicalJson", () => {
  test("sorts members and rejects values JSON cannot carry", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(`{"a":[2,{"c":3,"d":4}],"b":1}`)
    expect(canonicalJson(null)).toBe("null")
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow()
    expect(() => canonicalJson(undefined)).toThrow()
  })

  test("rejects lossy numbers, cycles, accessors, sparse arrays, and excessive depth", () => {
    const cycle = {}
    cycle.self = cycle
    const accessor = {}
    let reads = 0
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => {
        reads += 1
        return 1
      }
    })
    const sparse = new Array(2)
    sparse[1] = 1
    let deep = 0
    for (let depth = 0; depth <= maxJsonDepth; depth += 1) deep = [deep]

    for (const value of [-0, cycle, accessor, sparse, deep]) {
      expect(() => canonicalJson(value)).toThrow()
    }
    expect(reads).toBe(0)
    let proxyReads = 0
    const proxy = new Proxy({ value: "safe" }, {
      get: (target, property, receiver) => {
        proxyReads += 1
        return Reflect.get(target, property, receiver)
      }
    })
    expect(canonicalJson(proxy)).toBe("{\"value\":\"safe\"}")
    expect(proxyReads).toBe(0)
    expect(() => canonicalJson("x".repeat(maxCanonicalJsonBytes + 1))).toThrow("byte bound")
  })
})

/**
 * Counts the UTF-8 encoder allocations one operation makes.
 *
 * Byte accounting used to allocate a `Uint8Array` for every fragment rendered,
 * so a large document cost tens of thousands of allocations, and a publication
 * paid for the result subtree twice. A call count is asserted rather than a
 * duration because dozens of suites share the machine that runs this one.
 */
const countEncodes = async (work) => {
  const encode = TextEncoder.prototype.encode
  let calls = 0
  TextEncoder.prototype.encode = function counted(...args) {
    calls += 1
    return encode.apply(this, args)
  }
  try {
    return { value: await work(), calls }
  } finally {
    TextEncoder.prototype.encode = encode
  }
}

/** A cached result whose declared outputs make it a large canonical document. */
const wideResult = (files) => ({
  key: keyDigest,
  rule: "build",
  label: "//:build",
  exitOk: true,
  output: {
    files: Array.from({ length: files }, (_, index) => ({
      path: `dist/chunk-${index}.js`,
      digest: digestOf(`chunk-${index}`),
      bytes: index
    }))
  },
  storedAt: "2026-08-14T00:00:00.000Z"
})

describe("canonical rendering cost", () => {
  test("counts a document's bytes without encoding every fragment", async () => {
    const value = wideResult(2000)
    const { value: text, calls } = await countEncodes(async () => canonicalJson(value))

    expect(text.length).toBeGreaterThan(100_000)
    expect(text).toStartWith(`{"exitOk":true,"key":"${keyDigest}"`)
    expect(calls).toBeLessThanOrEqual(2)
  })

  test("serves a cache hit without rendering the stored document again", async () => {
    const body = JSON.stringify(wideResult(2000))
    const handler = makeHandler({ actionCache: { ...memoryActionCache(), get: async () => body } })
    const hit = readRequest(`/ac/${keyDigest}`)
    const { value: response, calls } = await countEncodes(() => handler(hit))

    expect(response.status).toBe(200)
    expect(body.length).toBeGreaterThan(100_000)
    await expect(response.text()).resolves.toBe(body)
    expect(calls).toBeLessThanOrEqual(8)
  })

  test("publishes an envelope with one rendering of its result", async () => {
    const actionCache = memoryActionCache()
    const handler = makeHandler({ actionCache })
    const result = wideResult(2000)
    const publication = jsonRequest(`/ac/${keyDigest}`, {
      keyDigest,
      result,
      meta: { rule: "build" },
      createdAtMs: 1_700_000_000_000,
      recordedRunId: "run-1",
      recordedEventSeq: 7
    }, { method: "PUT" })
    const { value: response, calls } = await countEncodes(() => handler(publication))

    expect(response.status).toBe(201)
    expect(actionCache.entries.get(keyDigest).resultJson).toBe(canonicalJson(result))
    expect(calls).toBeLessThanOrEqual(8)
  })

  test("takes the discriminator from the result when metadata renders identically", async () => {
    const actionCache = memoryActionCache()
    const handler = makeHandler({ actionCache })
    const result = { exitOk: true, output: "same" }
    const shared = await handler(
      jsonRequest(`/ac/${keyDigest}`, { keyDigest, meta: result, result }, { method: "PUT" })
    )
    const primitive = await handler(
      jsonRequest(`/ac/${"b".repeat(64)}`, { keyDigest: "b".repeat(64), meta: "x", result: "x" }, { method: "PUT" })
    )

    expect(shared.status).toBe(201)
    expect(actionCache.entries.get(keyDigest).resultJson).toBe(canonicalJson(result))
    expect(primitive.status).toBe(201)
    expect(actionCache.entries.get("b".repeat(64)).resultJson).toBe(canonicalJson("x"))
  })

  test("still bounds envelope metadata that lies outside the result", async () => {
    const handler = makeHandler()
    const deepMeta = `${"[".repeat(maxJsonDepth)}0${"]".repeat(maxJsonDepth)}`
    // Wide rather than large: the member bound has to refuse this before the
    // body bound would, so the array stays well under the byte limit.
    const wideMeta = { keyDigest, result: { exitOk: true }, meta: new Array(maxJsonMembers).fill(0) }
    const deep = await handler(
      jsonRequest(`/ac/${keyDigest}`, `{"keyDigest":"${keyDigest}","result":{"exitOk":true},"meta":${deepMeta}}`, {
        method: "PUT"
      })
    )
    const wide = await handler(jsonRequest(`/ac/${keyDigest}`, wideMeta, { method: "PUT" }))

    expect(deep.status).toBe(400)
    await expect(deep.json()).resolves.toEqual({ error: "body contains invalid or unsupported cache metadata" })
    expect(wide.status).toBe(400)
    await expect(wide.json()).resolves.toEqual({ error: "body contains invalid or unsupported cache metadata" })
  })
})

describe("request cancellation", () => {
  test("releases all 64 permits when clients abort stalled storage", async () => {
    let entered = 0
    const signals = []
    const handler = makeHandler({
      actionCache: {
        ...memoryActionCache(),
        get: (_key, signal) => {
          entered += 1
          signals.push(signal)
          return new Promise(() => {})
        }
      }
    })
    const controllers = Array.from({ length: maxConcurrentCacheRequests }, () => new globalThis.AbortController())
    const pending = controllers.map((controller) => handler(request(`/ac/${keyDigest}`, { signal: controller.signal })))
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve()
    expect(entered).toBe(64)
    for (const controller of controllers) controller.abort()
    const outcome = await Promise.race([
      Promise.all(pending).then((responses) => responses.map((response) => response.status)),
      Bun.sleep(100).then(() => "stalled")
    ])
    expect(outcome).toEqual(Array(64).fill(503))
    expect(signals.every((signal) => signal?.aborted)).toBe(true)
    expect((await handler(request("/healthz"))).status).toBe(200)
  })
})

test("deadlines recover readiness from a dependency that never settles", async () => {
  let calls = 0
  const handler = makeHandler({
    health: () => {
      calls += 1
      return calls === 1 ? new Promise(() => {}) : Promise.resolve(true)
    }
  }, { healthTimeoutMilliseconds: 20 })
  expect((await handler(request("/healthz"))).status).toBe(503)
  await Bun.sleep(30)
  expect((await handler(request("/healthz"))).status).toBe(200)
  expect(calls).toBe(2)
})

test("deadlines bound stalled reads without a client abort", async () => {
  const handler = makeHandler({
    actionCache: {
      ...memoryActionCache(),
      get: () => new Promise(() => {})
    }
  }, { requestTimeoutMilliseconds: 20 })
  expect((await handler(request(`/ac/${keyDigest}`))).status).toBe(503)
  expect((await handler(request("/healthz"))).status).toBe(200)
})

test("aborting a stalled upload prevents a later publication", async () => {
  let puts = 0
  let cancelled = false
  const handler = makeHandler({
    actionCache: {
      ...memoryActionCache(),
      put: async () => {
        puts += 1
        return "inserted"
      }
    }
  }, { requestTimeoutMilliseconds: 20 })
  const body = new ReadableStream({
    pull: () => new Promise(() => {}),
    cancel: () => {
      cancelled = true
    }
  })
  const response = await handler(request(`/ac/${keyDigest}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body
  }))
  expect(response.status).toBe(503)
  expect(puts).toBe(0)
  expect(cancelled).toBe(true)
})

test("a stalled download releases its transfer permit at the deadline", async () => {
  const handler = makeHandler({
    contentStore: {
      ...memoryContentStore(),
      get: async () => ({ body: new ReadableStream({ pull: () => new Promise(() => {}) }) })
    }
  }, { transferTimeoutMilliseconds: 20 })
  const first = await handler(request(`/cas/${keyDigest}`))
  const second = await handler(request(`/cas/${keyDigest}`))
  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect((await handler(request(`/cas/${keyDigest}`))).status).toBe(429)
  await Bun.sleep(40)
  const next = await handler(request(`/cas/${keyDigest}`))
  expect(next.status).toBe(200)
  await next.body.cancel()
})

test("keeps admission occupied until cancelled SQL has actually settled", async () => {
  const finishes = []
  let cancelled = 0
  const storage = createStorage(() => {
    const query = new Promise((_resolve, reject) => {
      finishes.push(reject)
    })
    query.cancel = () => {
      cancelled += 1
    }
    return query
  })
  const handler = makeHandler({ actionCache: storage.actionCache })
  const controller = new globalThis.AbortController()
  const pending = Array.from({ length: 64 }, () => handler(request(`/ac/${keyDigest}`, { signal: controller.signal })))
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve()
  expect(finishes).toHaveLength(64)
  controller.abort()
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve()
  expect(cancelled).toBe(64)
  expect((await handler(request("/healthz"))).status).toBe(429)
  for (const finish of finishes) finish(new Error("cancelled SQL settled"))
  expect((await Promise.all(pending)).every((response) => response.status === 503)).toBe(true)
  expect((await handler(request("/healthz"))).status).toBe(200)
})
