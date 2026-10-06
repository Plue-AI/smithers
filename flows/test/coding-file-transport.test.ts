import { NodeServices } from "@effect/platform-node"
import * as ApplyPatch from "@smthrs/std/ApplyPatch"
import * as Read from "@smthrs/std/Read"
import { StdError } from "@smthrs/std/StdError"
import * as Write from "@smthrs/std/Write"
import { Deferred, Effect, Fiber, FileSystem, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import * as Transport from "../coding/file-transport.ts"
import * as CodingFileSystem from "../coding/filesystem.ts"

const workspaceId = "11111111-1111-4111-a111-111111111111"
const repositorySlug = "owner/repo"
const original = "alpha\nbeta\n"
const originalDigest = "e49c81e2d2f84e259d40e2fb8192f3bcd198b355184845d76d8f58807d0d78ee"
const outside = "outside\n"
const outsideDigest = "92a214fa61579091222f97eaf8e9bf11c1a728af5a077a3b5568231b6dc5be43"
const bytes = (value: string) => new TextEncoder().encode(value)
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const grant = (session = "run-a"): Transport.Grant => ({
  session,
  workspaceId,
  repositorySlug,
  expiresAt: Date.now() + 60_000,
  token: Redacted.make("fixture-run-bearer")
})
const options = (apiBaseUrl: string): Transport.Options => ({
  apiBaseUrl,
  root: "/workspace",
  workspaceId,
  repositorySlug,
  authorize: (session) => Effect.succeed(grant(session))
})
const batch = (): Parameters<CodingFileSystem.MutationProvider["compareWrite"]>[0] => ({
  root: "/workspace",
  session: "run-a",
  changes: [{ path: "a.txt", base_digest: originalDigest, content: bytes(outside) }]
})
const success = { changes: [{ path: "a.txt", digest: outsideDigest }] }
const json = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}
const serve = async (
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void
) => {
  const failures: unknown[] = []
  const server = createServer((request, response) => {
    Promise.resolve().then(() => handler(request, response)).catch((error) => {
      failures.push(error)
      response.writeHead(500)
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    assert.deepEqual(failures, [])
  })
  const address = server.address()
  assert(address && typeof address !== "string")
  return `http://127.0.0.1:${address.port}/api`
}
const make = (configuration: Transport.Options) =>
  Effect.runPromise(Transport.make(configuration).pipe(Effect.provide(FetchHttpClient.layer)))
const failure = (effect: Effect.Effect<unknown, StdError>) => Effect.runPromise(Effect.flip(effect))

test("standard file tools send one authenticated HTTP patch and reauthorize each own write", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coding-http-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, "a.txt"), original)
  let revoked = false
  const wire: unknown[] = []
  // Real HTTP and real local files; server authentication/provider are fixtures.
  // This exercises transport, not the composed backend or guest security gate.
  const api = await serve(t, async (request, response) => {
    assert.equal(request.method, "PUT")
    assert.equal(request.url, `/api/repos/${repositorySlug}/workspaces/${workspaceId}/files/content`)
    assert.equal(request.headers.authorization, "Bearer fixture-run-bearer")
    assert.equal(request.headers["content-type"], "application/json")
    assert.equal(request.headers["smithers-via"], undefined)
    if (revoked) {
      json(response, { message: "fixture-run-bearer must not escape" }, 403)
      return
    }
    let text = ""
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text) as {
      changes: Array<{ path: string; base_digest: string; content: string | null; encoding?: string }>
    }
    assert.deepEqual(Object.keys(body), ["changes"])
    wire.push(body)
    for (const change of body.changes) {
      const actual = await readFile(join(root, change.path)).then(hash, () => "absent")
      if (change.base_digest !== actual) {
        json(response, { code: "stale", path: change.path, current_digest: actual }, 409)
        return
      }
    }
    const receipts: Array<{ path: string; digest: string }> = []
    for (const change of body.changes) {
      if (change.content === null) {
        assert.equal(change.encoding, undefined)
        await unlink(join(root, change.path))
        receipts.push({ path: change.path, digest: "absent" })
      } else {
        assert.equal(change.encoding, "base64")
        const content = Buffer.from(change.content, "base64")
        await writeFile(join(root, change.path), content)
        receipts.push({ path: change.path, digest: hash(content) })
      }
    }
    json(response, { changes: receipts.reverse() })
  })
  const authorized: Array<{ session: string; paths: ReadonlyArray<string> }> = []
  let releases = 0
  const provider = await make({
    ...options(api),
    root,
    authorize: (session, paths) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          authorized.push({ session, paths })
          return grant(session)
        }),
        () =>
          Effect.sync(() => {
            releases++
          })
      )
  })
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const coding = CodingFileSystem.make({ repositoryPath: root }, fs, spawner, root, provider)
      const tools = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, coding),
          Effect.provideService(Read.ReadSession, "run-a")
        )
      const a = join(root, "a.txt"), moved = join(root, "moved.txt"), added = join(root, "new.txt")
      yield* tools(Read.run({ path: a, limit: 1 }))
      yield* tools(Write.run({ path: a, content: outside }))
      yield* tools(
        ApplyPatch.run({
          input:
            `*** Begin Patch\n*** Update File: ${a}\n*** Move to: ${moved}\n@@\n-outside\n+alpha\n*** Add File: ${added}\n+new\n*** End Patch`
        })
      )
      assert.equal(yield* fs.exists(a), false)
      assert.equal(yield* fs.readFileString(moved), "alpha\n")
      assert.equal(yield* fs.readFileString(added), "new\n")
      assert.equal(wire.length, 2)
      assert.deepEqual(authorized, [{ session: "run-a", paths: ["a.txt"] }, {
        session: "run-a",
        paths: ["moved.txt", "a.txt", "new.txt"]
      }])
      assert.equal(releases, 2)
      revoked = true
      const refused = yield* Effect.flip(tools(Write.run({ path: moved, content: outside })))
      assert.equal(refused.code, "permission_denied")
      assert.ok(!refused.message.includes("fixture-run-bearer"))
      assert.equal(releases, 3)
      assert.equal(yield* fs.readFileString(moved), "alpha\n")
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

