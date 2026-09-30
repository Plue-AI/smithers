import { Effect, Exit, Fiber, ManagedRuntime, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import type { AppendObservation, AppendPreparation, QueuedAppend } from "../coding/landing-schema.ts"
import { make, type Options } from "../coding/landing.ts"

const options: Options = {
  apiBaseUrl: "https://api.example.test/api",
  repositorySlug: "owner/repo",
  repositoryId: 42,
  workspaceId: "11111111-1111-4111-a111-111111111111",
  token: Redacted.make("fixture-private-token")
}
const requestId = "22222222-2222-4222-a222-222222222222"
const preparation: AppendPreparation = {
  status: "prepared",
  target_bookmark: "main",
  expected_commit_id: "a".repeat(40),
  source_commit_id: "b".repeat(40),
  source_base_commit_id: "c".repeat(40),
  changes: [{ change_id: "k".repeat(32), commit_id: "d".repeat(40) }, {
    change_id: "l".repeat(32),
    commit_id: "b".repeat(40)
  }]
}
const description = "✨ feat: finalize the validated request"
const landing = {
  request_id: requestId,
  number: 7,
  target_bookmark: "main",
  change_ids: preparation.changes.map((change) => change.change_id),
  agent_authored: true
}
const queued: QueuedAppend = {
  requestId,
  number: 7,
  taskId: 12,
  preparation,
  request: {
    commit_id: preparation.source_commit_id,
    expected_commit_id: preparation.expected_commit_id,
    source_base_commit_id: preparation.source_base_commit_id,
    description
  }
}
// The durable append request pins commit ids (plue validateLandingAppend), not the
// landing request's change ids.
const observation: AppendObservation = {
  status: "landed",
  task_id: 12,
  request: {
    change_ids: preparation.changes.map((change) => change.commit_id),
    target_bookmark: "main",
    expected_commit_id: preparation.expected_commit_id,
    operation_key: "existing-native-operation",
    append: {
      source_commit_id: preparation.source_commit_id,
      source_base_commit_id: preparation.source_base_commit_id,
      description
    }
  },
  result: { landed_count: 2, target_bookmark: "main", target_commit_id: "e".repeat(40) }
}
const body = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array"
    ? JSON.parse(new TextDecoder().decode(request.body.body)) :
    undefined
const configured = async (handle: (request: HttpClientRequest.HttpClientRequest, call: number) => Response) => {
  const calls: HttpClientRequest.HttpClientRequest[] = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      calls.push(request)
      return HttpClientResponse.fromWeb(request, handle(request, calls.length))
    })
  )
  const service = await Effect.runPromise(make(options).pipe(Effect.provideService(HttpClient.HttpClient, client)))
  return { service, calls }
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const absent = () => json({ code: "not_found", fault: "user", message: "file not found" }, 404)
const isFactory = (request: HttpClientRequest.HttpClientRequest) =>
  request.url.endsWith("/contents/.smithers/factory.json")

test("landing client uses native prepare, replay-safe creation, exact queue and immutable result", async () => {
  const { service, calls } = await configured((request, call) => {
    assert.equal(request.headers.authorization, "Bearer fixture-private-token")
    if (call === 1) {
      return json({
        items: [{
          name: "feature",
          target_change_id: "remote",
          target_commit_id: "0".repeat(40),
          is_tracking_remote: true
        }],
        next_cursor: "opaque+next"
      })
    }
    if (call === 2) {
      assert.ok(request.urlParams.params.some(([key, value]) => key === "cursor" && value === "opaque+next"))
      return json({
        items: [{
          name: "main",
          target_change_id: "native",
          target_commit_id: preparation.expected_commit_id,
          is_tracking_remote: true
        }],
        next_cursor: ""
      })
    }
    if (request.url.endsWith("/append/prepare")) return json(preparation)
    if (request.url.includes("/requests/")) return json(landing, 201)
    if (request.method === "PUT") return json({ ...landing, task_id: 12 }, 202)
    return json(observation)
  })
  assert.equal(await Effect.runPromise(service.readMain), preparation.expected_commit_id)
  assert.deepEqual(await Effect.runPromise(service.prepare(preparation)), preparation)
  const identity = await Effect.runPromise(service.create(requestId, preparation, description))
  assert.deepEqual(await Effect.runPromise(service.create(requestId, preparation, description)), identity)
  assert.equal(calls[3]!.url, calls[4]!.url)
  assert.deepEqual(body(calls[3]!), body(calls[4]!))
  assert.deepEqual(body(calls[3]!), {
    title: description,
    body: description,
    target_bookmark: "main",
    change_ids: landing.change_ids
  })
  assert.deepEqual(await Effect.runPromise(service.queue(identity, preparation, queued.request)), queued)
  assert.deepEqual(await Effect.runPromise(service.observe(queued)), observation)
  assert.equal(calls.length, 7, "native append receipt is sufficient after main moves; do not reread current main")
})

