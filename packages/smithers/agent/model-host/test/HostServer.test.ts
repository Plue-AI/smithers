import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import { agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import { Effect, Metric, Stream } from "effect"
import { createHash } from "node:crypto"
import { describe, expect, test, vi } from "vitest"
import {
  createModelTurnHandler,
  MODEL_HOST_PROTOCOL,
  MODEL_HOST_STREAM_PATH,
  type ModelTurnResolver,
  turnFailures
} from "../src/HostServer.ts"
import { ResolveFailed } from "../src/ModelHostError.ts"

const cursor = { version: 1 as const, runId: "run", legId: "leg", batch: 0, position: 0, hash: "a".repeat(64) }
const grant = {
  turnId: "turn",
  ownerId: 1,
  runId: "run",
  legId: "leg",
  generation: 1,
  token: "producer_capability_producer_capability_1234",
  cursor,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  request: { runId: "run", instructions: "answer", messages: [{ role: "user", content: "hi" }] },
  producerBaseUrl: "http://callback.test/"
}

const committed = (body: Record<string, any>) => {
  const expected = body.expected
  const frame = body.frames[0]
  const unsigned = {
    version: 1,
    runId: "run",
    legId: "leg",
    batch: expected.batch + 1,
    from: expected.position + 1,
    previousHash: expected.hash,
    frames: [frame]
  }
  const batch = {
    ...unsigned,
    hash: createHash("sha256").update(agentTurnJournalDigestInput("batch", unsigned)).digest("hex")
  }
  return {
    status: "committed",
    batch,
    cursor: { version: 1, runId: "run", legId: "leg", batch: batch.batch, position: batch.from, hash: batch.hash }
  }
}

describe("model host HTTP binding", () => {
  test("authenticates a secret-free grant and waits for durable callbacks", async () => {
    const calls: string[] = []
    const events: ReadonlyArray<ModelEvent.ModelEvent> = [{ type: "text-delta", id: "t", text: "hello" }, {
      type: "settle",
      stopReason: "stop"
    }]
    const handler = createModelTurnHandler({
      authorization: "host-token",
      callbackBaseUrl: "http://callback.test",
      resolve: () =>
        Effect.succeed({
          model: Model.make({ stream: () => Stream.fromIterable(events) }),
          options: { modelId: "fixture" }
        }),
      fetchImpl: async (input, init) => {
        calls.push(new URL(String(input)).pathname)
        if (String(input).includes("provider-started")) return new Response(null, { status: 204 })
        return Response.json(committed(JSON.parse(typeof init?.body === "string" ? init.body : "{}")))
      }
    })
    const refused = await handler(
      new Request("http://host.test/v1/chat/turn", { method: "POST", body: JSON.stringify(grant) })
    )
    expect(refused.status).toBe(401)
    const response = await handler(
      new Request("http://host.test/v1/chat/turn", {
        method: "POST",
        headers: { authorization: "Bearer host-token", "content-type": "application/json" },
        body: JSON.stringify(grant)
      })
    )
    expect(response.status).toBe(204)
    expect(calls).toEqual(["/internal/chat/provider-started", "/internal/chat/commit", "/internal/chat/commit"])
    const health = await handler(new Request("http://host.test/health"))
    expect(await health.json()).toEqual({ protocol: MODEL_HOST_PROTOCOL })
  })
})

test("the authenticated model stream emits provider frames through the configured owner model", async () => {
  let resolvedOwner = 0
  const handler = createModelTurnHandler({
    authorization: "host-token",
    callbackBaseUrl: "http://callback.test",
    resolve: (accepted) => {
      resolvedOwner = accepted.ownerId
      return Effect.succeed({
        model: Model.make({
          stream: () =>
            Stream.fromIterable([
              { type: "text-delta", id: "t", text: "provider token" } as const,
              { type: "settle", stopReason: "stop" } as const
            ])
        }),
        options: { modelId: "fixture" }
      })
    }
  })
  const body = JSON.stringify({
    runId: "run-stream",
    ownerId: 42,
    instructions: "summarize",
    messages: [{ role: "user", content: "hi" }]
  })
  const refused = await handler(new Request(`http://host.test${MODEL_HOST_STREAM_PATH}`, { method: "POST", body }))
  expect(refused.status).toBe(401)
  const response = await handler(
    new Request(`http://host.test${MODEL_HOST_STREAM_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer host-token", "content-type": "application/json" },
      body
    })
  )
  expect(response.status).toBe(200)
  expect(resolvedOwner).toBe(42)
  const frames = (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
  expect(frames).toEqual([
    { runId: "run-stream", type: "delta", kind: "text", text: "provider token" },
    { runId: "run-stream", type: "done", reason: "stop" }
  ])
})

const options = {
  authorization: "host-token",
  callbackBaseUrl: "http://callback.test",
  resolve: () => Effect.fail(new ResolveFailed({ message: "private provider diagnostic" }))
}
const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://host.test/v1/chat/turn", {
    method: "POST",
    headers: { authorization: "Bearer host-token", ...headers },
    body
  })

const streamPost = (body: unknown) =>
  new Request(`http://host.test${MODEL_HOST_STREAM_PATH}`, {
    method: "POST",
    headers: { authorization: "Bearer host-token", "content-type": "application/json" },
    body: JSON.stringify(body)
  })

test("the model stream rejects non-POST requests before resolving a model", async () => {
  const resolve = vi.fn(options.resolve)
  const response = await createModelTurnHandler({ ...options, resolve })(
    new Request(`http://host.test${MODEL_HOST_STREAM_PATH}`)
  )
  expect(response.status).toBe(405)
  expect(resolve).not.toHaveBeenCalled()
})

test.each([
  null,
  "invalid",
  {},
  { runId: 42, messages: [] },
  { runId: "run", messages: {} },
  { runId: "run", messages: [], tools: {} }
])("the model stream refuses malformed input before selecting an owner model %#", async (body) => {
  const resolve = vi.fn(options.resolve)
  const response = await createModelTurnHandler({ ...options, resolve })(streamPost(body))
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ status: "error", code: "request_invalid" })
  expect(resolve).not.toHaveBeenCalled()
})

test.each([undefined, 1.5])(
  "the model stream normalizes optional metadata for the default owner (%s)",
  async (ownerId) => {
    const resolve = vi.fn<ModelTurnResolver>((accepted) => {
      expect(accepted.ownerId).toBe(0)
      expect(accepted.request.instructions).toBe("")
      expect(accepted.request.tools).toEqual([])
      return Effect.succeed({
        model: Model.make({ stream: () => Stream.make({ type: "settle", stopReason: "stop" }) }),
        options: { modelId: "fixture" }
      })
    })
    const response = await createModelTurnHandler({ ...options, resolve })(
      streamPost({ runId: "run", ownerId, messages: [], tools: [] })
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(`${JSON.stringify({ runId: "run", type: "done", reason: "stop" })}\n`)
    expect(resolve).toHaveBeenCalledOnce()
  }
)

test("the model stream hides resolver diagnostics on failure", async () => {
  const response = await createModelTurnHandler(options)(streamPost({ runId: "run", messages: [] }))
  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ status: "error", code: "stream_failed" })
})

