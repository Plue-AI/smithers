import { execFileSync } from "node:child_process"
import { once } from "node:events"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  type CachedResult,
  entryLimit,
  maximumRemoteBodyChunks,
  openCache,
  publishNamespaceFromEnvironment,
  remoteEntryLimit,
  sanitizeKey
} from "../src/Cache.ts"

let root: string
let server: Http.Server
let endpoint: string
let requests: Array<{
  readonly method: string | undefined
  readonly path: string | undefined
  readonly authorization: string | undefined
  readonly body: string
}>
let respond: (request: Http.IncomingMessage, response: Http.ServerResponse) => void

const result: CachedResult = {
  key: "alpha",
  target: "Test",
  label: "//:test",
  exitOk: true,
  output: { ok: true },
  storedAt: "2026-08-14T00:00:00.000Z"
}

const readBody = async (request: Http.IncomingMessage): Promise<string> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

/** A syntactically valid JSON entry only a lossy UTF-8 decoder would admit. */
const invalidUtf8Entry = (): Buffer => {
  const marker = "\"INVALID_UTF8\""
  const text = JSON.stringify({ ...result, output: "INVALID_UTF8" })
  const index = text.indexOf(marker)
  if (index < 0) throw new Error("invalid UTF-8 fixture marker was not encoded")
  return Buffer.concat([
    Buffer.from(text.slice(0, index) + "\"", "utf8"),
    Buffer.from([0xc3, 0x28]),
    Buffer.from("\"" + text.slice(index + marker.length), "utf8")
  ])
}

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-cache-"))
  requests = []
  respond = (_request, response) => {
    response.writeHead(404).end()
  }
  server = Http.createServer(async (request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body: await readBody(request)
    })
    respond(request, response)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("test server did not bind a TCP port")
  endpoint = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  server.close()
  await once(server, "close")
  await Fs.rm(root, { recursive: true, force: true })
})