for (const mode of ["missing", "duplicate", "invalid", "cycle", "empty-next"] as const) {
  test(`main observation refuses ${mode}`, async () => {
    const bookmark = {
      name: "main",
      target_change_id: "native",
      target_commit_id: mode === "invalid" ? "short" : preparation.expected_commit_id,
      is_tracking_remote: false
    }
    const { service } = await configured(() =>
      json({
        items: mode === "missing" || mode === "empty-next"
          ? []
          : mode === "duplicate"
          ? [bookmark, bookmark]
          : [bookmark],
        next_cursor: mode === "cycle" || mode === "empty-next" ? "same" : ""
      })
    )
    await assert.rejects(Effect.runPromise(service.readMain), /unambiguous|incomplete|cyclic/)
  })
}
for (const mode of ["source", "base", "main", "duplicate-change", "duplicate-commit", "last", "old-route"] as const) {
  test(`native preparation refuses ${mode}`, async () => {
    const reply = structuredClone(preparation)
    if (mode === "source") Object.assign(reply, { source_commit_id: "f".repeat(40) })
    if (mode === "base") Object.assign(reply, { source_base_commit_id: "f".repeat(40) })
    if (mode === "main") Object.assign(reply, { expected_commit_id: "f".repeat(40) })
    if (mode === "duplicate-change") Object.assign(reply.changes[0]!, { change_id: reply.changes[1]!.change_id })
    if (mode === "duplicate-commit") Object.assign(reply.changes[0]!, { commit_id: reply.changes[1]!.commit_id })
    if (mode === "last") Object.assign(reply.changes[1]!, { commit_id: "f".repeat(40) })
    const { service, calls } = await configured(() => mode === "old-route" ? json({}, 404) : json(reply))
    await assert.rejects(Effect.runPromise(service.prepare(preparation)))
    assert.equal(calls.length, 1)
  })
}
for (const mode of ["missing-identity", "other-request", "other-stack", "human", "oversized-summary"] as const) {
  test(`landing creation refuses ${mode}`, async () => {
    const reply: Record<string, unknown> = { ...landing }
    if (mode === "missing-identity") delete reply.request_id
    if (mode === "other-request") reply.request_id = options.workspaceId
    if (mode === "other-stack") reply.change_ids = ["f".repeat(40)]
    if (mode === "human") reply.agent_authored = false
    const { service, calls } = await configured(() => json(reply, 201))
    await assert.rejects(
      Effect.runPromise(
        service.create(requestId, preparation, mode === "oversized-summary" ? "界".repeat(11_000) : description)
      )
    )
    assert.equal(calls.length, mode === "oversized-summary" ? 0 : 1)
  })
}
for (
  const mode of [
    "task",
    "source",
    "base",
    "main",
    "description",
    "count",
    "stack",
    "pending-result",
    "missing-result"
  ] as const
) {
  test(`append observation refuses ${mode}`, async () => {
    const reply = structuredClone(observation)
    if (mode === "task") Object.assign(reply, { task_id: 99 })
    if (mode === "source") Object.assign(reply.request.append, { source_commit_id: "f".repeat(40) })
    if (mode === "base") Object.assign(reply.request.append, { source_base_commit_id: "f".repeat(40) })
    if (mode === "main") Object.assign(reply.request, { expected_commit_id: "f".repeat(40) })
    if (mode === "description") Object.assign(reply.request.append, { description: "another request" })
    if (mode === "stack") Object.assign(reply.request, { change_ids: [...reply.request.change_ids].reverse() })
    if (mode === "count") Object.assign(reply.result, { landed_count: 1 })
    if (mode === "pending-result") Object.assign(reply, { status: "pending" })
    if (mode === "missing-result") Reflect.deleteProperty(reply, "result")
    const { service } = await configured(() => json(reply))
    await assert.rejects(Effect.runPromise(service.observe(queued)))
  })
}
for (const status of ["pending", "running", "failed"] as const) {
  test(`append observation preserves ${status} without inventing a result`, async () => {
    const reply = { status, task_id: 12, request: observation.request }
    const { service } = await configured(() => json(reply))
    assert.deepEqual(await Effect.runPromise(service.observe(queued)), reply)
  })
}
test("queue refuses changed input before any request", async () => {
  const { service, calls } = await configured(() => {
    throw new Error("unexpected write")
  })
  await assert.rejects(
    Effect.runPromise(service.queue(queued, preparation, { ...queued.request, expected_commit_id: "f".repeat(40) }))
  )
  assert.equal(calls.length, 0)
})
for (const mode of ["status", "bad-json", "large-declared", "large-stream", "defect"] as const) {
  test(`landing HTTP boundary refuses ${mode} without leaking credential/body`, async () => {
    const { service } = await configured(() => {
      if (mode === "status") return json({ diagnostic: "fixture-private-token" }, 503)
      if (mode === "bad-json") return new Response("fixture-private-token")
      if (mode === "large-declared") {
        return new Response("fixture-private-token", { headers: { "content-length": "3000000" } })
      }
      if (mode === "large-stream") return new Response("x".repeat(2 * 1024 * 1024 + 1))
      throw new Error("fixture-private-token")
    })
    await assert.rejects(Effect.runPromise(service.observe(queued)), (error) => {
      assert.ok(error instanceof Error)
      assert.ok(!String(error).includes("fixture-private-token"))
      return true
    })
  })
}
test("actual selected Node/Bun HTTP transport refuses redirects and replays lost creation ACK", async (t) => {
  let redirected = 0, attempts = 0
  const writes: string[] = []
  const server = createServer(async (request, response) => {
    if (request.url?.endsWith("/bookmarks?limit=100")) {
      response.writeHead(302, { location: "/redirect-target" })
      response.end()
      return
    }
    if (request.url === "/redirect-target") {
      redirected++
      response.end("{}")
      return
    }
    let input = ""
    for await (const chunk of request) input += chunk
    writes.push(input)
    attempts++
    if (attempts === 1) {
      request.socket.destroy()
      return
    }
    response.writeHead(201, { "content-type": "application/json" })
    response.end(JSON.stringify(landing))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  // Bun's node:http reports ERR_SERVER_NOT_RUNNING after closeAllConnections; either way the port is released.
  t.after(() =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  )
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const platform = "Bun" in globalThis ?
    (await import("@effect/platform-bun/BunHttpClient")).layer
    : (await import("@effect/platform-node/NodeHttpClient")).layerUndici
  const runtime = ManagedRuntime.make(platform)
  t.after(() => runtime.dispose())
  const service = await runtime.runPromise(make({ ...options, apiBaseUrl: `http://127.0.0.1:${address.port}/api` }))
  await assert.rejects(runtime.runPromise(service.readMain), /HTTP 302/)
  assert.equal(redirected, 0)
  // Undici surfaces the reset; Bun retries once on a reused keep-alive connection.
  // Either way the identical immutable body reaches the server exactly twice.
  const first = await runtime.runPromiseExit(service.create(requestId, preparation, description))
  const identity = Exit.isFailure(first)
    ? await runtime.runPromise(service.create(requestId, preparation, description))
    : first.value
  assert.deepEqual(identity, { requestId, number: 7 })
  assert.equal(attempts, 2)
  assert.equal(writes[0], writes[1], "ambiguous transport outcome retries the original immutable create body")
})
/** The repository contents API's real file shape (backend `RepoContent`): UTF-8 text, not base64. */
const factory = (value: unknown) => {
  const content = JSON.stringify(value)
  return json({
    name: "factory.json",
    path: ".smithers/factory.json",
    sha: "",
    type: "file",
    encoding: "utf-8",
    content,
    size: content.length
  })
}
for (
  const [mode, reply, expected] of [
    [
      "send-upstream",
      () => factory({ on: [], github: { mirror: "pull", issues: "two-way", changes: "send-upstream" } }),
      "pull-request"
    ],
    ["land", () => factory({ on: [], github: { mirror: "push", issues: "two-way", changes: "land" } }), "append"],
    ["undeclared", () => factory({ on: [] }), "append"],
    ["absent", () => json({ code: "not_found", fault: "user", message: "file not found" }, 404), "append"]
  ] as const
) {
  test(`delivery reads the declared ${mode} policy from main`, async () => {
    const { service, calls } = await configured(reply)
    assert.equal(await Effect.runPromise(service.readDelivery), expected)
    assert.equal(calls[0]!.url, `${options.apiBaseUrl}/repos/owner/repo/contents/.smithers/factory.json`)
    assert.ok(calls[0]!.urlParams.params.some(([key, value]) => key === "ref" && value === "main"))
  })
}
test("delivery refuses an unreadable declared policy", async () => {
  const { service } = await configured(() => json({ encoding: "utf-8", content: "{" }))
  await assert.rejects(Effect.runPromise(service.readDelivery), /not valid JSON/)
})
// A `mirror: "pull"` repository pins its base only from a fresh GitHub main pull.
const oldMain = "1".repeat(40), newMain = "2".repeat(40)
const pullStatus = (fields: object) => ({
  state: "synced",
  github_repository: "acme/app",
  branch: "main",
  policy: "pull",
  policy_commit: oldMain,
  github_head: oldMain,
  smithers_head: oldMain,
  pending: false,
  fresh: true,
  attempts: 0,
  last_error: "",
  next_attempt_at: null,
  last_checked_at: "2026-09-26T10:00:00Z",
  last_synced_at: "2026-09-26T10:00:00Z",
  ...fields
})
const pullRepository = (statuses: Array<object>, main: string) =>
  configured((request) => {
    if (isFactory(request)) return factory({ github: { mirror: "pull", changes: "send-upstream" } })
    if (request.url.endsWith("/github/main-pull")) {
      return request.method === "POST" ?
        json(pullStatus(statuses.shift()!), 202)
        : json(pullStatus(statuses.shift() ?? {}))
    }
    return json({
      items: [{ name: "main", target_change_id: "native", target_commit_id: main, is_tracking_remote: false }],
      next_cursor: ""
    })
  })
/** Runs the wait on a test clock, advancing it until the fiber settles. */
const pinned = (effect: Effect.Effect<string, unknown>) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(effect)
      for (let step = 0; step < 400 && fiber.pollUnsafe() === undefined; step++) yield* TestClock.adjust("1 second")
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer()))
  )
