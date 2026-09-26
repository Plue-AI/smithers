import { Effect, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { makeRemote } from "../repository/remote.ts"
import type { Event } from "../repository/schema.ts"

test("GitHub PR capture validates the recorded source, PR number and exact base/head while allowing a fork head", async (t) => {
  const head = "b".repeat(40), base = "a".repeat(40)
  const actual = {
    number: 7,
    title: "Fix the greeting",
    body: "Inspect greeting.mjs",
    head: { sha: head, ref: "fix", repo: { full_name: "contributor/fork" } },
    base: { sha: base, ref: "main", repo: { full_name: "original/source" } }
  }
  let selected = actual
  const paths: string[] = []
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json")
    if (request.url === "/api/repos/local/mirror/repository-source") {
      response.end(JSON.stringify({ source: "github", full_name: "original/source" }))
      return
    }
    assert.equal(request.url, "/api/repos/local/mirror/github-proxy")
    let text = ""
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    assert.equal(body.method, "GET")
    paths.push(body.path)
    response.end(JSON.stringify(selected))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  assert(address && typeof address !== "string")
  const remote = await Effect.runPromise(
    makeRemote({
      apiBaseUrl: `http://127.0.0.1:${address.port}/api`,
      repositorySlug: "local/mirror",
      repositoryId: 1,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      token: Redacted.make("fixture-token"),
      gatewayId: "11111111-1111-4111-8111-111111111111",
      credential: "fixture-gateway"
    })
      .pipe(Effect.provide(FetchHttpClient.layer))
  )
  const event: typeof Event.Type = {
    source: "github",
    type: "pull_request",
    action: "opened",
    issueNumber: 7,
    deliveryKey: "github:signed-pr",
    payload: { repository: { full_name: "original/source" }, pull_request: actual }
  }
  const captured = await Effect.runPromise(remote.resolveReview!(event))
  assert.equal(captured.sourceRevision, head)
  assert.deepEqual(paths, ["/repos/original/source/pulls/7"])
  assert.equal((captured.payload as any).pull_request.head.repo.full_name, "contributor/fork")
  await assert.rejects(
    Effect.runPromise(
      remote.resolveReview!({ ...event, payload: { repository: { full_name: "other/repo" }, pull_request: actual } })
    ),
    /different GitHub repository/
  )
  assert.equal(paths.length, 1, "a foreign event cannot make a source request")
  selected = { ...actual, head: { ...actual.head, sha: "c".repeat(40) } }
  await assert.rejects(Effect.runPromise(remote.resolveReview!(event)), /selected PR changed/)
  selected = { ...actual, number: 8 }
  await assert.rejects(Effect.runPromise(remote.resolveReview!(event)), /no verified repository/)
})

test("source retention binds every acknowledgement to the provisioned workspace and admitted immutable identity", async (t) => {
  const workspace = "22222222-2222-4222-8222-222222222222", head = "b".repeat(40), base = "a".repeat(40)
  const ref = (sha: string) => `refs/smithers/workspaces/${workspace}/sources/${sha}`
  const requests: Record<string, unknown>[] = []
  let status = 200, override: Record<string, unknown> = {}
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json")
    assert.equal(request.headers.authorization, "Bearer fixture-token")
    if (request.url === "/api/repos/local/mirror/repository-source") {
      response.end(JSON.stringify({ source: "github", full_name: "original/source" }))
      return
    }
    assert.equal(request.url, "/api/repos/local/mirror/repository-source/retain")
    assert.equal(request.method, "POST")
    let text = ""
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    requests.push(body)
    response.statusCode = status
    response.end(
      JSON.stringify(
        status === 200 ?
          {
            status: "retained",
            source: "github",
            full_name: "original/source",
            workspace_id: workspace,
            head: body.head,
            base: body.base,
            head_ref: ref(body.head),
            ...(body.base === "0".repeat(40) ? {} : { base_ref: ref(body.base) }),
            clone_url: "https://native.example/local/mirror.git",
            ...override
          } :
          { error: "fixture refusal" }
      )
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  assert(address && typeof address !== "string")
  const remote = await Effect.runPromise(
    makeRemote({
      apiBaseUrl: `http://127.0.0.1:${address.port}/api`,
      repositorySlug: "local/mirror",
      repositoryId: 1,
      workspaceId: workspace,
      token: Redacted.make("fixture-token"),
      gatewayId: "11111111-1111-4111-8111-111111111111",
      credential: "fixture-gateway"
    })
      .pipe(Effect.provide(FetchHttpClient.layer))
  )
  const pr = { kind: "pull_request" as const, number: 7, head, base }
  const retained = await Effect.runPromise(remote.retainSource!(pr))
  assert.equal(retained.head_ref, ref(head))
  assert.deepEqual(requests[0], { ...pr, workspace_id: workspace })
  const push = {
    kind: "push" as const,
    head,
    base: "0".repeat(40),
    ref: "refs/heads/new",
    delivery_key: "github:signed-event"
  }
  assert.equal((await Effect.runPromise(remote.retainSource!(push))).base_ref, undefined)
  assert.deepEqual(requests[1], { ...push, workspace_id: workspace })
  for (
    const changed of [{ head: "c".repeat(40) }, { base_ref: ref(head) }, { head_ref: "refs/heads/main" }, {
      workspace_id: "33333333-3333-4333-8333-333333333333"
    }, { full_name: "other/repository" }]
  ) {
    override = changed
    await assert.rejects(Effect.runPromise(remote.retainSource!(pr)), /exact repository, workspace and commits/)
  }
  override = {}
  for (
    const [http, code] of [[404, "source_missing"], [409, "source_changed"], [403, "source_refused"], [
      503,
      "source_unavailable"
    ]] as const
  ) {
    status = http
    const outcome = await Effect.runPromise(remote.retainSource!(pr).pipe(Effect.result))
    assert.equal(outcome._tag, "Failure")
    if (outcome._tag === "Failure") assert.equal(outcome.failure.code, code)
  }
})

test("native main retention uses only the provisioned native identity and exact workspace ref", async (t) => {
  const workspace = "22222222-2222-4222-8222-222222222222", main = "d".repeat(40)
  const ref = `refs/smithers/workspaces/${workspace}/sources/${main}`
  const requests: Record<string, unknown>[] = []
  let status = 200, override: Record<string, unknown> = {}
  const server = createServer(async (request, response) => {
    assert.equal(
      request.url,
      "/api/repos/local/mirror/repository-source/retain",
      "native main never resolves upstream GitHub provenance"
    )
    assert.equal(request.method, "POST")
    assert.equal(request.headers.authorization, "Bearer fixture-token")
    let text = ""
    for await (const chunk of request) text += chunk
    requests.push(JSON.parse(text))
    response.setHeader("content-type", "application/json")
    response.statusCode = status
    response.end(
      JSON.stringify(
        status === 200 ?
          {
            status: "retained",
            source: "smithers-cloud",
            full_name: "local/mirror",
            workspace_id: workspace,
            head: main,
            base: main,
            head_ref: ref,
            base_ref: ref,
            clone_url: "https://native.example/local/mirror.git",
            ...override
          } :
          { error: "fixture refusal" }
      )
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  assert(address && typeof address !== "string")
  const remote = await Effect.runPromise(
    makeRemote({
      apiBaseUrl: `http://127.0.0.1:${address.port}/api`,
      repositorySlug: "local/mirror",
      repositoryId: 1,
      workspaceId: workspace,
      token: Redacted.make("fixture-token"),
      gatewayId: "11111111-1111-4111-8111-111111111111",
      credential: "fixture-gateway"
    })
      .pipe(Effect.provide(FetchHttpClient.layer))
  )
  assert.equal((await Effect.runPromise(remote.retainMain!(main))).head_ref, ref)
  assert.deepEqual(requests, [{ kind: "main", workspace_id: workspace, head: main, base: main }])
  await assert.rejects(Effect.runPromise(remote.retainMain!("0".repeat(40))), /exact immutable commit/)
  assert.equal(requests.length, 1)
  for (
    const changed of [
      { head: "e".repeat(40) },
      { base: "e".repeat(40) },
      { base_ref: undefined },
      { head_ref: "refs/heads/main" },
      { workspace_id: "33333333-3333-4333-8333-333333333333" },
      { full_name: "original/github-source" },
      { source: "github" }
    ]
  ) {
    override = changed
    await assert.rejects(Effect.runPromise(remote.retainMain!(main)), /exact repository|invalid receipt/)
  }
  override = {}
  for (
    const [http, code] of [[404, "source_missing"], [409, "source_changed"], [403, "source_refused"], [
      503,
      "source_unavailable"
    ]] as const
  ) {
    status = http
    const result = await Effect.runPromise(remote.retainMain!(main).pipe(Effect.result))
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") assert.equal(result.failure.code, code)
  }
})