describe("openCache", () => {
  it("hashes ill-formed JavaScript keys without UTF-8 replacement collisions", () => {
    expect(sanitizeKey("\ud800")).not.toBe(sanitizeKey("\ufffd"))
    expect(sanitizeKey("\ud800")).not.toBe(sanitizeKey("\udc00"))
  })

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["over the hard maximum", 5 * 60 * 1000 + 1]
  ])("refuses a %s remote timeout before creating cache state", async (_name, timeout) => {
    await expect(openCache({ workspaceRoot: root, timeouts: { get: timeout, put: 1 } }))
      .rejects.toThrow(/remote cache get timeout/)
    await expect(Fs.stat(NodePath.join(root, ".flows"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("validates the remote put timeout too", async () => {
    await expect(openCache({ workspaceRoot: root, timeouts: { get: 1, put: Number.NaN } }))
      .rejects.toThrow(/remote cache put timeout/)
  })

  it("rejects unknown and accessor cache options before creating cache state", async () => {
    let invoked = false
    const accessor = { workspaceRoot: root } as Record<string, unknown>
    Object.defineProperty(accessor, "endpoint", {
      enumerable: true,
      get: () => {
        invoked = true
        return endpoint
      }
    })

    await expect(openCache(accessor as never)).rejects.toThrow(/endpoint must be an enumerable data property/)
    expect(invoked).toBe(false)
    await expect(openCache({ workspaceRoot: root, surprise: true } as never)).rejects.toThrow(/unknown property/)
    await expect(Fs.stat(NodePath.join(root, ".flows"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not invoke timeout or I/O accessors while validating options", async () => {
    let invoked = false
    const timeouts = Object.defineProperty({ put: 1 }, "get", {
      enumerable: true,
      get: () => {
        invoked = true
        return 1
      }
    })
    const io = Object.defineProperty({}, "rename", {
      enumerable: true,
      get: () => {
        invoked = true
        return Fs.rename
      }
    })

    await expect(openCache({ workspaceRoot: root, timeouts } as never)).rejects.toThrow(
      /get must be an enumerable data property/
    )
    await expect(openCache({ workspaceRoot: root, io })).rejects.toThrow(/rename must be an enumerable data property/)
    expect(invoked).toBe(false)
    await expect(Fs.stat(NodePath.join(root, ".flows"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each([
    "http://example.com/cache",
    "https://user:password@example.com/cache",
    "https://example.com/cache?tenant=one",
    "https://example.com/cache#fragment",
    "example.com/cache"
  ])("rejects the unsafe remote endpoint %s before creating cache state", async (unsafeEndpoint) => {
    await expect(openCache({ workspaceRoot: root, endpoint: unsafeEndpoint })).rejects.toThrow(/endpoint/)
    await expect(Fs.stat(NodePath.join(root, ".flows"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("stores local entries below the default .flows/cache directory", async () => {
    const cache = await openCache({ workspaceRoot: root })
    await cache.put(result.key, result)
    expect(JSON.parse(
      await Fs.readFile(
        NodePath.join(root, ".flows/cache/al/alpha.json"),
        "utf8"
      )
    )).toEqual(result)
    expect(await cache.get(result.key)).toEqual(result)
    await cache.close()
  })

  it("stores local entries below the configured directory", async () => {
    const cache = await openCache({ workspaceRoot: root, cacheDirectory: "build/cache/" })
    await cache.put(result.key, result)
    expect(JSON.parse(
      await Fs.readFile(
        NodePath.join(root, "build/cache/cache/al/alpha.json"),
        "utf8"
      )
    )).toEqual(result)
    await expect(Fs.stat(NodePath.join(root, ".flows/cache/al/alpha.json"))).rejects.toMatchObject({
      code: "ENOENT"
    })
    await cache.close()
  })

  it("refuses a cache directory outside the workspace", async () => {
    await expect(openCache({ workspaceRoot: root, cacheDirectory: "../escape" }))
      .rejects.toThrow(/must not leave the workspace/)
  })

  it("does not contact the remote on a local hit", async () => {
    const local = await openCache({ workspaceRoot: root })
    await local.put(result.key, result)
    await local.close()

    const cache = await openCache({ workspaceRoot: root, endpoint })
    expect(await cache.get(result.key)).toEqual(result)
    expect(requests).toEqual([])
    await cache.close()
  })

  it("returns a remote miss without creating a local entry", async () => {
    const cache = await openCache({ workspaceRoot: root, endpoint })
    expect(await cache.get(result.key)).toBeNull()
    expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/ac/alpha" }
    ])
    await expect(Fs.stat(NodePath.join(root, ".flows/cache/al/alpha.json"))).rejects.toMatchObject({
      code: "ENOENT"
    })
    await cache.close()
  })

  it("hydrates a remote hit into the local cache", async () => {
    respond = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ keyDigest: result.key, result }))
    }
    const remote = await openCache({ workspaceRoot: root, endpoint })
    expect(await remote.get(result.key)).toEqual(result)
    await remote.close()

    const local = await openCache({ workspaceRoot: root })
    expect(await local.get(result.key)).toEqual(result)
    await local.close()
  })

  it.each([200, 201])("accepts HTTP %s for a remote put", async (status) => {
    respond = (_request, response) => {
      response.writeHead(status).end()
    }
    const cache = await openCache({ workspaceRoot: root, endpoint })
    await expect(cache.put(result.key, result)).resolves.toBeUndefined()
    expect(requests[0]).toMatchObject({ method: "PUT", path: "/ac/alpha" })
    const published = JSON.parse(requests[0]!.body) as Record<string, unknown>
    expect(published).toMatchObject({ keyDigest: "alpha", result })
    // The hosted cache arbitrates on the result alone and answers 422 to any
    // journal provenance, so the envelope must never carry one.
    expect(published).not.toHaveProperty("recordedRunId")
    expect(published).not.toHaveProperty("recordedEventSeq")
    await cache.close()
  })

  it("skips one GET answered 429 as a miss and keeps the remote enabled", async () => {
    const warnings: Array<string> = []
    let busy = true
    respond = (_request, response) => {
      if (busy) {
        busy = false
        response.writeHead(429, { "retry-after": "1" }).end()
        return
      }
      response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ keyDigest: result.key, result }))
    }
    const cache = await openCache({ workspaceRoot: root, endpoint, warn: (line) => warnings.push(line) })
    expect(await cache.get(result.key)).toBeNull()
    expect(await cache.get(result.key)).toEqual(result)
    expect(requests.map(({ method }) => method)).toEqual(["GET", "GET"])
    expect(warnings).toEqual(["smthrs: remote cache busy (HTTP 429); skipped one request"])
    await cache.close()
  })

  it("drops one PUT answered 429 and keeps publishing and reading", async () => {
    const warnings: Array<string> = []
    const statuses = [429, 429, 201]
    respond = (_request, response) => {
      response.writeHead(statuses.shift() ?? 404).end()
    }
    const cache = await openCache({ workspaceRoot: root, endpoint, warn: (line) => warnings.push(line) })
    await cache.put("first", { ...result, key: "first" })
    await cache.put("second", { ...result, key: "second" })
    await cache.put("third", { ...result, key: "third" })
    expect(await cache.get("fourth")).toBeNull()
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "PUT /ac/first",
      "PUT /ac/second",
      "PUT /ac/third",
      "GET /ac/fourth"
    ])
    // One line per run, not one per busy answer.
    expect(warnings).toEqual(["smthrs: remote cache busy (HTTP 429); skipped one request"])
    await cache.close()
  })

  it("refuses a publication larger than the server's action-cache bound", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(null, { status: 201 })))
    const warnings: string[] = []
    const cache = await openCache({
      workspaceRoot: root,
      endpoint,
      fetch,
      warn: (line) => warnings.push(line)
    })

    await expect(
      cache.put(result.key, { ...result, output: "x".repeat(remoteEntryLimit) })
    ).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
    expect(warnings).toEqual([
      `smthrs: remote cache disabled after a failure: PUT request failed: remote cache request exceeds its ${remoteEntryLimit}-byte limit`
    ])
    await cache.close()
  })

  it("names the network cause when a remote request fails, without the token", async () => {
    const warnings: string[] = []
    const cache = await openCache({
      workspaceRoot: root,
      endpoint,
      readToken: () => "top-secret-token",
      fetch: () =>
        Promise.reject(
          new TypeError("fetch failed for Bearer top-secret-token", {
            cause: Object.assign(new Error("getaddrinfo ENOTFOUND cache.example"), {
              code: "ENOTFOUND",
              hostname: "cache.example"
            })
          })
        ),
      warn: (line) => warnings.push(line)
    })
    expect(await cache.get("alpha")).toBeNull()
    expect(warnings).toEqual([
      "smthrs: remote cache disabled after a failure: GET request failed: " +
      "fetch failed for Bearer [redacted] (ENOTFOUND cache.example)"
    ])
    await cache.close()
  })

  it("names an invalid token as the cause instead of a generic failure", async () => {
    const warnings: string[] = []
    const cache = await openCache({
      workspaceRoot: root,
      endpoint,
      readToken: () => "bad\ntoken",
      fetch: () => Promise.resolve(new Response(null, { status: 404 })),
      warn: (line) => warnings.push(line)
    })
    expect(await cache.get("alpha")).toBeNull()
    expect(warnings).toEqual([
      "smthrs: remote cache disabled after a failure: GET request failed: remote cache token must be bounded control-free text"
    ])
    await cache.close()
  })

  it("sends bearer authentication without putting the token in the entry", async () => {
    respond = (_request, response) => {
      response.writeHead(201).end()
    }
    let reads = 0
    const cache = await openCache({
      workspaceRoot: root,
      endpoint,
      readToken: () => {
        reads += 1
        return "top-secret"
      }
    })
    expect(reads).toBe(0)
    await cache.put(result.key, result)
    expect(reads).toBe(1)
    expect(requests[0]!.authorization).toBe("Bearer top-secret")
    expect(requests[0]!.body).not.toContain("top-secret")
    await cache.close()
  })

  it("forbids automatic redirects on authenticated GET and PUT requests", async () => {
    const redirects: Array<RequestInit["redirect"]> = []
    const cache = await openCache({
      workspaceRoot: root,
      endpoint,
      fetch: (_input, init) => {
        redirects.push(init?.redirect)
        return Promise.resolve(new Response(null, { status: 404 }))
      },
      warn: () => {}
    })
    expect(await cache.get("missing")).toBeNull()
    await cache.put(result.key, result)
    expect(redirects).toEqual(["error", "error"])
    await cache.close()
  })

  it("never includes a bearer token in a remote failure warning", async () => {
    const warnings: Array<string> = []
    const cache = await openCache({
      workspaceRoot: root,
      endpoint,
      readToken: () => "top-secret",
      fetch: () => Promise.reject(new Error("top-secret")),
      warn: (line) => warnings.push(line)
    })
    expect(await cache.get(result.key)).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).not.toContain("top-secret")
    await cache.close()
  })

  it("warns on a 409 conflict without failing or degrading", async () => {
    const warnings: Array<string> = []
    respond = (request, response) => {
      response.writeHead(request.method === "PUT" ? 409 : 404).end()
    }
    const cache = await openCache({ workspaceRoot: root, endpoint, warn: (line) => warnings.push(line) })
    await expect(cache.put(result.key, result)).resolves.toBeUndefined()
    expect(await cache.get("other")).toBeNull()
    expect(requests).toHaveLength(2)
    expect(warnings).toEqual([
      "smthrs: remote cache conflict; keeping the first published result"
    ])
    await cache.close()
  })

  it("rejects a well-formed entry filed under another key", async () => {
    // The one failure a content-addressed cache may never have: answering an
    // action with another action's result. The file is valid JSON, decodes
    // cleanly, and names a different key, which makes it a miss.
    const path = NodePath.join(root, ".flows/cache/al/alpha.json")
    await Fs.mkdir(NodePath.dirname(path), { recursive: true })
    await Fs.writeFile(path, JSON.stringify({ ...result, key: "beta", label: "//:other" }), "utf8")

    const cache = await openCache({ workspaceRoot: root })
    expect(await cache.get("alpha")).toBeNull()
    await cache.close()
  })

  it.each([
    ["truncated JSON", "{\"key\":\"alpha\",\"target\":\"Te"],
    ["an empty file", ""],
    ["a JSON value that is not an entry", "[1, 2, 3]"],
    ["a missing exit status", JSON.stringify({ ...result, exitOk: undefined })],
    ["a non-boolean exit status", JSON.stringify({ ...result, exitOk: "true" })],
    ["an empty target", JSON.stringify({ ...result, target: "" })],
    ["an empty label", JSON.stringify({ ...result, label: "" })],
    ["an empty storedAt", JSON.stringify({ ...result, storedAt: "" })]
  ])("treats %s as a miss", async (_name, content) => {
    const path = NodePath.join(root, ".flows/cache/al/alpha.json")
    await Fs.mkdir(NodePath.dirname(path), { recursive: true })
    await Fs.writeFile(path, content, "utf8")

    const cache = await openCache({ workspaceRoot: root })
    expect(await cache.get("alpha")).toBeNull()
    await cache.close()
  })

  it("refuses a remote entry that answers for another key", async () => {
    const warnings: Array<string> = []
    respond = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ keyDigest: "alpha", result: { ...result, key: "beta" } }))
    }
    const cache = await openCache({ workspaceRoot: root, endpoint, warn: (line) => warnings.push(line) })
    expect(await cache.get("alpha")).toBeNull()
    // The misfiled entry must not be hydrated into the local store either.
    await expect(Fs.stat(NodePath.join(root, ".flows/cache/al/alpha.json"))).rejects.toMatchObject({
      code: "ENOENT"
    })
    expect(warnings).toHaveLength(1)
    await cache.close()
  })

  it("refuses to store an entry under a key it does not name", async () => {
    const cache = await openCache({ workspaceRoot: root })
    await expect(cache.put("alpha", { ...result, key: "beta" })).rejects.toThrow(/key does not match/)
    await expect(Fs.stat(NodePath.join(root, ".flows/cache/al/alpha.json"))).rejects.toMatchObject({
      code: "ENOENT"
    })
    await cache.close()
  })

  it("snapshots and freezes a result before the caller can mutate it", async () => {
    const mutable = { ...result, output: { nested: { value: "before" } } }
    const cache = await openCache({ workspaceRoot: root })
    const pending = cache.put(result.key, mutable)
    mutable.output.nested.value = "after"
    await pending

    const stored = await cache.get(result.key)
    expect(stored?.output).toEqual({ nested: { value: "before" } })
    expect(Object.isFrozen(stored)).toBe(true)
    expect(Object.isFrozen(stored?.output)).toBe(true)
    expect(Object.isFrozen((stored?.output as { nested: object }).nested)).toBe(true)
    await cache.close()
  })

  it("never invokes cached-result accessors or toJSON hooks", async () => {
    let invoked = false
    const accessor = { ...result } as Record<string, unknown>
    Object.defineProperty(accessor, "output", {
      enumerable: true,
      get: () => {
        invoked = true
        return { ok: true }
      }
    })
    const withHook = {
      ...result,
      output: {
        toJSON: () => {
          invoked = true
          return { admitted: true }
        }
      }
    }
    const cache = await openCache({ workspaceRoot: root })

    await expect(cache.put(result.key, accessor as unknown as CachedResult)).rejects.toThrow(/data property/)
    await expect(cache.put(result.key, withHook)).rejects.toThrow(/inert JSON value/)
    expect(invoked).toBe(false)
    await expect(Fs.stat(NodePath.join(root, ".flows/cache/al"))).rejects.toMatchObject({ code: "ENOENT" })
    await cache.close()
  })

  it.each([
    ["a cycle", () => {
      const output: Record<string, unknown> = {}
      output["self"] = output
      return output
    }],
    ["negative zero", () => -0],
    ["a sparse array", () => new Array(2)]
  ])("refuses cached output containing %s before publishing", async (_name, makeOutput) => {
    const cache = await openCache({ workspaceRoot: root })
    await expect(cache.put(result.key, { ...result, output: makeOutput() })).rejects.toThrow()
    await expect(Fs.stat(NodePath.join(root, ".flows/cache/al"))).rejects.toMatchObject({ code: "ENOENT" })
    await cache.close()
  })

  it("refuses an oversize entry before creating a shard or temporary file", async () => {
    const cache = await openCache({ workspaceRoot: root })
    await expect(cache.put(result.key, { ...result, output: "x".repeat(entryLimit) }))
      .rejects.toThrow(/exceeds its .*byte limit/)
    await expect(Fs.stat(NodePath.join(root, ".flows/cache/al"))).rejects.toMatchObject({ code: "ENOENT" })
    await cache.close()
  })

  it("leaves no temporary file behind after a successful put", async () => {
    const cache = await openCache({ workspaceRoot: root })
    await cache.put(result.key, result)
    expect(await Fs.readdir(NodePath.join(root, ".flows/cache/al"))).toEqual(["alpha.json"])
    await cache.close()
  })

  it("removes its temporary file when the rename cannot complete", async () => {
    const cache = await openCache({ workspaceRoot: root })
    const directory = NodePath.join(root, ".flows/cache/al")
    // A directory at the entry path makes the rename fail after the temporary
    // file was created, written, and synced.
    await Fs.mkdir(NodePath.join(directory, "alpha.json"), { recursive: true })

    await expect(cache.put(result.key, result)).rejects.toThrow()
    expect(await Fs.readdir(directory)).toEqual(["alpha.json"])
    await cache.close()
  })

  /**
   * The regression this pins: the temporary file used to be named from
   * `Math.random`, which is neither unique nor exclusive. Two writers of one
   * key that draw the same value shared a temporary file, so one truncated and
   * overwrote the other's bytes and then renamed a file the other was still
   * writing into. Reproduced against the previous implementation, this exact
   * case published a 4 MB entry that failed `JSON.parse` and rejected one of
   * the two puts with ENOENT. The temporary file is now created with exclusive
   * create under a name unique by construction, so a collision is impossible
   * and a stale temporary file is never adopted.
   */
  it("never lets two writers of one key share a temporary file", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5)
    try {
      const first = await openCache({ workspaceRoot: root })
      const second = await openCache({ workspaceRoot: root })
      // Results of different sizes, as two runs of a tool whose output is not
      // byte-identical produce.
      const large: CachedResult = { ...result, output: { padding: "x".repeat(4_000_000) } }
      const small: CachedResult = { ...result, output: { padding: "y" } }

      const settled = await Promise.allSettled([
        first.put(result.key, large),
        second.put(result.key, small)
      ])

      expect(settled.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"])
      const published = await first.get(result.key)
      // Whichever writer won, the published entry is one writer's whole entry.
      expect(published).not.toBeNull()
      expect([large.output, small.output]).toContainEqual(published!.output)
      expect(await Fs.readdir(NodePath.join(root, ".flows/cache/al"))).toEqual(["alpha.json"])
      await first.close()
      await second.close()
    } finally {
      random.mockRestore()
    }
  })

  it("publishes whole entries under concurrent writers of the same key", async () => {
    // Every writer of one key writes the same bytes, and publication is a
    // rename of a fully written file, so no reader can observe a partial
    // entry no matter how the writers interleave.
    const caches = await Promise.all(
      Array.from({ length: 8 }, () => openCache({ workspaceRoot: root }))
    )
    const reads: Array<Promise<CachedResult | null>> = []
    await Promise.all(caches.map(async (cache, index) => {
      await cache.put(result.key, { ...result, storedAt: result.storedAt })
      reads.push(caches[(index + 1) % caches.length]!.get(result.key))
    }))

    // A replacement may exhaust the reader's bounded identity retries. That
    // is a safe miss, but an observed hit must always contain a whole entry.
    for (const entry of await Promise.all(reads)) {
      if (entry !== null) expect(entry).toEqual(result)
    }
    for (const cache of caches) expect(await cache.get(result.key)).toEqual(result)
    expect(await Fs.readdir(NodePath.join(root, ".flows/cache/al"))).toEqual(["alpha.json"])
    expect(JSON.parse(await Fs.readFile(NodePath.join(root, ".flows/cache/al/alpha.json"), "utf8")))
      .toEqual(result)
    await Promise.all(caches.map((cache) => cache.close()))
  })

  /**
   * The bug this reproduces and closes: `.flows` is a symbolic link to a
   * directory outside the workspace. `normalizeCacheDirectory` only settles
   * the lexical question — `.flows` is a plain relative name — so every entry
   * the cache published landed outside the workspace, creating and writing
   * files wherever the link pointed. The link is now refused when the cache is
   * opened, before a directory is created out there.
   */
  it("refuses a cache directory that is a symbolic link out of the workspace", async () => {
    const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-outside-"))
    try {
      await Fs.symlink(outside, NodePath.join(root, ".flows"))

      await expect(openCache({ workspaceRoot: root })).rejects.toThrow(/cache directory leaves the workspace/)
      // Nothing was created out there, let alone written.
      expect(await Fs.readdir(outside)).toEqual([])
    } finally {
      await Fs.rm(outside, { recursive: true, force: true })
    }
  })

  it("refuses a cache directory whose parent is a link out of the workspace", async () => {
    const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-outside-"))
    try {
      await Fs.symlink(outside, NodePath.join(root, "state"))

      await expect(openCache({ workspaceRoot: root, cacheDirectory: "state/flows" }))
        .rejects.toThrow(/cache directory leaves the workspace/)
      expect(await Fs.readdir(outside)).toEqual([])
    } finally {
      await Fs.rm(outside, { recursive: true, force: true })
    }
  })

  it("accepts a cache directory linked to another place inside the workspace", async () => {
    await Fs.mkdir(NodePath.join(root, "state"), { recursive: true })
    await Fs.symlink(NodePath.join(root, "state"), NodePath.join(root, ".flows"))

    const cache = await openCache({ workspaceRoot: root })
    await cache.put(result.key, result)
    expect(await cache.get(result.key)).toEqual(result)
    await cache.close()
  })

  it.skipIf(process.platform === "win32")("refuses a shard directory linked outside the cache root", async () => {
    const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-cache-shard-outside-"))
    try {
      const initial = await openCache({ workspaceRoot: root })
      await initial.close()
      await Fs.symlink(outside, NodePath.join(root, ".flows/cache/al"))

      const cache = await openCache({ workspaceRoot: root })
      await expect(cache.get(result.key)).rejects.toThrow(/cache shard directory leaves its allowed root/)
      await expect(cache.put(result.key, result)).rejects.toThrow(/cache shard directory leaves its allowed root/)
      expect(await Fs.readdir(outside)).toEqual([])
      await cache.close()
    } finally {
      await Fs.rm(outside, { recursive: true, force: true })
    }
  })

  describe("local entry reads are bounded and untrusted", () => {
    const entryPath = (): string => NodePath.join(root, ".flows/cache/al/alpha.json")

    it("refuses an entry path that is a symbolic link", async () => {
      // A link planted at an entry path must not let the cache read a file
      // elsewhere and answer with it, even when that file decodes cleanly.
      const elsewhere = NodePath.join(root, "planted.json")
      await Fs.writeFile(elsewhere, JSON.stringify(result), "utf8")
      await Fs.mkdir(NodePath.dirname(entryPath()), { recursive: true })
      await Fs.symlink(elsewhere, entryPath())

      const cache = await openCache({ workspaceRoot: root })
      expect(await cache.get("alpha")).toBeNull()
      await cache.close()
    })

    it.skipIf(process.platform === "win32")(
      "refuses an entry path that is a FIFO instead of blocking on it",
      async () => {
        // Opening a FIFO for reading blocks until a writer appears. A run that
        // blocked there would never finish and would never report why.
        await Fs.mkdir(NodePath.dirname(entryPath()), { recursive: true })
        execFileSync("mkfifo", [entryPath()])

        const cache = await openCache({ workspaceRoot: root })
        expect(await cache.get("alpha")).toBeNull()
        await cache.close()
      }
    )

    it("refuses an entry path that is a directory", async () => {
      await Fs.mkdir(entryPath(), { recursive: true })

      const cache = await openCache({ workspaceRoot: root })
      expect(await cache.get("alpha")).toBeNull()
      await cache.close()
    })

    it("treats an oversize entry as a miss instead of reading it into memory", async () => {
      await Fs.mkdir(NodePath.dirname(entryPath()), { recursive: true })
      await Fs.writeFile(entryPath(), Buffer.alloc(entryLimit + 1, 0x61))

      const cache = await openCache({ workspaceRoot: root })
      expect(await cache.get("alpha")).toBeNull()
      await cache.close()
    })

    it("treats invalid UTF-8 as a miss instead of decoding replacement characters", async () => {
      await Fs.mkdir(NodePath.dirname(entryPath()), { recursive: true })
      await Fs.writeFile(entryPath(), invalidUtf8Entry())

      const cache = await openCache({ workspaceRoot: root })
      expect(await cache.get("alpha")).toBeNull()
      await cache.close()
    })

    it.skipIf(process.platform === "win32")("refuses a hard-linked entry", async () => {
      const planted = NodePath.join(root, "planted.json")
      await Fs.writeFile(planted, JSON.stringify(result), "utf8")
      await Fs.mkdir(NodePath.dirname(entryPath()), { recursive: true })
      await Fs.link(planted, entryPath())

      const cache = await openCache({ workspaceRoot: root })
      expect(await cache.get("alpha")).toBeNull()
      await cache.close()
    })
  })

  describe("remote requests have real deadlines", () => {
    const timeouts = { get: 25, put: 25 } as const

    /**
     * The regression: `withDeadline` only aborted the signal. A custom fetch,
     * a polyfill, or a proxy that ignores `AbortSignal` left the run waiting
     * forever on a timer that had already fired. The deadline is now a race
     * the timer wins on its own.
     */
    it("gives up on a fetch that ignores its abort signal", async () => {
      const warnings: Array<string> = []
      const cache = await openCache({
        workspaceRoot: root,
        endpoint,
        timeouts,
        fetch: () => new Promise<Response>(() => {}),
        warn: (line) => warnings.push(line)
      })

      expect(await cache.get("alpha")).toBeNull()
      expect(warnings).toHaveLength(1)
      await cache.close()
    })

    it("gives up on a put whose fetch ignores its abort signal", async () => {
      const warnings: Array<string> = []
      const cache = await openCache({
        workspaceRoot: root,
        endpoint,
        timeouts,
        fetch: () => new Promise<Response>(() => {}),
        warn: (line) => warnings.push(line)
      })

      await expect(cache.put(result.key, result)).resolves.toBeUndefined()
      expect(warnings).toEqual([
        "smthrs: remote cache disabled after a failure: PUT request failed: remote cache put timed out after 25ms"
      ])
      await cache.close()
    })

    /**
     * The regression: the GET body was read with `response.json()` outside the
     * deadline, so a request that answered its headers promptly and then never
     * finished its body hung the run after the deadline had already passed.
     */
    it("gives up on a response whose body never completes", async () => {
      const warnings: Array<string> = []
      const cache = await openCache({
        workspaceRoot: root,
        endpoint,
        timeouts,
        fetch: () =>
          Promise.resolve(
            new Response(new ReadableStream({ start: () => {} }), {
              status: 200,
              headers: { "content-type": "application/json" }
            })
          ),
        warn: (line) => warnings.push(line)
      })

      expect(await cache.get("alpha")).toBeNull()
      expect(warnings).toHaveLength(1)
      await cache.close()
    })

    it("does not wait for a response-body cancellation that never settles", async () => {
      const body = new ReadableStream<Uint8Array>({
        cancel: () => new Promise<void>(() => {})
      })
      const cache = await openCache({
        workspaceRoot: root,
        endpoint,
        timeouts,
        fetch: () => Promise.resolve(new Response(body, { status: 404 })),
        warn: () => {}
      })

      expect(await cache.get("alpha")).toBeNull()
      await cache.close()
    })

    it.each([
      ["shorter", "3"],
      ["longer", "1"]
    ])("refuses a body %s than its declared content length", async (_name, contentLength) => {
      const warnings: Array<string> = []
      const cache = await openCache({
        workspaceRoot: root,
        endpoint,
        fetch: () =>
          Promise.resolve(
            new Response("{}", {
              status: 200,
              headers: { "content-length": contentLength }
            })
          ),
        warn: (line) => warnings.push(line)
      })

      expect(await cache.get("alpha")).toBeNull()
      expect(warnings).toHaveLength(1)
      await cache.close()
    })

    it("does not mistake an object with only a result member for a cache envelope", async () => {
      const warnings: Array<string> = []
      const cache = await openCache({
        workspaceRoot: root,
        endpoint,
        fetch: () => Promise.resolve(new Response(JSON.stringify({ result }), { status: 200 })),
        warn: (line) => warnings.push(line)
      })

      expect(await cache.get("alpha")).toBeNull()
      expect(warnings).toHaveLength(1)
      await cache.close()
    })

    it("refuses an envelope whose key does not match its request path", async () => {
      const warnings: Array<string> = []
      const cache = await openCache({
        workspaceRoot: root,
        endpoint,
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({ keyDigest: "beta", result }),
              { status: 200 }
            )
          ),
        warn: (line) => warnings.push(line)
      })

      expect(await cache.get("alpha")).toBeNull()
      expect(warnings).toHaveLength(1)
      await cache.close()
    })

    it("refuses a body that declares more than the entry limit", async () => {
      const cache = await openCache({
        workspaceRoot: root,
        endpoint,
        timeouts,
        fetch: () =>
          Promise.resolve(
            new Response("{}", {
              status: 200,
              headers: { "content-length": String(entryLimit + 1) }
            })
          ),
        warn: () => {}
      })

      expect(await cache.get("alpha")).toBeNull()
      await cache.close()
    })

    it("abandons a streaming body that grows past the remote entry limit", async () => {
      // No `Content-Length` at all: the ceiling has to be enforced while the
      // stream is read, or a chunked response is unbounded.
      const chunk = new Uint8Array(1024 * 1024).fill(0x61)
      let sent = 0
      const cache = await openCache({
        workspaceRoot: root,
        endpoint,
        timeouts: { get: 5_000, put: 5_000 },
        fetch: () =>
          Promise.resolve(
            new Response(
              new ReadableStream({
                pull: (controller) => {
                  sent += chunk.byteLength
                  controller.enqueue(chunk)
                }
              }),
              { status: 200 }
            )
          ),
        warn: () => {}
      })

      expect(await cache.get("alpha")).toBeNull()
      // Bounded: the stream is abandoned rather than drained. The slack is the
      // stream's own read-ahead, not accumulated bytes.
      expect(sent).toBeGreaterThan(remoteEntryLimit)
      expect(sent).toBeLessThanOrEqual(remoteEntryLimit + 2 * chunk.byteLength)
      await cache.close()
    })

    it("abandons a bounded response made of unbounded empty chunks", async () => {
      let sent = 0
      const cache = await openCache({
        workspaceRoot: root,
        endpoint,
        fetch: () =>
          Promise.resolve(
            new Response(
              new ReadableStream({
                pull: (controller) => {
                  sent += 1
                  controller.enqueue(new Uint8Array())
                }
              }),
              { status: 200 }
            )
          ),
        warn: () => {}
      })

      expect(await cache.get("alpha")).toBeNull()
      expect(sent).toBeGreaterThan(maximumRemoteBodyChunks)
      expect(sent).toBeLessThan(maximumRemoteBodyChunks * 2)
      await cache.close()
    })

    it("refuses a remote body that is not valid UTF-8", async () => {
      const warnings: Array<string> = []
      const cache = await openCache({
        workspaceRoot: root,
        endpoint,
        fetch: () => Promise.resolve(new Response(invalidUtf8Entry(), { status: 200 })),
        warn: (line) => warnings.push(line)
      })

      expect(await cache.get("alpha")).toBeNull()
      expect(warnings).toHaveLength(1)
      await cache.close()
    })
  })

  it("keeps server-invalid keys local without disabling the remote", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(null, { status: 404 })))
    const warnings: Array<string> = []
    const invalidKey = "control\u0000key"
    const cache = await openCache({
      workspaceRoot: root,
      endpoint,
      fetch,
      warn: (line) => warnings.push(line)
    })

    expect(await cache.get(invalidKey)).toBeNull()
    await cache.put(invalidKey, { ...result, key: invalidKey })
    expect(fetch).not.toHaveBeenCalled()
    expect(await cache.get("valid-miss")).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(warnings).toEqual([])
    await cache.close()
  })

  describe("publication holds its resources honestly", () => {
    const failing = (code: string): Error => Object.assign(new Error(code), { code })

    it("propagates a directory open failure instead of swallowing it", async () => {
      // The old implementation returned early on any open failure, so a cache
      // directory that could not be opened published without its barrier and
      // reported success.
      const cache = await openCache({
        workspaceRoot: root,
        io: { openDirectory: () => Promise.reject(failing("EACCES")) }
      })
      await expect(cache.put(result.key, result)).rejects.toMatchObject({ code: "EACCES" })
      await cache.close()
    })

    it.each(["ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS"])(
      "tolerates a filesystem that answers %s to a directory fsync",
      async (code) => {
        // The entry handle is synced first and the directory handle second, so
        // the second call through the seam is the directory barrier.
        let syncs = 0
        let closed = 0
        const cache = await openCache({
          workspaceRoot: root,
          io: {
            syncHandle: (handle) => {
              syncs += 1
              return syncs === 1 ? handle.sync() : Promise.reject(failing(code))
            },
            closeHandle: (handle) => {
              closed += 1
              return handle.close()
            }
          }
        })
        await expect(cache.put(result.key, result)).resolves.toBeUndefined()
        // Both handles were closed, exactly once each.
        expect(closed).toBe(2)
        expect(await cache.get(result.key)).toEqual(result)
        await cache.close()
      }
    )

    it("propagates an unknown directory fsync failure", async () => {
      let syncs = 0
      const cache = await openCache({
        workspaceRoot: root,
        io: {
          syncHandle: (handle) => {
            syncs += 1
            return syncs === 1 ? handle.sync() : Promise.reject(failing("EIO"))
          }
        }
      })
      await expect(cache.put(result.key, result)).rejects.toMatchObject({ code: "EIO" })
      await cache.close()
    })

    it("fails the put when the entry handle cannot be closed", async () => {
      // A close failure can mean the bytes never reached the device. It must
      // never publish as a clean success.
      const cache = await openCache({
        workspaceRoot: root,
        io: {
          closeHandle: async (handle) => {
            // Model a close that reports failure after releasing the native
            // descriptor. Leaving the injected handle open makes Node surface
            // an unrelated GC-time ERR_INVALID_STATE after the assertion.
            await handle.close()
            throw failing("EIO")
          }
        }
      })
      await expect(cache.put(result.key, result)).rejects.toMatchObject({ code: "EIO" })
      // And the temporary file is gone: cleanup ran, and it did not mask the
      // primary failure.
      expect(await Fs.readdir(NodePath.join(root, ".flows/cache/al"))).toEqual([])
      await cache.close()
    })

    it("reports a publication whose temporary file could not be removed", async () => {
      // The rename is refused and the destination already holds the identical
      // entry, so publication is complete — but the temp survives. Reporting
      // that as a clean success leaks one file per concurrent writer.
      const first = await openCache({ workspaceRoot: root })
      await first.put(result.key, result)
      await first.close()

      const cache = await openCache({
        workspaceRoot: root,
        io: {
          rename: () => Promise.reject(failing("EPERM")),
          removeTemp: () => Promise.reject(failing("EPERM"))
        }
      })
      await expect(cache.put(result.key, result)).rejects.toThrow(/could not be removed|EPERM/)
      await cache.close()
    })

    it("preserves the primary code and reports a cleanup failure too", async () => {
      const cache = await openCache({
        workspaceRoot: root,
        io: {
          writeContents: () => Promise.reject(failing("ENOSPC")),
          removeTemp: () => Promise.reject(failing("EPERM"))
        }
      })
      await expect(cache.put(result.key, result)).rejects.toMatchObject({
        code: "ENOSPC",
        message: expect.stringMatching(/ENOSPC.*EPERM/)
      })
      await cache.close()
    })
  })

  it("warns once and permanently degrades to local-only after a remote failure", async () => {
    const warnings: Array<string> = []
    respond = (_request, response) => {
      response.writeHead(503).end()
    }
    const cache = await openCache({ workspaceRoot: root, endpoint, warn: (line) => warnings.push(line) })
    expect(await cache.get("first")).toBeNull()
    expect(await cache.get("second")).toBeNull()
    await cache.put(result.key, result)
    expect(requests).toHaveLength(1)
    expect(warnings).toEqual([
      "smthrs: remote cache disabled after a failure: GET returned HTTP 503"
    ])
    expect(await cache.get(result.key)).toEqual(result)
    await cache.close()
  })
})

