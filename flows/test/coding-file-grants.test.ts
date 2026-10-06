import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Deferred, Effect, Fiber, ManagedRuntime, Option } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { test, type TestContext } from "node:test"
import * as Grants from "../coding/file-grants.ts"
import type { MutationProvider } from "../coding/filesystem.ts"
import * as EgressHttpClient from "../../packages/smithers/flows/platform-node/src/EgressHttpClient.ts"

const workspaceId = "11111111-1111-4111-a111-111111111111"
const gatewayId = "22222222-2222-4222-a222-222222222222"
const hostToken = "private-host-credential"
const grantToken = `smithers_${"a".repeat(40)}`
const bytes = (value: string) => Buffer.from(value, "utf8")
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const batch = (): Parameters<MutationProvider["compareWrite"]>[0] => ({
  root: "/workspace",
  session: "Run-A",
  changes: [{ path: "a.txt", base_digest: "absent", content: bytes("new") }]
})
const result = [{ path: "a.txt", digest: hash(bytes("new")) }]
const json = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(value))
}
const fixture = async (t: TestContext, mode = "success") => {
  const calls: string[] = []
  const failures: unknown[] = []
  let digest = ""
  let entered!: () => void
  const writing = new Promise<void>((resolve) => {
    entered = resolve
  })
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    calls.push(request.method!)
    assert.equal(request.headers.authorization, `Bearer ${request.method === "POST" ? hostToken : grantToken}`)
    if (request.method === "DELETE") {
      if (mode === "cleanup-stalled") {
        entered()
        return
      }
      assert.equal(request.url, `/api/gateways/${gatewayId}/file-write-grants/41`)
      response.writeHead(mode === "cleanup-failure" ? 503 : 204)
      response.end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    if (request.method === "POST") {
      if (mode === "issuer-interrupted") {
        entered()
        return
      }
      assert.equal(request.url, `/api/gateways/${gatewayId}/file-write-grants`)
      const subject = JSON.parse(body.toString())
      assert.deepEqual(Object.keys(subject), ["run_id", "batch_digest"])
      assert.equal(subject.run_id, "Run-A")
      digest = subject.batch_digest
      assert.match(digest, /^[a-f0-9]{64}$/)
      if (mode === "issuer-denied") return json(response, { token: hostToken }, 403)
      if (mode === "issuer-redirect") return json(response, { token: hostToken }, 307)
      if (mode === "issuer-invalid-json") {
        response.writeHead(201)
        response.end("{")
        return
      }
      if (mode === "issuer-array") return json(response, [], 201)
      return json(response, {
        token_id: mode === "issuer-invalid-id" ? 0 : 41,
        token: mode === "issuer-invalid-token" ? "wrong" : grantToken,
        run_id: mode === "issuer-wrong-run" ? "Run-B" : subject.run_id,
        workspace_id: workspaceId,
        repository_slug: "owner/repo",
        expires_at: mode === "expired" ? Date.now() - 100 : Date.now() + 60_000,
        batch_digest: mode === "issuer-wrong-batch" ? "b".repeat(64) : digest
      }, 201)
    }
    assert.equal(request.url, `/api/repos/owner/repo/workspaces/${workspaceId}/files/content`)
    assert.equal(hash(body), digest, "grant must bind the exact transmitted JSON bytes")
    if (mode !== "cleanup-stalled") entered()
    if (mode === "interrupted") return
    if (mode === "write-failure") return json(response, { token: grantToken }, 503)
    if (mode === "bad-receipt") return json(response, { changes: [] })
    return json(response, { changes: result })
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      failures.push(error)
      res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    assert.deepEqual(failures, [])
  })
  const address = server.address()
  assert(address && typeof address !== "string")
  const options = {
    apiBaseUrl: `http://127.0.0.1:${address.port}/api`,
    root: "/workspace",
    workspaceId,
    repositorySlug: "owner/repo",
    gatewayId,
    credential: hostToken
  }
  const provider = await Effect.runPromise(Grants.make(options).pipe(Effect.provide(FetchHttpClient.layer)))
  return { calls, provider, writing, options }
}

test("real HTTP issuer binds each exact batch and revokes before returning", async (t) => {
  const f = await fixture(t)
  f.options.credential = "mutated"
  f.options.gatewayId = workspaceId
  assert.deepEqual(await Effect.runPromise(f.provider.compareWrite(batch())), result)
  assert.deepEqual(await Effect.runPromise(f.provider.compareWrite(batch())), result)
  assert.deepEqual(f.calls, ["POST", "PUT", "DELETE", "POST", "PUT", "DELETE"])
})

test("Node file grants retain the host's client through issuance, mutation and revocation", async (t) => {
  const f = await fixture(t)
  const host = ManagedRuntime.make(EgressHttpClient.layer({}))
  t.after(() => host.dispose())
  const provider = await host.runPromise(Grants.make(f.options))
  assert.deepEqual(await host.runPromise(provider.compareWrite(batch())), result)
  assert.deepEqual(f.calls, ["POST", "PUT", "DELETE"])
  await host.dispose()
  const error = await Effect.runPromise(Effect.flip(provider.compareWrite(batch())))
  assert.equal(error.code, "provider_unavailable")
  assert.match(error.message, /issuer transport failed/)
  assert.deepEqual(f.calls, ["POST", "PUT", "DELETE"], "a closed host cannot issue another grant")
  assert(!JSON.stringify(error).includes(hostToken))
  assert(!JSON.stringify(error).includes(grantToken))
})