test("transport pins the complete request before asynchronous authorization", async (t) => {
  const api = await serve(t, async (request, response) => {
    let text = ""
    for await (const chunk of request) text += chunk
    assert.deepEqual(JSON.parse(text), {
      changes: [{ path: "a.txt", base_digest: originalDigest, content: "b3V0c2lkZQo=", encoding: "base64" }]
    })
    json(response, success)
  })
  const request = {
    root: "/workspace",
    session: "run-a",
    changes: [{ path: "a.txt", base_digest: originalDigest, content: bytes(outside) }]
  }
  const configuration = {
    ...options(api),
    authorize: () =>
      Effect.sync(() => {
        request.changes[0]!.content.fill(0)
        request.changes[0]!.path = "injected.txt"
        request.session = "another-run"
        configuration.workspaceId = "22222222-2222-4222-a222-222222222222"
        return grant()
      })
  }
  const provider = await make(configuration)
  configuration.apiBaseUrl = "https://elsewhere.invalid/api"
  assert.deepEqual(await Effect.runPromise(provider.compareWrite(request)), success.changes)
})

test("256 paths retain Unicode names and exact binary, empty and deletion payloads", async (t) => {
  const changes = Array.from({ length: 256 }, (_, index) => ({
    path: index === 0 ? "目录/ß.txt" : `${index}.txt`,
    base_digest: "absent",
    content: index === 0 ? new Uint8Array([0, 255, 128, 10]) : index === 1 ? null : new Uint8Array()
  }))
  const expected = changes.map((change) => ({
    path: change.path,
    digest: change.content === null ? "absent" : hash(change.content)
  }))
  const api = await serve(t, async (request, response) => {
    let text = ""
    for await (const chunk of request) text += chunk
    const actual = JSON.parse(text).changes
    assert.equal(actual.length, 256)
    assert.deepEqual(actual[0], { path: "目录/ß.txt", base_digest: "absent", content: "AP+ACg==", encoding: "base64" })
    assert.deepEqual(actual[1], { path: "1.txt", base_digest: "absent", content: null })
    assert.deepEqual(actual[255], { path: "255.txt", base_digest: "absent", content: "", encoding: "base64" })
    const encoded = Buffer.from(JSON.stringify({ changes: expected }), "utf8")
    const split = encoded.indexOf(Buffer.from("目")) + 1
    response.writeHead(200, { "content-type": "application/json" })
    response.write(encoded.subarray(0, split))
    await new Promise<void>((resolve) => setImmediate(resolve))
    response.end(encoded.subarray(split))
  })
  const provider = await make(options(api))
  assert.deepEqual(await Effect.runPromise(provider.compareWrite({ ...batch(), changes })), expected)
})