/**
 * The cache had one credential, so every job that could read it could publish
 * to it. Reads and writes now authenticate separately, and the property is on
 * the wire: what the transport sends, not what the configuration says.
 */
describe("the remote cache authenticates reads and writes separately", () => {
  it("presents the read credential on GET and the write credential on PUT", async () => {
    respond = (_request, response) => {
      response.writeHead(404).end()
    }
    const cache = await openCache({
      workspaceRoot: root,
      endpoint,
      readToken: () => "read-only-credential",
      writeToken: () => "write-credential"
    })

    expect(await cache.get(result.key)).toBeNull()
    await cache.put(result.key, result)

    expect(requests.map(({ authorization, method }) => ({ authorization, method }))).toEqual([
      { method: "GET", authorization: "Bearer read-only-credential" },
      { method: "PUT", authorization: "Bearer write-credential" }
    ])
    await cache.close()
  })

  /** A deployment with one credential keeps sending it in both directions. */
  it("presents the single credential in both directions when no write credential is declared", async () => {
    respond = (_request, response) => {
      response.writeHead(404).end()
    }
    const cache = await openCache({ workspaceRoot: root, endpoint, readToken: () => "one-credential" })

    expect(await cache.get(result.key)).toBeNull()
    await cache.put(result.key, result)

    expect(requests.map(({ authorization }) => authorization)).toEqual([
      "Bearer one-credential",
      "Bearer one-credential"
    ])
    await cache.close()
  })

  /**
   * A read-only job is the expected posture, not a broken deployment: the
   * server refuses its publication and its reads are still exactly what the
   * cache is for. Treating the refusal as a remote failure disabled the whole
   * store, so the first cacheable target in a pull request cost the run every
   * later cache hit.
   */
  it.each([401, 403])("keeps reading after the server refuses a publication with %i", async (status) => {
    const warnings: Array<string> = []
    respond = (request, response) => {
      if (request.method === "PUT") {
        response.writeHead(status).end()
        return
      }
      response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ keyDigest: "beta", result: { ...result, key: "beta" } }))
    }
    const cache = await openCache({
      workspaceRoot: root,
      endpoint,
      readToken: () => "read-only-credential",
      warn: (line) => warnings.push(line)
    })

    await cache.put(result.key, result)
    expect(await cache.get("beta")).toEqual({ ...result, key: "beta" })

    expect(warnings).toEqual(["smthrs: remote cache publication refused; this credential may only read"])
    expect(requests.map(({ method }) => method)).toEqual(["PUT", "GET"])
    await cache.close()
  })

  it("stops attempting publications once one was refused", async () => {
    const warnings: Array<string> = []
    respond = (request, response) => {
      response.writeHead(request.method === "PUT" ? 403 : 404).end()
    }
    const cache = await openCache({ workspaceRoot: root, endpoint, warn: (line) => warnings.push(line) })

    await cache.put(result.key, result)
    await cache.put("second", { ...result, key: "second" })

    expect(requests.map(({ method }) => method)).toEqual(["PUT"])
    expect(warnings).toHaveLength(1)
    await cache.close()
  })

  it("reads the write credential only while a publication is being built", async () => {
    respond = (request, response) => {
      response.writeHead(request.method === "PUT" ? 201 : 404).end()
    }
    let reads = 0
    const cache = await openCache({
      workspaceRoot: root,
      endpoint,
      readToken: () => "read-only-credential",
      writeToken: () => {
        reads += 1
        return "write-credential"
      }
    })

    expect(await cache.get(result.key)).toBeNull()
    expect(reads).toBe(0)
    await cache.put(result.key, result)
    expect(reads).toBe(1)
    await cache.close()
  })
})

