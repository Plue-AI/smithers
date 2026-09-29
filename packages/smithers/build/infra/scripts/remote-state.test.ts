import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import type { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import * as Effect from "effect/Effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const baselineReadFault = vi.hoisted(() => ({ path: "", enabled: false }))
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<{ readFile: typeof readFile }>()
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (baselineReadFault.enabled && args[0] === baselineReadFault.path) {
        throw Object.assign(new Error("baseline read denied"), { code: "EACCES" })
      }
      return fs.readFile(...args)
    }
  }
})
import { stackName } from "../deployment.ts"
import {
  memoryStateBucket,
  openRemoteState,
  r2CredentialsFromApiToken,
  r2StateBucket,
  readStateSnapshot,
  remoteStateFromEnvironment,
  stateBucketName,
  stateObjectKey,
  WeakEtagError,
  writeStateSnapshot
} from "./remote-state.ts"

let directory: string

beforeEach(async () => {
  directory = await realpath(await mkdtemp(NodePath.join(tmpdir(), "smithers-remote-state-")))
})

afterEach(async () => {
  baselineReadFault.enabled = false
  await rm(directory, { recursive: true, force: true })
})

const put = async (relative: string, body: string): Promise<void> => {
  const file = NodePath.join(directory, relative)
  await mkdir(NodePath.dirname(file), { recursive: true })
  await writeFile(file, body, "utf8")
}

const read = (relative: string): string => readFileSync(NodePath.join(directory, relative), "utf8")

const holder = { host: "operator-host", pid: 4242, startedAt: "2026-09-24T00:00:00.000Z" }