test("cleanup runs on failed writes, malformed receipts, metadata and expired grants", async (t) => {
  for (const mode of ["write-failure", "bad-receipt", "issuer-wrong-run", "issuer-wrong-batch", "expired"]) {
    await t.test(mode, async (t) => {
      const f = await fixture(t, mode)
      const error = await Effect.runPromise(Effect.flip(f.provider.compareWrite(batch())))
      assert(!JSON.stringify(error).includes(grantToken))
      assert(!JSON.stringify(error).includes(hostToken))
      assert.deepEqual(
        f.calls,
        mode.startsWith("issuer-") || mode === "expired" ? ["POST", "DELETE"] : ["POST", "PUT", "DELETE"]
      )
    })
  }
})

test("unusable issuer responses never reach a workspace write", async (t) => {
  for (
    const mode of [
      "issuer-denied",
      "issuer-redirect",
      "issuer-invalid-json",
      "issuer-array",
      "issuer-invalid-id",
      "issuer-invalid-token"
    ]
  ) {
    await t.test(mode, async (t) => {
      const f = await fixture(t, mode)
      const error = await Effect.runPromise(Effect.flip(f.provider.compareWrite(batch())))
      assert(!JSON.stringify(error).includes(hostToken))
      assert.deepEqual(f.calls, ["POST"])
    })
  }
})

test("interruption revokes an admitted grant before the fiber finishes", async (t) => {
  const f = await fixture(t, "interrupted")
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const fiber = yield* Effect.forkScoped(f.provider.compareWrite(batch()))
    yield* Effect.promise(() => f.writing)
    yield* Fiber.interrupt(fiber)
  })))
  assert.deepEqual(f.calls, ["POST", "PUT", "DELETE"])
})

test("a stalled issuer is interruptible without sending a mutation", { timeout: 3_000 }, async (t) => {
  const f = await fixture(t, "issuer-interrupted")
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const fiber = yield* Effect.forkScoped(f.provider.compareWrite(batch()))
    yield* Effect.promise(() => f.writing)
    yield* Fiber.interrupt(fiber)
  })))
  assert.deepEqual(f.calls, ["POST"])
})

test("cleanup failure does not turn a verified mutation into a retry", async (t) => {
  const f = await fixture(t, "cleanup-failure")
  assert.deepEqual(await Effect.runPromise(f.provider.compareWrite(batch())), result)
  assert.deepEqual(f.calls, ["POST", "PUT", "DELETE"])
})

test("cleanup has a bounded deadline even when its server never responds", { timeout: 3_000 }, async (t) => {
  const f = await fixture(t, "cleanup-stalled")
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function*() {
      const fiber = yield* Effect.forkScoped(f.provider.compareWrite(batch()))
      yield* Effect.promise(() => f.writing)
      yield* TestClock.adjust("11 seconds")
      assert.deepEqual(yield* Fiber.join(fiber), result)
    }).pipe(Effect.provide(TestClock.layer()))
  ))
  assert.deepEqual(f.calls, ["POST", "PUT", "DELETE"])
})

test("malformed operator bindings fail before any request", async (t) => {
  const f = await fixture(t)
  for (const override of [{ gatewayId: "bad" }, { credential: " " }, { apiBaseUrl: "http://remote.invalid/api" }]) {
    await Effect.runPromise(
      Effect.flip(Grants.make({ ...f.options, ...override }).pipe(Effect.provide(FetchHttpClient.layer)))
    )
  }
  assert.deepEqual(f.calls, [])
})

test("real grant store checks every write and honors the caller's narrower ceiling", async () => {
  let calls = 0
  const provider: MutationProvider = {
    compareWrite: () =>
      Effect.sync(() => {
        calls++
        return result
      })
  }
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const store = yield* GrantStore.make({
      attended: false,
      planDigest: "plan",
      envelope: {
        planDigest: "plan",
        patterns: [new CapabilityPattern({ action: "fs:write", resource: "/workspace/a.txt" })]
      }
    }).pipe(Effect.provide(Workspace.layer("/workspace")))
    const protectedProvider = Grants.protect(provider, "/workspace", Option.some(store))
    assert.deepEqual(yield* protectedProvider.compareWrite(batch()), result)
    const ceiling = [
      new CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
    ]
    const denied = yield* Effect.flip(protectedProvider.compareWrite(batch()).pipe(CapabilitySet.attenuate(ceiling)))
    assert.equal(denied.code, "permission_denied")
    const two = batch()
    const blocked = yield* Effect.flip(
      protectedProvider.compareWrite({
        ...two,
        changes: [...two.changes, { path: "b.txt", base_digest: "absent", content: null }]
      })
    )
    assert.equal(blocked.code, "permission_denied")
    assert.equal(
      (yield* Effect.flip(Grants.protect(provider, "/workspace", Option.none()).compareWrite(batch()))).code,
      "provider_unavailable"
    )
    assert.equal(
      (yield* Effect.flip(protectedProvider.compareWrite({ ...batch(), root: "/other" }))).code,
      "permission_denied"
    )
  })))
  assert.equal(calls, 1)
})

test("permission suspension cannot swap the checked batch or its bytes", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const input = batch()
    const store = {
      ...GrantStore.makeNoop,
      check: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
    }
    const provider = Grants.protect(
      {
        compareWrite: (pinned) =>
          Effect.sync(() => {
            assert.equal(pinned.changes[0]!.path, "a.txt")
            assert.equal(Buffer.from(pinned.changes[0]!.content!).toString(), "new")
            return result
          })
      },
      "/workspace",
      Option.some(store)
    )
    const fiber = yield* Effect.forkScoped(provider.compareWrite(input))
    yield* Deferred.await(entered)
    input.changes[0]!.content!.fill(0)
    ;(input.changes as Array<unknown>)[0] = { path: "unchecked", content: null }
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(fiber)
  })))
})
