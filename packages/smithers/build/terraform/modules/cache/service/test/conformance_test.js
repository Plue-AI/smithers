/*
 * Black-box conformance corpus for the hosted Worker and self-hosted service.
 * It lives here because the service requires Bun, which can also import the
 * Worker's pure TypeScript protocol, so both deployments can run in one
 * process. The assertions cover parity between deployments, not policy.
 */
import { expect, test } from "bun:test"
import { createHandler as workerCreateHandler } from "../../../../../infra/worker/protocol.ts"
import { createHandler as serviceCreateHandler } from "../protocol.js"

const readToken = "read-token-with-sufficient-entropy-for-conformance"
const writeToken = "write-token-with-sufficient-entropy-for-conformance"
const sha256Hex = (value) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const readTokenHash = sha256Hex(readToken)
const writeTokenHash = sha256Hex(writeToken)

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

const memoryStorage = () => ({
  actionCache: memoryActionCache(),
  contentStore: memoryContentStore()
})

const failingStorage = () => {
  const fail = async () => {
    throw new Error("the connection is gone")
  }
  return {
    actionCache: { get: fail, put: fail, delete: fail },
    contentStore: { get: fail, has: fail, put: fail, presentDigests: fail }
  }
}

const textEncoder = new TextEncoder()
const keyDigest = "a".repeat(64)
const secondKeyDigest = "b".repeat(64)
const thirdKeyDigest = "c".repeat(64)
const fourthKeyDigest = "d".repeat(64)
const fifthKeyDigest = "e".repeat(64)
const blob = textEncoder.encode("artifact-bytes")
const blobDigest = sha256Hex(blob)
const stateBlob = textEncoder.encode("persisted-state-artifact")
const stateBlobDigest = sha256Hex(stateBlob)
const oversizedBlob = new Uint8Array(1025)
const oversizedBlobDigest = sha256Hex(oversizedBlob)
const oversizedActionBody = JSON.stringify({ payload: "x".repeat(1024 * 1024) })
const tooManyDigests = Array.from({ length: 1001 }, (_, index) => index.toString(16).padStart(64, "0"))

const cacheEntry = (key, result, metadata = {}) => ({
  keyDigest: key,
  result,
  meta: { boundary: { declaredOutputs: { outputs: [] } } },
  ...metadata
})

const cacheEntryBody = (key, result, metadata) => JSON.stringify(cacheEntry(key, result, metadata))

const cliCachedResult = (key) => ({
  key,
  rule: "install",
  label: "//:install",
  exitOk: true,
  output: { packages: 12 },
  storedAt: "2026-08-14T00:00:00.000Z"
})