test.each([
  "ftp://callback.test",
  "http://user@callback.test",
  "http://:pass@callback.test",
  "http://callback.test/?q=1",
  "http://callback.test/#fragment"
])(
  "refuses unsafe configured and wire callback URL %s",
  async (url) => {
    expect(() => createModelTurnHandler({ ...options, callbackBaseUrl: url })).toThrow(
      "invalid model host callback URL"
    )
    const response = await createModelTurnHandler(options)(post(JSON.stringify({ ...grant, producerBaseUrl: url })))
    expect(response.status).toBe(400)
  }
)

test("requires authorization configuration and rejects unknown routes and methods", async () => {
  expect(() => createModelTurnHandler({ ...options, authorization: " " })).toThrow("authorization is required")
  const handler = createModelTurnHandler(options)
  expect((await handler(new Request("http://host.test/unknown"))).status).toBe(404)
  expect((await handler(new Request("http://host.test/health", { method: "POST" }))).status).toBe(404)
  expect((await handler(new Request("http://host.test/v1/chat/turn"))).status).toBe(405)
})

test.each([
  null,
  {},
  { ...grant, request: null },
  { ...grant, request: "invalid" },
  { ...grant, request: { ...grant.request, runId: 2 } },
  { ...grant, request: { ...grant.request, instructions: 2 } },
  { ...grant, request: { ...grant.request, messages: {} } },
  { ...grant, request: { ...grant.request, tools: {} } },
  { ...grant, request: { ...grant.request, runId: "other" } },
  { ...grant, cursor: { ...cursor, runId: "other" } },
  { ...grant, cursor: { ...cursor, legId: "other" } },
  { ...grant, producerBaseUrl: "http://other.test" },
  { ...grant, expiresAt: "not a date" },
  { ...grant, expiresAt: "2000-01-01" }
])("rejects malformed or mismatched grants before resolving a model %#", async (value) => {
  let resolved = false
  const handler = createModelTurnHandler({
    ...options,
    resolve: () => {
      resolved = true
      return options.resolve()
    }
  })
  const response = await handler(post(JSON.stringify(value)))
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ status: "error", code: "request_invalid" })
  expect(resolved).toBe(false)
})