test("unsafe endpoint and workspace bindings refuse before authority lookup", async () => {
  let calls = 0
  for (
    const change of [
      { apiBaseUrl: "not a url" },
      { apiBaseUrl: "http://example.test/api" },
      { apiBaseUrl: "ftp://localhost/api" },
      { apiBaseUrl: "https://user:secret@example.test/api" },
      { apiBaseUrl: "https://example.test/api?x=1" },
      { apiBaseUrl: "https://example.test/api#fragment" },
      { apiBaseUrl: "https://example.test/elsewhere" },
      { root: "relative" },
      { root: "/workspace/../other" },
      { workspaceId: "../another" },
      { repositorySlug: "owner/repo/extra" },
      { repositorySlug: "../repo" },
      { repositorySlug: "owner/%2e%2e" }
    ]
  ) {
    const refused = await Effect.runPromise(
      Effect.flip(Transport.make({
        ...options("https://example.test/api"),
        ...change,
        authorize: () => {
          calls++
          return Effect.succeed(grant())
        }
      })).pipe(Effect.provide(FetchHttpClient.layer))
    )
    assert.equal(refused.code, "provider_unavailable")
  }
  assert.equal(calls, 0)
})

test("invalid batches and mismatched, expired, or refused grants send no request", async (t) => {
  let requests = 0, issuances = 0
  const api = await serve(t, (_request, response) => {
    requests++
    json(response, success)
  })
  const provider = await make({
    ...options(api),
    authorize: () => {
      issuances++
      return Effect.succeed(grant())
    }
  })
  for (
    const request of [
      { ...batch(), root: "/other" },
      ...["", "bad run", "bad\0run", "bad\x7frun", "a".repeat(257)].map((session) => ({ ...batch(), session })),
      { ...batch(), changes: [] },
      {
        ...batch(),
        changes: Array.from({ length: 257 }, (_, index) => ({ ...batch().changes[0]!, path: `${index}.txt` }))
      },
      { ...batch(), changes: [batch().changes[0]!, batch().changes[0]!] },
      { ...batch(), changes: [batch().changes[0]!, { ...batch().changes[0]!, path: "a.txt/child" }] },
      ...["/abs", "a/../b", "a//b", "./a", "", "bad\0path", "bad\ud800path", "x".repeat(4097)].map((path) => ({
        ...batch(),
        changes: [{ ...batch().changes[0]!, path }]
      })),
      { ...batch(), changes: [{ ...batch().changes[0]!, base_digest: "invalid" }] },
      ...[1024 * 1024, 1024 * 1024 + 1].map((size) => ({
        ...batch(),
        changes: [{ ...batch().changes[0]!, content: new Uint8Array(size) }]
      }))
    ]
  ) assert.ok(["permission_denied", "invalid_input"].includes((await failure(provider.compareWrite(request))).code))
  assert.equal(issuances, 0)
  for (
    const change of [
      { session: "other" },
      { workspaceId: "other" },
      { repositorySlug: "other/repo" },
      { expiresAt: 0 },
      { expiresAt: Number.NaN },
      { token: Redacted.make(" ") }
    ]
  ) {
    const bound = await make({ ...options(api), authorize: () => Effect.succeed({ ...grant(), ...change }) })
    assert.equal((await failure(bound.compareWrite(batch()))).code, "permission_denied")
  }
  const refused = await make({
    ...options(api),
    authorize: () => Effect.fail(new StdError({ code: "permission_denied", message: "Run ended" }))
  })
  assert.equal((await failure(refused.compareWrite(batch()))).code, "permission_denied")
  assert.equal(requests, 0)
})

test("stale responses bind the path and both digests without retry", async (t) => {
  let calls = 0, releases = 0
  const api = await serve(t, (_request, response) => {
    calls++
    json(response, { code: "stale", path: "a.txt", current_digest: outsideDigest }, 409)
  })
  const provider = await make({
    ...options(api),
    authorize: () =>
      Effect.acquireRelease(Effect.succeed(grant()), () =>
        Effect.sync(() => {
          releases++
        }))
  })
  const refused = await failure(provider.compareWrite(batch()))
  assert.equal(refused.code, "stale_read")
  assert.equal(refused.path, "a.txt")
  assert.equal(refused.base_digest, originalDigest)
  assert.equal(refused.current_digest, outsideDigest)
  assert.equal(calls, 1)
  assert.equal(releases, 1)
})