const vectors = [
  {
    name: "healthz",
    requests: [
      { method: "GET", path: "/healthz", auth: null },
      { method: "HEAD", path: "/healthz", auth: null },
      { method: "POST", path: "/healthz", auth: null }
    ]
  },
  {
    name: "healthz dependency failure",
    dependencies: () => ({
      health: async () => {
        throw new Error("database unavailable")
      }
    }),
    quietConsoleError: true,
    requests: [{ method: "GET", path: "/healthz", auth: null }]
  },
  {
    name: "auth",
    requests: [
      { method: "GET", path: `/ac/${keyDigest}`, auth: null },
      {
        method: "GET",
        path: `/ac/${keyDigest}`,
        auth: null,
        headers: { authorization: "Basic abc" }
      },
      { method: "GET", path: `/ac/${keyDigest}`, auth: "wrong" },
      {
        method: "PUT",
        path: `/ac/${keyDigest}`,
        body: cacheEntryBody(keyDigest, { ok: true }),
        json: true
      },
      { method: "GET", path: `/ac/${keyDigest}`, auth: "read" },
      {
        method: "PUT",
        path: `/ac/${keyDigest}`,
        body: cacheEntryBody(keyDigest, { ok: false }),
        auth: "read",
        json: true
      },
      { method: "DELETE", path: `/ac/${keyDigest}`, auth: "read" },
      {
        method: "PUT",
        path: `/ac/${keyDigest}`,
        body: cacheEntryBody(keyDigest, { ok: false }),
        auth: "wrong",
        json: true
      }
    ]
  },
  {
    name: "ac lifecycle",
    requests: [
      { method: "GET", path: `/ac/${keyDigest}` },
      {
        method: "PUT",
        path: `/ac/${keyDigest}`,
        body: cacheEntryBody(keyDigest, { ok: 1 }),
        json: true
      },
      {
        method: "PUT",
        path: `/ac/${keyDigest}`,
        body: cacheEntryBody(keyDigest, { ok: 1 }),
        json: true
      },
      {
        method: "PUT",
        path: `/ac/${keyDigest}`,
        body: cacheEntryBody(keyDigest, { ok: 2 }),
        json: true
      },
      { method: "GET", path: `/ac/${keyDigest}` },
      { method: "DELETE", path: `/ac/${keyDigest}` },
      { method: "DELETE", path: `/ac/${keyDigest}` }
    ]
  },
  {
    name: "ac publication shapes",
    requests: [
      {
        method: "PUT",
        path: `/ac/${secondKeyDigest}`,
        body: cacheEntryBody(secondKeyDigest, { ok: true }, { meta: { writer: "first" } }),
        json: true
      },
      {
        method: "PUT",
        path: `/ac/${secondKeyDigest}`,
        body: cacheEntryBody(secondKeyDigest, { ok: true }, { meta: { writer: "second" } }),
        json: true
      },
      {
        method: "PUT",
        path: `/ac/${thirdKeyDigest}`,
        body: JSON.stringify(cliCachedResult(thirdKeyDigest)),
        json: true
      },
      { method: "GET", path: `/ac/${thirdKeyDigest}` },
      {
        method: "PUT",
        path: `/ac/${fourthKeyDigest}`,
        body: JSON.stringify({ result: { ok: true }, referencedDigests: [] }),
        json: true
      },
      { method: "GET", path: `/ac/${fourthKeyDigest}` },
      {
        method: "PUT",
        path: `/ac/${fifthKeyDigest}`,
        body: JSON.stringify({ result: { same: true }, metadata: "one" }),
        json: true
      },
      {
        method: "PUT",
        path: `/ac/${fifthKeyDigest}`,
        body: JSON.stringify({ result: { same: true }, metadata: "two" }),
        json: true
      }
    ]
  },
  {
    name: "ac refusals",
    requests: [
      {
        method: "PUT",
        path: `/ac/${"A".repeat(64)}`,
        body: JSON.stringify({ result: { ok: true }, referencedDigests: [] }),
        json: true
      },
      { method: "GET", path: "/ac/%00" },
      { method: "GET", path: `/ac/${"a".repeat(513)}` },
      { method: "PUT", path: `/ac/${keyDigest}`, body: "not JSON", json: true },
      { method: "PUT", path: `/ac/${keyDigest}`, body: "{\"unterminated\":", json: true },
      {
        method: "PUT",
        path: `/ac/${keyDigest}`,
        body: cacheEntryBody(keyDigest, { ok: true })
      },
      {
        method: "PUT",
        path: `/ac/${keyDigest}`,
        body: cacheEntryBody(keyDigest, { ok: true }),
        headers: { "content-type": "text/plain" }
      },
      {
        method: "PUT",
        path: `/ac/${keyDigest}`,
        body: JSON.stringify(
          cacheEntry(keyDigest, { ok: true }, {
            meta: { boundary: { declaredOutputs: { outputs: [{ digest: "zz" }] } } }
          })
        ),
        json: true
      },
      {
        method: "PUT",
        path: `/ac/${keyDigest}`,
        body: JSON.stringify(
          cacheEntry(keyDigest, { ok: true }, {
            referencedDigests: "not-an-array",
            meta: { boundary: { declaredOutputs: { outputs: "not-an-array" } } }
          })
        ),
        json: true
      },
      { method: "PATCH", path: `/ac/${keyDigest}` },
      { method: "PUT", path: `/ac/${keyDigest}`, body: oversizedActionBody, json: true }
    ]
  },
  {
    name: "ac JSON bounds",
    requests: [
      {
        method: "PUT",
        path: `/ac/${keyDigest}`,
        body: `${"[".repeat(70)}null${"]".repeat(70)}`,
        json: true
      },
      {
        method: "PUT",
        path: `/ac/${keyDigest}`,
        body: `{"keyDigest":"${keyDigest}","result":{"a":1,"a":2}}`,
        json: true
      },
      {
        method: "PUT",
        path: `/ac/${keyDigest}`,
        body: `{"keyDigest":"${keyDigest}","result":{"n":9007199254740993}}`,
        json: true
      }
    ]
  },
  {
    name: "cas lifecycle",
    requests: [
      { method: "HEAD", path: `/cas/${blobDigest}` },
      {
        method: "PUT",
        path: `/cas/${blobDigest}`,
        body: blob,
        headers: { "content-type": "application/octet-stream" }
      },
      {
        method: "PUT",
        path: `/cas/${blobDigest}`,
        body: blob,
        headers: { "content-type": "application/octet-stream" }
      },
      { method: "GET", path: `/cas/${blobDigest}` },
      { method: "HEAD", path: `/cas/${blobDigest}` },
      { method: "GET", path: `/cas/${"f".repeat(64)}` }
    ]
  },
  {
    name: "cas refusals",
    requests: [
      {
        method: "PUT",
        path: `/cas/${blobDigest}`,
        body: textEncoder.encode("different"),
        headers: { "content-type": "application/octet-stream" }
      },
      { method: "GET", path: "/cas/not-a-digest" },
      {
        method: "PUT",
        path: `/cas/${blobDigest}`,
        body: blob,
        headers: {
          "content-type": "application/octet-stream",
          "content-range": `bytes 0-${blob.byteLength - 1}/${blob.byteLength}`
        }
      },
      { method: "POST", path: `/cas/${blobDigest}` },
      {
        method: "PUT",
        path: `/cas/${oversizedBlobDigest}`,
        body: oversizedBlob,
        headers: { "content-type": "application/octet-stream" }
      },
      {
        method: "PUT",
        path: `/cas/${blobDigest}`,
        body: blob,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(blob.byteLength + 1)
        }
      }
    ]
  },
  {
    name: "findMissing",
    requests: [
      {
        method: "PUT",
        path: `/cas/${blobDigest}`,
        body: blob,
        headers: { "content-type": "application/octet-stream" }
      },
      {
        method: "POST",
        path: "/cas/findMissing",
        body: JSON.stringify({ digests: [blobDigest, thirdKeyDigest] }),
        json: true
      },
      {
        method: "POST",
        path: "/cas/findMissing",
        body: JSON.stringify({ digests: [] }),
        json: true
      },
      { method: "POST", path: "/cas/findMissing", body: "[]", json: true },
      {
        method: "POST",
        path: "/cas/findMissing",
        body: JSON.stringify({ digests: tooManyDigests }),
        json: true
      },
      { method: "GET", path: "/cas/findMissing" },
      {
        method: "POST",
        path: "/cas/findMissing",
        body: JSON.stringify({ digests: ["not-a-digest"] }),
        json: true
      }
    ]
  },
  {
    name: "routing",
    requests: [
      { method: "GET", path: "/" },
      { method: "GET", path: "/nope" },
      { method: "GET", path: `/ac/${keyDigest}/extra` },
      { method: "GET", path: `/cas/${blobDigest}/extra` },
      { method: "GET", path: "/ac/%zz" },
      { method: "GET", path: "/cas/%zz" },
      { method: "GET", path: "/ac/%2e%2e" },
      { method: "GET", path: "/ac/a%20b" },
      {
        method: "PUT",
        path: `/cas/${blobDigest}`,
        body: blob,
        headers: { "content-type": "application/octet-stream" }
      },
      { method: "GET", path: `/cas/${blobDigest}?download=1` }
    ]
  },
  {
    // Fenced deletion of a row that carries no provenance answers the same on
    // both tiers. Publishing provenance does not: see the tier contract test.
    name: "delete fence",
    requests: [
      {
        method: "PUT",
        path: `/ac/${keyDigest}`,
        body: cacheEntryBody(keyDigest, { ok: true }),
        json: true
      },
      {
        method: "DELETE",
        path: `/ac/${keyDigest}?recordedRunId=run-2&recordedEventSeq=7`
      },
      { method: "DELETE", path: `/ac/${keyDigest}?recordedRunId=run-1` },
      { method: "DELETE", path: `/ac/${keyDigest}?recordedRunId=run-1&recordedEventSeq=x` },
      { method: "DELETE", path: `/ac/${keyDigest}` },
      { method: "DELETE", path: `/ac/${keyDigest}` }
    ]
  },
  {
    name: "storage failure",
    storage: failingStorage,
    quietConsoleError: true,
    requests: [
      { method: "GET", path: `/ac/${keyDigest}` },
      {
        method: "PUT",
        path: `/cas/${blobDigest}`,
        body: blob,
        headers: { "content-type": "application/octet-stream" }
      }
    ]
  },
  {
    name: "persisted state snapshot",
    exercisesState: true,
    requests: [
      {
        method: "PUT",
        path: `/ac/${keyDigest}`,
        body: cacheEntryBody(keyDigest, { persisted: true }),
        json: true
      },
      {
        method: "PUT",
        path: `/cas/${stateBlobDigest}`,
        body: stateBlob,
        headers: { "content-type": "application/octet-stream" }
      }
    ]
  }
]