test.each(["NaN", "-1", String(2 * 1024 * 1024 + 1)])("bounds declared body length %s", async (length) => {
  const response = await createModelTurnHandler(options)(post(JSON.stringify(grant), { "content-length": length }))
  expect(response.status).toBe(400)
})

test.each([null, " ".repeat(2 * 1024 * 1024 + 1), "{", new Uint8Array([0xff])])(
  "rejects empty, oversized, malformed JSON, and invalid UTF-8 bodies %#",
  async (body) => {
    expect((await createModelTurnHandler(options)(post(body))).status).toBe(400)
  }
)

test("refuses an unreadable request body", async () => {
  const request = post(JSON.stringify(grant))
  await request.arrayBuffer()
  expect((await createModelTurnHandler(options)(request)).status).toBe(400)
})

test("preserves the repository grant and hides provider failures", async () => {
  const handler = createModelTurnHandler({
    ...options,
    callbackBaseUrl: "https://callback.test/nested",
    resolve: (accepted) => {
      expect(accepted.repositoryId).toBe(17)
      expect(accepted.producerBaseUrl).toBe("https://callback.test/")
      expect(accepted.request.tools).toEqual([])
      return options.resolve()
    }
  })
  const response = await handler(post(JSON.stringify({
    ...grant,
    repositoryId: 17,
    request: { ...grant.request, tools: [] },
    producerBaseUrl: "https://callback.test/other"
  })))
  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ status: "error", code: "turn_failed" })
})

const failing = (error: unknown) =>
  createModelTurnHandler({
    ...options,
    resolve: () =>
      Effect.succeed({
        model: Model.make({ stream: () => Stream.fail(error as ModelError) }),
        options: { modelId: "fixture" }
      }),
    fetchImpl: async () => new Response(null, { status: 204 })
  })

const failureCount = (failure: string) =>
  Effect.runPromise(Metric.value(Metric.withAttributes(turnFailures, { failure }))).then((state) => state.count)

test("logs the failure class and turn identity, never the cause text", async () => {
  const lines: Array<string> = []
  const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
    lines.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "))
  })
  const log = vi.spyOn(console, "log").mockImplementation((...args) => {
    lines.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "))
  })
  try {
    const before = await failureCount("ResolveFailed")
    const response = await createModelTurnHandler(options)(post(JSON.stringify(grant)))
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ status: "error", code: "turn_failed" })
    expect(await failureCount("ResolveFailed")).toBe(before + 1)
  } finally {
    spy.mockRestore()
    log.mockRestore()
  }
  const text = lines.join("\n")
  expect(text).toContain("ResolveFailed")
  expect(text).toContain("turn")
  expect(text).not.toContain("private provider diagnostic")
})

test.each(
  [
    ["rate_limited", "provider_quota"],
    ["quota_exceeded", "provider_quota"],
    ["provider_internal", "turn_failed"]
  ] as const
)("answers a provider %s as %s", async (code, answer) => {
  const response = await failing(new ModelError({ code, message: "signed request detail" }))(
    post(JSON.stringify(grant))
  )
  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ status: "error", code: answer })
})