describe("state snapshots", () => {
  it("captures every JSON state file and nothing else, keyed by its path in the stack", async () => {
    await put("prod/CacheWorker.json", `{"a":1}`)
    await put("prod/__stack_output__.json", `{"url":"https://build.smithers.sh"}`)
    await put("dev_will/CacheBucket.json", `{"b":2}`)
    await put(".smithers-state-owner.lock", "123\n")
    await put("prod/CacheWorker.json.4242.abc.tmp", "{")

    const snapshot = JSON.parse(await readStateSnapshot(directory))

    expect(snapshot).toEqual({
      format: "smithers-alchemy-state/1",
      files: {
        "dev_will/CacheBucket.json": `{"b":2}`,
        "prod/CacheWorker.json": `{"a":1}`,
        "prod/__stack_output__.json": `{"url":"https://build.smithers.sh"}`
      }
    })
  })

  it("renders the same bytes for the same state, so an unchanged run publishes nothing", async () => {
    await put("prod/B.json", "2")
    await put("prod/A.json", "1")
    const first = await readStateSnapshot(directory)
    await rm(NodePath.join(directory, "prod", "A.json"))
    await put("prod/A.json", "1")

    expect(await readStateSnapshot(directory)).toBe(first)
  })

  it("reads a missing stack directory as empty state", async () => {
    const snapshot = JSON.parse(await readStateSnapshot(NodePath.join(directory, "absent")))
    expect(snapshot.files).toEqual({})
  })

  it("reports a state path that is not a directory", async () => {
    await put("file", "x")
    await expect(readStateSnapshot(NodePath.join(directory, "file"))).rejects.toThrow(/ENOTDIR/)
  })

  it("refuses a state tree reached through a symbolic link", async () => {
    await mkdir(NodePath.join(directory, "elsewhere"))
    await symlink(NodePath.join(directory, "elsewhere"), NodePath.join(directory, "prod"))

    await expect(readStateSnapshot(directory)).rejects.toThrow(/symbolic link/)
  })

  it("replaces local state with the snapshot and keeps the ownership lock", async () => {
    await put("prod/Stale.json", "stale")
    await put("dev_will/Old.json", "old")
    await put(".smithers-state-owner.lock", "123\n")
    const snapshot = JSON.stringify({
      format: "smithers-alchemy-state/1",
      files: { "prod/CacheWorker.json": `{"live":true}` }
    })

    await writeStateSnapshot(directory, snapshot)

    expect(read("prod/CacheWorker.json")).toBe(`{"live":true}`)
    expect(existsSync(NodePath.join(directory, "prod", "Stale.json"))).toBe(false)
    expect(existsSync(NodePath.join(directory, "dev_will", "Old.json"))).toBe(false)
    expect(read(".smithers-state-owner.lock")).toBe("123\n")
    expect(await readStateSnapshot(directory)).toBe(JSON.stringify(JSON.parse(snapshot), null, 2))
  })

  it.each([
    ["immediate ancestor first", ["prod/dir.json", "prod/dir.json/Child.json"]],
    ["immediate descendant first", ["prod/dir.json/Child.json", "prod/dir.json"]],
    ["deep ancestor first", ["prod/dir.json", "prod/dir.json/deep/Child.json"]],
    ["deep descendant first", ["prod/dir.json/deep/Child.json", "prod/dir.json"]]
  ])("refuses a %s file collision before changing local state", async (_name, paths) => {
    await put("prod/Keep.json", "keep")
    await put("prod/nested/Other.json", "other")
    await put("prod/nested/notes.txt", "notes")
    await put(".smithers-state-owner.lock", "123\n")
    const originalTree = (await readdir(directory, { recursive: true })).sort()
    const originalState = await readStateSnapshot(directory)
    const snapshot = JSON.stringify({
      format: "smithers-alchemy-state/1",
      files: Object.fromEntries(paths.map((path, index) => [path, `{"order":${index}}`]))
    })

    const failure = await writeStateSnapshot(directory, snapshot).catch((cause: unknown) => cause)

    expect((await readdir(directory, { recursive: true })).sort()).toEqual(originalTree)
    expect(await readStateSnapshot(directory)).toBe(originalState)
    expect(read("prod/Keep.json")).toBe("keep")
    expect(read("prod/nested/Other.json")).toBe("other")
    expect(read("prod/nested/notes.txt")).toBe("notes")
    expect(read(".smithers-state-owner.lock")).toBe("123\n")
    expect(failure).toBeInstanceOf(TypeError)
  })

  it("accepts nested paths and a file whose name prefixes a sibling directory", async () => {
    const files = {
      "prod/dir.json": "parent",
      "prod/dir.json2/Child.json": "sibling",
      "prod/tree/deep/Child.json": "nested"
    }

    await writeStateSnapshot(directory, JSON.stringify({ format: "smithers-alchemy-state/1", files }))

    expect(JSON.parse(await readStateSnapshot(directory)).files).toEqual(files)
  })

  it.each([
    ["not JSON", "{"],
    ["another format", JSON.stringify({ format: "other", files: {} })],
    ["files that are not an object", JSON.stringify({ format: "smithers-alchemy-state/1", files: [] })],
    ["a non-string file body", JSON.stringify({ format: "smithers-alchemy-state/1", files: { "prod/A.json": 1 } })],
    ["a parent segment", JSON.stringify({ format: "smithers-alchemy-state/1", files: { "../A.json": "{}" } })],
    ["a current segment", JSON.stringify({ format: "smithers-alchemy-state/1", files: { "./A.json": "{}" } })],
    ["an absolute path", JSON.stringify({ format: "smithers-alchemy-state/1", files: { "/tmp/A.json": "{}" } })],
    ["a backslash", JSON.stringify({ format: "smithers-alchemy-state/1", files: { "prod\\A.json": "{}" } })],
    ["a control character", JSON.stringify({ format: "smithers-alchemy-state/1", files: { "prod/A\u0000.json": "{}" } })],
    ["a file that is not JSON state", JSON.stringify({ format: "smithers-alchemy-state/1", files: { "prod/A.txt": "x" } })],
    ["no object at all", "null"]
  ])("refuses a snapshot with %s before touching local state", async (_name, body) => {
    await put("prod/Keep.json", "keep")

    await expect(writeStateSnapshot(directory, body)).rejects.toThrow(TypeError)
    expect(read("prod/Keep.json")).toBe("keep")
  })
})