const observedHeaders = [
  "content-type",
  "allow",
  "www-authenticate",
  "retry-after",
  "content-length"
]

const observeResponse = async (response) => {
  const headers = {}
  for (const name of observedHeaders) {
    const value = response.headers.get(name)
    if (value !== null) headers[name] = value
  }
  return { status: response.status, headers, body: await response.text() }
}

const makeRequest = (spec) => {
  const headers = new Headers(spec.headers ?? {})
  const auth = spec.auth === undefined ? "write" : spec.auth
  if (auth === "write") headers.set("authorization", `Bearer ${writeToken}`)
  if (auth === "read") headers.set("authorization", `Bearer ${readToken}`)
  if (auth === "wrong") headers.set("authorization", "Bearer nope")
  if (spec.json) headers.set("content-type", "application/json")
  return new Request(`http://cache.test${spec.path}`, {
    method: spec.method,
    headers,
    body: spec.body ?? null
  })
}

const snapshotState = (actionCache, contentStore) => {
  const actionEntries = actionCache.entries ?? new Map()
  const actionCacheKeys = [...actionEntries.keys()].sort()
  const actionCacheRows = actionCacheKeys.map((key) => {
    const publication = actionEntries.get(key)
    return {
      key,
      body: publication.body,
      resultJson: publication.resultJson,
      recordedRunId: publication.recordedRunId ?? null,
      recordedEventSeq: publication.recordedEventSeq ?? null
    }
  })
  const contentObjects = contentStore.objects ?? new Map()
  const contentStoreObjects = [...contentObjects.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([digest, bytes]) => ({ digest, byteLength: bytes.byteLength }))

  // createdAtMs is deliberately absent: a deployment may source it from its
  // own wall clock, so it is not a stable black-box parity observation.
  return { actionCacheKeys, actionCacheRows, contentStoreObjects }
}