const routes = (calls: ReadonlyArray<HttpClientRequest.HttpClientRequest>) =>
  calls.map((call) => `${call.method} ${call.url.replace(`${options.apiBaseUrl}/repos/owner/repo`, "")}`)

test("a pull repository requests a GitHub main pull and pins the main it observed after a missed webhook", async () => {
  // The last observation (before the missed push) is still fresh at the old main;
  // only the requested pull's settled observation may pin the base.
  const { service, calls } = await pullRepository([{ pending: true }, { state: "running", pending: true }, {
    smithers_head: newMain,
    github_head: newMain,
    last_checked_at: "2026-09-26T10:05:00Z"
  }], newMain)
  assert.equal(await pinned(service.pinMain), newMain)
  assert.deepEqual(routes(calls), [
    "GET /contents/.smithers/factory.json",
    "POST /github/main-pull",
    "GET /github/main-pull",
    "GET /github/main-pull",
    "GET /bookmarks"
  ])
})
test("a pull repository refuses its base with the requested pull's failure", async () => {
  const earlier = {
    state: "failed",
    pending: true,
    fresh: false,
    last_error: "earlier failure",
    last_checked_at: "2026-09-26T09:00:00Z"
  }
  const { service, calls } = await pullRepository([earlier, earlier, { ...earlier, state: "running" }, {
    ...earlier,
    last_error: "fetch GitHub main: authentication failed",
    last_checked_at: "2026-09-26T10:05:00Z"
  }], newMain)
  await assert.rejects(
    pinned(service.pinMain),
    /GitHub main pull did not observe a fresh main \(failed: fetch GitHub main: authentication failed\)/
  )
  assert.ok(!routes(calls).includes("GET /bookmarks"), "no base is pinned from a failed pull")
})
test("a pull repository refuses a settled pull that is not fresh", async () => {
  const { service } = await pullRepository(
    [{ pending: true }, { state: "skipped", policy: "push", fresh: false }],
    newMain
  )
  await assert.rejects(pinned(service.pinMain), /did not observe a fresh main \(skipped\)/)
})
test("a pull repository refuses a main that moved after the pull observed it", async () => {
  const { service } = await pullRepository(
    [{ pending: true }, { smithers_head: newMain, github_head: newMain }],
    "3".repeat(40)
  )
  await assert.rejects(pinned(service.pinMain), /Main moved after the GitHub main pull observed it/)
})
for (
  const [mode, reply] of [["absent", absent], [
    "push",
    () => factory({ github: { mirror: "push", changes: "land" } })
  ]] as const
) {
  test(`a ${mode} mirror policy pins main without a GitHub main pull`, async () => {
    const { service, calls } = await configured((request) =>
      isFactory(request) ?
        reply()
        : json({
          items: [{ name: "main", target_change_id: "native", target_commit_id: oldMain, is_tracking_remote: false }],
          next_cursor: ""
        })
    )
    assert.equal(await Effect.runPromise(service.pinMain), oldMain)
    assert.deepEqual(routes(calls), ["GET /contents/.smithers/factory.json", "GET /bookmarks"])
  })
}
test("readMain is a cheap recheck that never requests a GitHub main pull", async () => {
  const { service, calls } = await pullRepository([], newMain)
  assert.equal(await Effect.runPromise(service.readMain), newMain)
  assert.deepEqual(routes(calls), ["GET /bookmarks"])
})
test("a pull repository refuses a pull that stays pending", async () => {
  const { service } = await pullRepository(
    Array.from({ length: 200 }, () => ({ state: "running", pending: true })),
    newMain
  )
  await assert.rejects(pinned(service.pinMain), /GitHub main pull is still pending/)
})
const tip = preparation.source_commit_id
const pull = {
  landing_number: 7,
  repository: "acme/app",
  number: 41,
  url: "https://github.com/acme/app/pull/41",
  state: "open",
  merged: false,
  head_ref: "smithers/landing-7",
  head_sha: tip,
  base_ref: "main",
  created: true
}
test("pull request opens once per landing tip and replays the same receipt", async () => {
  const { service, calls } = await configured((_, call) =>
    json({ ...pull, created: call === 1 }, call === 1 ? 201 : 200)
  )
  const first = await Effect.runPromise(service.openPull({ requestId, number: 7 }, tip, "run-7"))
  const second = await Effect.runPromise(service.openPull({ requestId, number: 7 }, tip, "run-7"))
  assert.equal(first.number, second.number)
  assert.equal(calls[0]!.method, "PUT")
  assert.equal(calls[0]!.url, `${options.apiBaseUrl}/repos/owner/repo/landings/7/github/pull`)
  assert.deepEqual(body(calls[0]!), { commit_id: tip, run_id: "run-7" })
})
for (const mode of ["other-tip", "other-branch", "other-landing", "refused"] as const) {
  test(`pull request refuses ${mode}`, async () => {
    const { service } = await configured(() =>
      mode === "refused"
        ? json({ code: "forbidden", message: "The Smithers GitHub App cannot open pull requests" }, 403)
        : json({
          ...pull,
          ...(mode === "other-tip"
            ? { head_sha: "f".repeat(40) }
            : mode === "other-branch"
            ? { head_ref: "feature" }
            : { landing_number: 8 })
        }, 201)
    )
    await assert.rejects(
      Effect.runPromise(service.openPull({ requestId, number: 7 }, tip, "run-7")),
      mode === "refused" ? /HTTP 403 forbidden/ : /exact landing tip/
    )
  })
}