/**
 * Defence in depth behind the credential split. A job whose inputs nobody
 * reviewed can publish a green result for a target whose real input was never
 * declared. The split stops it from publishing at all when it holds only the
 * read credential; the namespace stops what it does publish from ever being
 * the answer a trusted build reads.
 */
describe("a publication namespace keeps an untrusted result off the trusted key", () => {
  /** A server that stores what is published and serves it back by path. */
  const storeByPath = (): Map<string, string> => {
    const stored = new Map<string, string>()
    respond = (request, response) => {
      const path = request.url ?? ""
      if (request.method === "PUT") {
        const body = requests[requests.length - 1]?.body ?? ""
        stored.set(path, body)
        response.writeHead(201).end()
        return
      }
      const entry = stored.get(path)
      if (entry === undefined) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { "content-type": "application/json" }).end(entry)
    }
    return stored
  }

  it("publishes under the namespaced key and leaves the trusted key a miss", async () => {
    const stored = storeByPath()
    const trustedRoot = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-cache-trusted-"))
    try {
      const untrusted = await openCache({
        workspaceRoot: root,
        endpoint,
        writeToken: () => "write-credential",
        publishNamespace: "pull-request"
      })
      await untrusted.put(result.key, result)
      await untrusted.close()

      // The publication really happened, under the namespaced key.
      expect([...stored.keys()]).toEqual(["/ac/pull-request%2Falpha"])
      expect(JSON.parse(stored.get("/ac/pull-request%2Falpha")!)).toMatchObject({
        keyDigest: "pull-request/alpha"
      })

      // Trunk computes the same content key and finds nothing.
      const trusted = await openCache({ workspaceRoot: trustedRoot, endpoint })
      expect(await trusted.get(result.key)).toBeNull()
      await trusted.close()
    } finally {
      await Fs.rm(trustedRoot, { recursive: true, force: true })
    }
  })

  it("still reads the trusted keyspace, so an untrusted job keeps its cache hits", async () => {
    const stored = storeByPath()
    try {
      const trunk = await openCache({ workspaceRoot: root, endpoint, writeToken: () => "write-credential" })
      await trunk.put(result.key, result)
      await trunk.close()
      expect([...stored.keys()]).toEqual(["/ac/alpha"])

      const untrustedRoot = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-cache-untrusted-"))
      try {
        const untrusted = await openCache({ workspaceRoot: untrustedRoot, endpoint, publishNamespace: "pull-request" })
        expect(await untrusted.get(result.key)).toEqual(result)
        await untrusted.close()
      } finally {
        await Fs.rm(untrustedRoot, { recursive: true, force: true })
      }
    } finally {
      respond = (_request, response) => {
        response.writeHead(404).end()
      }
    }
  })

  it.each([
    ["a path separator", "pull/request"],
    ["a leading separator", "/trunk"],
    ["a leading dot", ".trunk"],
    ["a control character", "trunk\n"],
    ["an unpaired surrogate", "\ud800"],
    ["an unbounded name", "n".repeat(200)],
    ["a non-string", 7]
  ])("refuses %s as a publication namespace before creating cache state", async (_name, namespace) => {
    await expect(openCache({ workspaceRoot: root, endpoint, publishNamespace: namespace as never }))
      .rejects.toThrow(/publishNamespace/)
    await expect(Fs.stat(NodePath.join(root, ".flows"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("publishNamespaceFromEnvironment", () => {
  it.each([
    ["unset", undefined],
    ["empty, as a push to main renders it", ""],
    ["blank", "  \t"]
  ])("reads %s as the trusted keyspace", (_name, value) => {
    expect(publishNamespaceFromEnvironment(value)).toBeUndefined()
  })

  it("keeps a pull request's namespace, trimmed", () => {
    expect(publishNamespaceFromEnvironment(" pr-42 ")).toBe("pr-42")
  })

  it("names the variable when the value is unusable", () => {
    expect(() => publishNamespaceFromEnvironment("pr/42")).toThrow(/^SMITHERS_CACHE_NAMESPACE must be/)
  })
})

describe("the shared tier admits only confined results", () => {
  it("keeps a put marked shared: false in the local tier", async () => {
    const methods: Array<string> = []
    const cache = await openCache({
      workspaceRoot: root,
      endpoint,
      fetch: (_input, init) => {
        methods.push(init?.method ?? "GET")
        return Promise.resolve(new Response(null, { status: 201 }))
      },
      warn: () => {}
    })
    await cache.put(result.key, result, { shared: false })
    expect(methods).toEqual([])
    expect(await cache.get(result.key)).toEqual(result)
    await cache.put(result.key, result)
    expect(methods).toEqual(["PUT"])
    await cache.close()
  })
})