describe("remote state sessions", () => {
  it("starts from empty state, publishes the first snapshot only when it holds state, and frees the lock", async () => {
    const bucket = memoryStateBucket()
    const remote = { bucket, key: "alchemy/Stack.json" }

    const empty = await openRemoteState(remote, directory, holder)
    expect(await empty.push()).toBe("unchanged")
    await empty.release()
    expect(bucket.objects.size).toBe(0)

    const session = await openRemoteState(remote, directory, holder)
    expect(bucket.objects.has("alchemy/Stack.json.lock")).toBe(true)
    await put("prod/CacheWorker.json", `{"a":1}`)
    expect(await session.push()).toBe("published")
    await session.release()

    expect(bucket.objects.has("alchemy/Stack.json.lock")).toBe(false)
    expect(JSON.parse(bucket.objects.get("alchemy/Stack.json")!.body).files).toEqual({
      "prod/CacheWorker.json": `{"a":1}`
    })
  })

  it("pulls the remote snapshot over stale local state, so a new machine plans against production", async () => {
    const bucket = memoryStateBucket()
    const remote = { bucket, key: "alchemy/Stack.json" }
    const publisher = await openRemoteState(remote, directory, holder)
    await put("prod/CacheWorker.json", `{"live":true}`)
    await publisher.push()
    await publisher.release()

    const other = await realpath(await mkdtemp(NodePath.join(tmpdir(), "smithers-remote-state-other-")))
    try {
      await mkdir(NodePath.join(other, "prod"), { recursive: true })
      await writeFile(NodePath.join(other, "prod", "Forked.json"), "{}", "utf8")
      const session = await openRemoteState(remote, other, holder)

      expect(await readdir(NodePath.join(other, "prod"))).toEqual(["CacheWorker.json"])
      expect(await session.push()).toBe("unchanged")
      await session.release()
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it("refuses a second deployment while the remote lock is held, naming its holder", async () => {
    const bucket = memoryStateBucket()
    const remote = { bucket, key: "alchemy/Stack.json" }
    const first = await openRemoteState(remote, directory, holder)

    await expect(openRemoteState(remote, directory, { ...holder, host: "ci-runner", pid: 7 })).rejects.toThrow(
      /operator-host.*4242.*alchemy\/Stack\.json\.lock/
    )
    await first.release()
    const second = await openRemoteState(remote, directory, holder)
    await second.release()
  })

  it("reports a lock whose holder cannot be read", async () => {
    const bucket = memoryStateBucket()
    await bucket.put("alchemy/Stack.json.lock", "garbage", { ifAbsent: true })

    await expect(openRemoteState({ bucket, key: "alchemy/Stack.json" }, directory, holder)).rejects.toThrow(
      /unreadable holder/
    )
  })

  it("reports a lock released between the collision and the read", async () => {
    const bucket = memoryStateBucket()
    const racing = {
      ...bucket,
      put: async () => false
    }

    await expect(openRemoteState({ bucket: racing, key: "alchemy/Stack.json" }, directory, holder)).rejects.toThrow(
      /released while it was read/
    )
  })

  it("frees the lock when the pull fails", async () => {
    const bucket = memoryStateBucket()
    await bucket.put("alchemy/Stack.json", "{", { ifAbsent: true })

    await expect(openRemoteState({ bucket, key: "alchemy/Stack.json" }, directory, holder)).rejects.toThrow(TypeError)
    expect(bucket.objects.has("alchemy/Stack.json.lock")).toBe(false)
  })

  it("frees the lock after a pulled baseline read fails and permits a retry", async () => {
    const bucket = memoryStateBucket()
    const remote = { bucket, key: "alchemy/Stack.json" }
    await bucket.put(remote.key, JSON.stringify({
      format: "smithers-alchemy-state/1",
      files: { "prod/A.json": "{}" }
    }), { ifAbsent: true })
    baselineReadFault.path = NodePath.join(directory, "prod/A.json")
    baselineReadFault.enabled = true

    await expect(openRemoteState(remote, directory, holder)).rejects.toThrow("baseline read denied")
    expect(bucket.objects.has(`${remote.key}.lock`)).toBe(false)
    baselineReadFault.enabled = false

    const session = await openRemoteState(remote, directory, holder)
    expect(await session.push()).toBe("unchanged")
    await session.release()
    expect(bucket.objects.has(`${remote.key}.lock`)).toBe(false)
  })

  it("keeps the baseline read failure when lock cleanup also fails", async () => {
    const bucket = memoryStateBucket()
    const key = "alchemy/Stack.json"
    await bucket.put(key, JSON.stringify({
      format: "smithers-alchemy-state/1",
      files: { "prod/A.json": "{}" }
    }), { ifAbsent: true })
    baselineReadFault.path = NodePath.join(directory, "prod/A.json")
    baselineReadFault.enabled = true

    await expect(openRemoteState({
      key,
      bucket: { ...bucket, delete: async () => { throw new Error("cleanup failed") } }
    }, directory, holder)).rejects.toThrow("baseline read denied")
  })

  it("refuses to overwrite remote state that changed during the run", async () => {
    const bucket = memoryStateBucket()
    const remote = { bucket, key: "alchemy/Stack.json" }
    const session = await openRemoteState(remote, directory, holder)
    await bucket.put("alchemy/Stack.json", JSON.stringify({ format: "smithers-alchemy-state/1", files: {} }), {
      ifAbsent: true
    })
    await put("prod/CacheWorker.json", "{}")

    await expect(session.push()).rejects.toThrow(/changed during this deployment/)
    await session.release()
  })

  it("publishes over the pulled version when the run changed state", async () => {
    const bucket = memoryStateBucket()
    const remote = { bucket, key: "alchemy/Stack.json" }
    const first = await openRemoteState(remote, directory, holder)
    await put("prod/CacheWorker.json", "1")
    await first.push()
    await first.release()

    const second = await openRemoteState(remote, directory, holder)
    await put("prod/CacheWorker.json", "2")
    expect(await second.push()).toBe("published")
    await second.release()

    expect(JSON.parse(bucket.objects.get("alchemy/Stack.json")!.body).files["prod/CacheWorker.json"]).toBe("2")
  })

  it("keeps the memory bucket's conditional writes honest", async () => {
    const bucket = memoryStateBucket()
    expect(await bucket.put("k", "a", { ifAbsent: true })).toBe(true)
    expect(await bucket.put("k", "b", { ifAbsent: true })).toBe(false)
    expect(await bucket.put("k", "b", { ifMatch: "stale" })).toBe(false)
    expect(await bucket.put("k", "b", { ifMatch: bucket.objects.get("k")!.etag })).toBe(true)
    expect(await bucket.put("absent", "b", { ifMatch: "any" })).toBe(false)
    expect((await bucket.get("k"))?.body).toBe("b")
    await bucket.delete("k")
    expect(await bucket.get("k")).toBeUndefined()
  })
})

interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly body: string | undefined
}

const recordingFetch = (respond: (request: RecordedRequest) => Response) => {
  const requests: Array<RecordedRequest> = []
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const recorded = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body === null ? undefined : await request.text()
    }
    requests.push(recorded)
    return respond(recorded)
  }
  return { fetch, requests }
}

