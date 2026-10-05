import { FlowRuntime } from "@smthrs/flow"
import { Effect, Fiber, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { makeRemote } from "../learning/remote.ts"

const snapshot = { repository: "owner/repo", todo: 7, run: "execution /?", state: "merged", change: "change", commit: "commit", attempts: [], journal: [], outcomes: [] }
const options = { apiBaseUrl: "http://127.0.0.1:1/api", repositorySlug: "owner/repo", repositoryId: 1, workspaceId: "workspace", token: Redacted.make("secret-fixture") }

test("learning HTTP reader binds the current execution, rejects malformed and mismatched evidence, and retries starting runs", async t => {
  let body = JSON.stringify(snapshot), status = 200, calls = 0, starting = 0
  const server = createServer((request, response) => {
    calls++
    assert.equal(request.method, "GET")
    assert.equal(request.headers.authorization, "Bearer secret-fixture")
    assert.equal(request.url, "/api/repos/owner/repo/mythical/learning/7?run=execution%20%2F%3F")
    response.statusCode = starting-- > 0 ? 503 : status
    response.write(body.slice(0, 31))
    response.end(body.slice(31))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  assert(address && typeof address !== "string")
  const remote = await Effect.runPromise(makeRemote({ ...options, apiBaseUrl: `http://127.0.0.1:${address.port}/api` }).pipe(Effect.provide(FetchHttpClient.layer)))
  const read = (todo = 7, run = snapshot.run) => Effect.runPromise(remote.read(todo).pipe(Effect.provideService(FlowRuntime.FlowInstance, { executionId: run } as never)))
  assert.deepEqual(await read(), snapshot)
  starting = 2
  const before = calls
  assert.deepEqual(await read(), snapshot)
  assert.equal(calls - before, 3)
  for (const override of [{ todo: 8 }, { run: "other" }, { repository: "other/repo" }, { state: "running" }, { outcomes: "wrong" }]) {
    body = JSON.stringify({ ...snapshot, ...override })
    await assert.rejects(read(), /Learning snapshot/)
  }
  for (const invalid of ["{", "null", "[]", '"' + "x".repeat(2 * 1024 * 1024) + '"']) {
    body = invalid
    await assert.rejects(read(), /Learning snapshot is invalid/)
  }
  body = JSON.stringify(snapshot)
  for (const code of [400, 401, 403, 404, 409, 500, 302]) {
    status = code
    await assert.rejects(read(), new RegExp(`HTTP ${code}`))
  }
  status = 503
  const retryCount = calls
  await assert.rejects(read(), /HTTP 503/)
  assert.equal(calls - retryCount, 11, "starting retries are bounded")
  const count = calls
  for (const todo of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(read(todo), /Invalid learning TODO/)
  for (const run of ["", "x".repeat(513)]) await assert.rejects(read(7, run), /current flow execution/)
  await assert.rejects(Effect.runPromise(remote.read(7)), /current flow execution/)
  assert.equal(calls, count)
})

test("learning credentials refuse unsafe destinations and repository path ambiguity", async () => {
  for (const apiBaseUrl of ["bogus", "http://example.com/api", "ftp://localhost/api", "https://user:pass@example.com/api", "https://example.com/api?x=1", "https://example.com/api#x", "https://example.com/other"]) {
    await assert.rejects(Effect.runPromise(makeRemote({ ...options, apiBaseUrl }).pipe(Effect.provide(FetchHttpClient.layer))), /learning|Learning/)
  }
  for (const repositorySlug of ["../repo", "owner/..", "owner/repo/extra", "owner/repo?x", "owner/%2F"]) {
    await assert.rejects(Effect.runPromise(makeRemote({ ...options, repositorySlug }).pipe(Effect.provide(FetchHttpClient.layer))), /Learning/)
  }
})

test("interrupting a learning HTTP read cancels its real pending request", async t => {
  let started!: () => void, closed!: () => void
  const requestStarted = new Promise<void>(resolve => { started = resolve })
  const requestClosed = new Promise<void>(resolve => { closed = resolve })
  const server = createServer((_request, response) => {
    response.on("close", closed)
    started()
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert(address && typeof address !== "string")
  const remote = await Effect.runPromise(makeRemote({ ...options, apiBaseUrl: `http://127.0.0.1:${address.port}/api` }).pipe(Effect.provide(FetchHttpClient.layer)))
  const fiber = Effect.runFork(remote.read(7).pipe(Effect.provideService(FlowRuntime.FlowInstance, { executionId: snapshot.run } as never)))
  await requestStarted
  await Effect.runPromise(Fiber.interrupt(fiber))
  await Promise.race([requestClosed, new Promise((_, reject) => setTimeout(() => reject(new Error("HTTP read was not cancelled")), 2000))])
})