test("counts a refused commit under its own failure class", async () => {
  const before = await failureCount("CommitRefused")
  const handler = createModelTurnHandler({
    ...options,
    resolve: () =>
      Effect.succeed({
        model: Model.make({
          stream: () => Stream.fromIterable<ModelEvent.ModelEvent>([{ type: "settle", stopReason: "stop" }])
        }),
        options: { modelId: "fixture" }
      }),
    fetchImpl: async (input) =>
      String(input).includes("provider-started")
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 409 })
  })
  const response = await handler(post(JSON.stringify(grant)))
  expect(await response.json()).toEqual({ status: "error", code: "turn_failed" })
  expect(await failureCount("CommitRefused")).toBe(before + 1)
})

test.each(["Bearer host-toke", "Bearer host-tokenx", "host-token", ""])(
  "refuses a near-miss token %j",
  async (value) => {
    const response = await createModelTurnHandler(options)(post(JSON.stringify(grant), { authorization: value }))
    expect(response.status).toBe(401)
  }
)

test("answers an aborted turn as cancelled and a dying provider as a defect", async () => {
  const abort = new AbortController()
  const hanging = createModelTurnHandler({
    ...options,
    resolve: () => Effect.never,
    fetchImpl: async () => new Response(null, { status: 204 })
  })
  const request = new Request("http://host.test/v1/chat/turn", {
    method: "POST",
    headers: { authorization: "Bearer host-token" },
    body: JSON.stringify(grant),
    signal: abort.signal
  })
  const pending = hanging(request)
  setTimeout(() => abort.abort(), 10)
  expect(await (await pending).json()).toEqual({ status: "error", code: "cancelled" })

  const before = await failureCount("Defect")
  const dying = createModelTurnHandler({
    ...options,
    resolve: () =>
      Effect.succeed({
        model: Model.make({ stream: () => Stream.die(new Error("provider bug")) }),
        options: { modelId: "fixture" }
      }),
    fetchImpl: async () => new Response(null, { status: 204 })
  })
  expect(await (await dying(post(JSON.stringify(grant)))).json()).toEqual({ status: "error", code: "turn_failed" })
  expect(await failureCount("Defect")).toBe(before + 1)
})

test("cancels a chunked body with no content-length once it passes the byte limit", async () => {
  const resolve = vi.fn(options.resolve)
  let pulled = 0
  const chunk = new Uint8Array(256 * 1024).fill(0x20)
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += chunk.byteLength
      controller.enqueue(chunk)
    }
  })
  const request = new Request(`http://host.test${MODEL_HOST_STREAM_PATH}`, {
    method: "POST",
    headers: { authorization: "Bearer host-token" },
    body,
    duplex: "half"
  } as RequestInit)
  expect(request.headers.get("content-length")).toBeNull()
  const response = await createModelTurnHandler({ ...options, resolve })(request)
  expect(response.status).toBe(400)
  expect(pulled).toBeLessThanOrEqual(2 * 1024 * 1024 + 2 * chunk.byteLength)
  expect(resolve).not.toHaveBeenCalled()
})

test("rejects a present but empty body before resolving a model", async () => {
  const resolve = vi.fn(options.resolve)
  const request = new Request(`http://host.test${MODEL_HOST_STREAM_PATH}`, {
    method: "POST",
    headers: { authorization: "Bearer host-token" },
    body: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    duplex: "half"
  } as RequestInit)
  expect(request.body).not.toBeNull()
  const response = await createModelTurnHandler({ ...options, resolve })(request)
  expect(response.status).toBe(400)
  expect(resolve).not.toHaveBeenCalled()
})

test("the model stream refuses a response that outgrows the stream byte ceiling", async () => {
  const text = "x".repeat(1024 * 1024)
  const response = await createModelTurnHandler({
    ...options,
    resolve: () =>
      Effect.succeed({
        model: Model.make({
          stream: () =>
            Stream.concat(
              Stream.fromIterable(Array.from({ length: 17 }, (_, index) => ({
                type: "text-delta" as const,
                id: "t",
                text: `${index}${text}`
              }))),
              Stream.make({ type: "settle" as const, stopReason: "stop" as const })
            )
        }),
        options: { modelId: "fixture" }
      })
  })(streamPost({ runId: "run", messages: [] }))
  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ status: "error", code: "stream_failed" })
})