test("malformed, incomplete and oversized replies never become a committed receipt", async (t) => {
  let status = 200, reply: unknown = success, raw: Uint8Array | string | undefined
  let calls = 0
  const api = await serve(t, (_request, response) => {
    calls++
    if (raw !== undefined) {
      response.writeHead(status)
      response.end(raw)
      return
    }
    json(response, reply, status)
  })
  const provider = await make(options(api))
  for (
    const [code, value] of [
      [200, null],
      [200, []],
      [200, { ...success, actor: "forged" }],
      [200, { changes: null }],
      [200, { changes: [] }],
      [200, { changes: [null] }],
      [200, { changes: [{ path: "a.txt", digest: outsideDigest, extra: true }] }],
      [200, { changes: [{ path: 1, digest: outsideDigest }] }],
      [200, { changes: [{ path: "a.txt", digest: 1 }] }],
      [200, { changes: [{ path: "other", digest: outsideDigest }] }],
      [200, { changes: [{ path: "a.txt", digest: originalDigest }] }],
      [409, { code: "stale", current_digest: outsideDigest }],
      [409, { code: "other", path: "a.txt", current_digest: outsideDigest }],
      [409, { code: "stale", path: "other", current_digest: outsideDigest }],
      [409, { code: "stale", path: "a.txt", current_digest: "broken" }],
      [202, success],
      [401, { message: "fixture-run-bearer" }],
      [500, { message: "fixture-run-bearer" }]
    ] as const
  ) {
    status = code
    reply = value
    const previous = calls
    const refused = await failure(provider.compareWrite(batch()))
    assert.equal(refused.code, code === 401 ? "permission_denied" : "provider_unavailable")
    assert.ok(!refused.message.includes("fixture-run-bearer"))
    assert.equal(calls, previous + 1)
  }
  status = 200
  for (
    const invalid of ["{", "{} {}", new Uint8Array([0xff]), new Uint8Array([0xc3]), new Uint8Array(2 * 1024 * 1024 + 1)]
  ) {
    raw = invalid
    assert.equal((await failure(provider.compareWrite(batch()))).code, "provider_unavailable")
  }
  raw = undefined
  reply = { changes: [success.changes[0], success.changes[0]] }
  assert.equal(
    (await failure(
      provider.compareWrite({
        ...batch(),
        changes: [batch().changes[0]!, { path: "b.txt", base_digest: "absent", content: new Uint8Array() }]
      })
    )).code,
    "provider_unavailable"
  )
})

test("redirects never forward credentials or repeat the batch", async (t) => {
  let redirected = 0, calls = 0, status = 307
  const destination = await serve(t, (_request, response) => {
    redirected++
    json(response, success)
  })
  const api = await serve(t, (_request, response) => {
    calls++
    response.writeHead(status, { location: destination })
    response.end()
  })
  const provider = await make(options(api))
  for (const code of [301, 302, 303, 307, 308]) {
    status = code
    assert.equal((await failure(provider.compareWrite(batch()))).code, "provider_unavailable")
  }
  assert.equal(calls, 5)
  assert.equal(redirected, 0)
})

test("an ambiguous disconnected response releases authority and never retries the write", async (t) => {
  let calls = 0, released = 0
  const api = await serve(t, (request) => {
    calls++
    request.socket.destroy()
  })
  const provider = await make({
    ...options(api),
    authorize: () =>
      Effect.acquireRelease(
        Effect.succeed(grant()),
        () =>
          Effect.sync(() => {
            released++
          })
      )
  })
  const refused = await failure(provider.compareWrite(batch()))
  assert.equal(refused.code, "provider_unavailable")
  assert.equal(refused.message, "Workspace file mutation did not return a verified response")
  assert.equal(calls, 1)
  assert.equal(released, 1)
})

test("cancellation and timeout release the run grant and interrupt a single HTTP attempt", async () => {
  for (const cancel of [true, false]) {
    let issued = 0, released = 0, calls = 0, interrupted = 0
    await Effect.runPromise(
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const provider = yield* Transport.make({
          ...options("https://example.test/api"),
          authorize: () =>
            Effect.acquireRelease(
              Effect.sync(() => {
                issued++
                return grant()
              }),
              () =>
                Effect.sync(() => {
                  released++
                })
            )
        }).pipe(Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => {
            calls++
            return Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted++
                })
              )
            )
          })
        ))
        const fiber = yield* Effect.forkChild(Effect.result(provider.compareWrite(batch())))
        yield* Deferred.await(entered)
        if (cancel) yield* Fiber.interrupt(fiber)
        else {
          yield* TestClock.adjust("46 seconds")
          const result = yield* Fiber.join(fiber)
          assert.equal(result._tag, "Failure")
          if (result._tag === "Failure") assert.equal(result.failure.code, "timeout")
        }
      }).pipe(Effect.provide(TestClock.layer()))
    )
    assert.equal(issued, 1)
    assert.equal(released, 1)
    assert.equal(calls, 1)
    assert.equal(interrupted, 1)
  }
})