const withoutExpectedErrors = async (quiet, operation) => {
  if (!quiet) return operation()
  const original = console.error
  console.error = () => undefined
  try {
    return await operation()
  } finally {
    console.error = original
  }
}

const runVector = async (createHandler, vector) => {
  const stores = (vector.storage ?? memoryStorage)()
  const handler = createHandler({
    ...stores,
    readTokenHash,
    writeTokenHash,
    maxArtifactBytes: 1024,
    ...(vector.dependencies?.() ?? {})
  })
  const responses = await withoutExpectedErrors(vector.quietConsoleError, async () => {
    const seen = []
    for (const spec of vector.requests) {
      seen.push(await observeResponse(await handler(makeRequest(spec))))
    }
    return seen
  })
  return { responses, ...snapshotState(stores.actionCache, stores.contentStore) }
}

for (const vector of vectors) {
  test(vector.name, async () => {
    const service = await runVector(serviceCreateHandler, vector)
    const worker = await runVector(workerCreateHandler, vector)
    expect(service).toEqual(worker)
  })
}

test("a namespace-scoped read token gets 403 outside its action-cache keys on both servers", async () => {
  const key = "a".repeat(64)
  const names = ["pr-1/", "main/", "pr-2/", "pr-10/"]
  const vector = {
    dependencies: () => ({ readNamespacePrefix: "pr-1/" }),
    requests: [
      ...names.map((name) => ({
        method: "PUT",
        path: `/ac/${encodeURIComponent(name + key)}`,
        body: JSON.stringify({ keyDigest: name + key, result: { ok: true } }),
        json: true
      })),
      ...names.map((name) => ({ method: "GET", path: `/ac/${encodeURIComponent(name + key)}`, auth: "read" })),
      { method: "GET", path: `/ac/${key}`, auth: "read" },
      { method: "GET", path: `/cas/${key}`, auth: "read" },
      { method: "POST", path: "/cas/findMissing", auth: "read", body: JSON.stringify({ digests: [] }), json: true }
    ]
  }
  for (const create of [serviceCreateHandler, workerCreateHandler]) {
    const { responses } = await runVector(create, vector)
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201, 200, 403, 403, 403, 403, 403, 403])
  }
})