const r2Options = { accountId: "acct", bucket: "state", accessKeyId: "key-id", secretAccessKey: "secret" }

describe("the R2 state bucket", () => {
  it("reads an object and its ETag over the signed S3 API", async () => {
    const { fetch, requests } = recordingFetch(() => new Response("body", { status: 200, headers: { etag: `"e1"` } }))
    const bucket = r2StateBucket({ ...r2Options, fetch })

    expect(await bucket.get("alchemy/Stack.json")).toEqual({ body: "body", etag: `"e1"` })
    expect(requests[0]!.url).toBe("https://acct.r2.cloudflarestorage.com/state/alchemy/Stack.json")
    expect(requests[0]!.method).toBe("GET")
    expect(requests[0]!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=key-id\/\d{8}\/auto\/s3\//)
  })

  it("reads a missing object as absent", async () => {
    const { fetch } = recordingFetch(() => new Response("", { status: 404 }))
    expect(await r2StateBucket({ ...r2Options, fetch }).get("k")).toBeUndefined()
  })

  it("refuses an object served without an ETag", async () => {
    const { fetch } = recordingFetch(() => new Response("body", { status: 200 }))
    await expect(r2StateBucket({ ...r2Options, fetch }).get("k")).rejects.toThrow(/ETag/)
  })

  it("names the status of any other read failure", async () => {
    const { fetch } = recordingFetch(() => new Response("denied", { status: 403 }))
    await expect(r2StateBucket({ ...r2Options, fetch }).get("k")).rejects.toThrow(/GET k.*403.*denied/)
  })

  it("writes with the precondition it was given and reports a failed one", async () => {
    let status = 200
    const { fetch, requests } = recordingFetch(() => new Response("", { status }))
    const bucket = r2StateBucket({ ...r2Options, fetch })

    expect(await bucket.put("k", "one", { ifAbsent: true })).toBe(true)
    expect(requests[0]!.headers.get("if-none-match")).toBe("*")
    expect(requests[0]!.headers.get("if-match")).toBeNull()
    expect(requests[0]!.body).toBe("one")
    expect(requests[0]!.method).toBe("PUT")

    status = 412
    expect(await bucket.put("k", "two", { ifMatch: `"e1"` })).toBe(false)
    expect(requests[1]!.headers.get("if-match")).toBe(`"e1"`)
    expect(requests[1]!.headers.get("if-none-match")).toBeNull()

    status = 500
    await expect(bucket.put("k", "three", { ifAbsent: true })).rejects.toThrow(/PUT k.*500/)
  })

  it("pulls state with a plain ETag and saves it back over R2's compressed responses", async () => {
    // R2 as observed live: a GET that accepts gzip gets the compressed object
    // and a weak ETag, which never satisfies If-Match; `identity` gets the
    // plain ETag, and only an exact plain match lets a PUT through.
    let stored = { body: JSON.stringify({ format: "smithers-alchemy-state/1", files: {} }), version: 1 }
    const { fetch, requests } = recordingFetch((request) => {
      const etag = `"v${stored.version}"`
      if (request.method === "GET" && request.url.endsWith("/alchemy/Stack.json")) {
        const identity = request.headers.get("accept-encoding") === "identity"
        return new Response(stored.body, { status: 200, headers: { etag: identity ? etag : `W/${etag}` } })
      }
      if (request.method === "PUT" && request.url.endsWith("/alchemy/Stack.json")) {
        if (request.headers.get("if-match") !== etag) return new Response("", { status: 412 })
        stored = { body: request.body!, version: stored.version + 1 }
        return new Response("", { status: 200 })
      }
      return new Response(null, { status: request.method === "DELETE" ? 204 : 200 })
    })
    const session = await openRemoteState(
      { bucket: r2StateBucket({ ...r2Options, fetch }), key: "alchemy/Stack.json" },
      directory,
      holder
    )
    await put("prod/CacheWorker.json", `{"bundle":"af764b35"}`)

    expect(await session.push()).toBe("published")
    await session.release()
    expect(JSON.parse(stored.body).files["prod/CacheWorker.json"]).toBe(`{"bundle":"af764b35"}`)
    const pull = requests.find((request) => request.method === "GET" && request.url.endsWith("/alchemy/Stack.json"))
    expect(pull!.headers.get("accept-encoding")).toBe("identity")
  })

  it("refuses a weak ETag as a write condition without sending the write", async () => {
    const { fetch, requests } = recordingFetch(() => new Response("", { status: 200 }))
    const bucket = r2StateBucket({ ...r2Options, fetch })

    const refusal = bucket.put("k", "body", { ifMatch: `W/"7fed332f"` })
    await expect(refusal).rejects.toThrow(WeakEtagError)
    await expect(refusal).rejects.toThrow(/state k carries the weak ETag W\/"7fed332f"/)
    expect(requests).toEqual([])
  })

  it("refuses a pulled object that still carries a weak ETag, before anything is deployed", async () => {
    const { fetch } = recordingFetch(() => new Response("body", { status: 200, headers: { etag: `W/"e1"` } }))
    const error = await r2StateBucket({ ...r2Options, fetch }).get("k").catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(WeakEtagError)
    expect(error).toMatchObject({ _tag: "@smthrs/build-infra/WeakEtagError", key: "k", etag: `W/"e1"` })
    const routed = await Effect.runPromise(
      Effect.tryPromise({ try: () => r2StateBucket({ ...r2Options, fetch }).get("k"), catch: (cause) => cause as WeakEtagError })
        .pipe(Effect.catchTag("@smthrs/build-infra/WeakEtagError", (weak) => Effect.succeed(weak.etag)))
    )
    expect(routed).toBe(`W/"e1"`)
  })

  it("deletes an object, and treats one already gone as deleted", async () => {
    let status = 204
    const { fetch, requests } = recordingFetch(() => new Response(null, { status }))
    const bucket = r2StateBucket({ ...r2Options, fetch })

    await bucket.delete("k")
    status = 404
    await bucket.delete("k")
    expect(requests.map((request) => request.method)).toEqual(["DELETE", "DELETE"])

    status = 403
    await expect(bucket.delete("k")).rejects.toThrow(/DELETE k.*403/)
  })
})

describe("R2 credentials", () => {
  it("derives S3 credentials from an account API token", async () => {
    const { fetch, requests } = recordingFetch(() => Response.json({ success: true, result: { id: "token-id" } }))

    const credentials = await r2CredentialsFromApiToken({ apiToken: "api-token", accountId: "acct", fetch })

    expect(credentials).toEqual({
      accessKeyId: "token-id",
      secretAccessKey: createHash("sha256").update("api-token").digest("hex")
    })
    expect(requests[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/tokens/verify")
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer api-token")
  })

  it("falls back to a user API token", async () => {
    const { fetch, requests } = recordingFetch((request) =>
      request.url.includes("/accounts/")
        ? Response.json({ success: false }, { status: 401 })
        : Response.json({ success: true, result: { id: "user-token" } })
    )

    expect((await r2CredentialsFromApiToken({ apiToken: "t", accountId: "acct", fetch })).accessKeyId).toBe("user-token")
    expect(requests[1]!.url).toBe("https://api.cloudflare.com/client/v4/user/tokens/verify")
  })

  it("refuses a token Cloudflare does not verify", async () => {
    const { fetch } = recordingFetch(() => Response.json({ success: false }, { status: 401 }))
    await expect(r2CredentialsFromApiToken({ apiToken: "t", accountId: "acct", fetch })).rejects.toThrow(
      /CLOUDFLARE_API_TOKEN/
    )
  })

  it("refuses a verification that names no token", async () => {
    const { fetch } = recordingFetch(() => Response.json({ success: true, result: {} }))
    await expect(r2CredentialsFromApiToken({ apiToken: "t", accountId: "acct", fetch })).rejects.toThrow(
      /CLOUDFLARE_API_TOKEN/
    )
  })

  it("builds the production remote state from the deploying shell", async () => {
    const { fetch, requests } = recordingFetch((request) =>
      request.url.startsWith("https://api.cloudflare.com")
        ? Response.json({ success: true, result: { id: "token-id" } })
        : new Response("", { status: 404 })
    )

    const remote = await remoteStateFromEnvironment({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acct" }, fetch)
    expect(remote.key).toBe(stateObjectKey)
    expect(await remote.bucket.get(remote.key)).toBeUndefined()

    expect(stateObjectKey).toBe(`alchemy/${stackName}.json`)
    expect(requests[1]!.url).toBe(`https://acct.r2.cloudflarestorage.com/${stateBucketName}/${stateObjectKey}`)
  })

  it.each([
    [{ CLOUDFLARE_ACCOUNT_ID: "acct" }, /CLOUDFLARE_API_TOKEN/],
    [{ CLOUDFLARE_API_TOKEN: "t" }, /CLOUDFLARE_ACCOUNT_ID/]
  ])("refuses a deploying shell without Cloudflare credentials", async (env, message) => {
    await expect(remoteStateFromEnvironment(env, globalThis.fetch)).rejects.toThrow(message)
  })
})