/*
 * The one place the tiers answer differently by contract. The hosted Worker
 * advertises result-only arbitration and refuses journal provenance with 422
 * (infra/README.md, "Hosted arbitration contract"); the self-hosted service
 * stores the provenance and fences deletion on it. A parity vector cannot
 * hold here, so each tier's answer is pinned on its own: a change on either
 * side that closes or widens the gap fails this test, not silently the corpus.
 */
const provenanceVector = {
  name: "journal provenance",
  requests: [
    {
      method: "PUT",
      path: `/ac/${keyDigest}`,
      body: cacheEntryBody(keyDigest, { ok: true }, {
        recordedRunId: "run-1",
        recordedEventSeq: 7
      }),
      json: true
    },
    { method: "GET", path: `/ac/${keyDigest}?recordedRunId=run-1&recordedEventSeq=7` },
    {
      method: "DELETE",
      path: `/ac/${keyDigest}?recordedRunId=run-2&recordedEventSeq=7`
    },
    {
      method: "DELETE",
      path: `/ac/${keyDigest}?recordedRunId=run-1&recordedEventSeq=7`
    }
  ]
}

test("journal provenance is refused by the hosted tier and fenced by the self-hosted tier", async () => {
  const service = await runVector(serviceCreateHandler, provenanceVector)
  const worker = await runVector(workerCreateHandler, provenanceVector)

  expect(service.responses.map((response) => response.status)).toEqual([201, 200, 404, 200])
  expect(JSON.parse(service.responses[1].body)).toMatchObject({ recordedRunId: "run-1", recordedEventSeq: 7 })
  // The matching fence deleted the row; the mismatched one before it did not.
  expect(service.actionCacheRows).toEqual([])

  expect(worker.responses.map((response) => response.status)).toEqual([422, 422, 404, 404])
  for (const response of worker.responses.slice(0, 2)) {
    expect(JSON.parse(response.body)).toEqual({
      code: "UNSUPPORTED_PROVENANCE",
      error: "the hosted cache supports result-only arbitration, not journal provenance"
    })
  }
  expect(worker.actionCacheRows).toEqual([])
})

test("corpus exercises both storage surfaces", async () => {
  const vector = vectors.find((candidate) => candidate.exercisesState)
  expect(vector).toBeDefined()

  const service = await runVector(serviceCreateHandler, vector)
  const worker = await runVector(workerCreateHandler, vector)
  for (const observation of [service, worker]) {
    expect(observation.actionCacheKeys.length).toBeGreaterThan(0)
    expect(observation.actionCacheRows.length).toBeGreaterThan(0)
    expect(observation.contentStoreObjects.length).toBeGreaterThan(0)
  }
})
