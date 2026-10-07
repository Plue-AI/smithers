import * as Model from "@smthrs/model/Model"
import type { ContextPreflightInput } from "@smthrs/rpc/ContextPreflight"
import { Effect, Stream } from "effect"
import { expect, test, vi } from "vitest"
import { environmentModelResolver } from "../src/EnvironmentResolver.ts"
import { createModelTurnHandler, MODEL_HOST_CONTEXT_SELECT_PATH, type ModelTurnResolver } from "../src/HostServer.ts"

// A TODO plan step's wiki selection (T-FLW-10): the shared preflight
// selector alone, on the owner's fast role. Literal fixtures, no derivation.
const input = {
  prompt: "Retry failed webhook deliveries",
  author: "ben",
  branch: "todo:12",
  state: "plan",
  recent: [],
  tokenBudget: 24000,
  wikiOnly: true,
  candidates: [
    {
      item: { kind: "page", label: "Retry policy", ref: "retry-policy", revision: "3" },
      text: "Webhook retries use `retry()` with exponential backoff."
    },
    {
      item: { kind: "page", label: "Release process", ref: "release-process", revision: "2" },
      text: "Releases ship on Tuesdays."
    },
    {
      item: { kind: "file", label: "retry.ts", ref: "src/webhooks/retry.ts", revision: "abc123" },
      text: "export const retry = () => {}"
    }
  ]
} satisfies ContextPreflightInput
const body = (contextSelection: unknown = input, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ runId: "select-run", ownerId: 7, instructions: "", messages: [], contextSelection, ...extra })
const post = (payload: string, authorization = "Bearer host-token") =>
  new Request(`http://host.test${MODEL_HOST_CONTEXT_SELECT_PATH}`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: payload
  })

const fastModel = (requests: Array<any>, answer = "[{\"index\":0,\"reason\":\"Retry decision\"}]") =>
  Model.make({
    stream: (request) => {
      requests.push(request)
      return Stream.fromIterable([
        { type: "text-delta" as const, id: "t", text: answer },
        { type: "settle" as const, stopReason: "stop" as const }
      ])
    }
  })

test("selection runs the fast role over wiki pages only and returns the chosen revisions", async () => {
  const fast: Array<any> = [], answer: Array<any> = []
  const resolve = vi.fn<ModelTurnResolver>((grant, selection) =>
    Effect.succeed({
      model: fastModel(answer),
      options: { modelId: "coding" },
      ...(selection === undefined ? {} : {
        preflight: { input: selection, model: fastModel(fast), options: { modelId: "owner-fast" } }
      })
    })
  )
  const handler = createModelTurnHandler({
    authorization: "host-token",
    callbackBaseUrl: "http://callback.test",
    resolve
  })
  const response = await handler(post(body()))
  expect(response.status).toBe(200)
  const result = await response.json()
  expect(result.model).toBe("owner-fast")
  expect(result.context).toEqual([
    { kind: "page", label: "Retry policy", ref: "retry-policy", revision: "3", reason: "Retry decision" }
  ])
  expect(result.candidates.map((item: { ref: string }) => item.ref)).toEqual(["retry-policy", "release-process"])
  expect(answer).toHaveLength(0)
  expect(fast).toHaveLength(1)
  expect(fast[0].modelId).toBe("owner-fast")
  // The selector saw the prompt and wiki candidates only, never the file.
  const sent = JSON.stringify(fast[0].messages)
  expect(sent).toContain("Retry failed webhook deliveries")
  expect(sent).not.toContain("src/webhooks/retry.ts")
  const [grant, selection] = resolve.mock.calls[0]!
  expect(selection).toEqual(input)
  expect(grant.ownerId).toBe(7)
  // The selection never rides the grant's request, which a chat turn carries.
  expect(grant.request).toEqual({ runId: "select-run", instructions: "", messages: [] })
})

test("selection refuses unauthenticated, malformed and non-POST requests before resolving a model", async () => {
  const resolve = vi.fn<ModelTurnResolver>(() => Effect.die("unreachable"))
  const handler = createModelTurnHandler({
    authorization: "host-token",
    callbackBaseUrl: "http://callback.test",
    resolve
  })
  expect((await handler(post(body(), "Bearer other"))).status).toBe(401)
  for (
    const payload of [
      body(null),
      body({ ...input, prompt: "" }),
      body(input, { messages: [{ role: "user", content: "canary-browser" }] }),
      body(input, { instructions: "answer" }),
      body(input, { sharedConversation: true }),
      "{"
    ]
  ) {
    expect((await handler(post(payload))).status, payload.slice(0, 160)).toBe(400)
  }
  expect((await handler(new Request(`http://host.test${MODEL_HOST_CONTEXT_SELECT_PATH}`))).status).toBe(405)
  expect(resolve).not.toHaveBeenCalled()
})

test("selection without a resolved selector or with invalid choices fails without an answer", async () => {
  const answer: Array<any> = []
  const without = createModelTurnHandler({
    authorization: "host-token",
    callbackBaseUrl: "http://callback.test",
    resolve: () => Effect.succeed({ model: fastModel(answer), options: { modelId: "coding" } })
  })
  const refused = await without(post(body()))
  expect(refused.status).toBe(502)
  expect(await refused.json()).toEqual({ status: "error", code: "turn_failed" })
  expect(answer).toHaveLength(0)
  const invalid = createModelTurnHandler({
    authorization: "host-token",
    callbackBaseUrl: "http://callback.test",
    resolve: (_grant, selection) =>
      Effect.succeed({
        model: fastModel(answer),
        options: { modelId: "coding" },
        preflight: {
          input: selection!,
          model: fastModel([], "[{\"index\":9,\"reason\":\"none\"}]"),
          options: { modelId: "owner-fast" }
        }
      })
  })
  expect((await invalid(post(body()))).status).toBe(502)
  expect(answer).toHaveLength(0)
})

test("the environment resolver uses a selection's own input and never reads the chat callback", async () => {
  const binding = {
    protocol: "openai-chat",
    baseUrl: "https://fixture.test",
    modelId: "fixture",
    credential: "FIXTURE"
  }
  const fastBinding = { ...binding, baseUrl: "https://fast.test", modelId: "owner-fast", credential: "FAST" }
  const env = {
    SMITHERS_MODEL_KEY_FIXTURE: "fixture-key",
    SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: "https://fixture.test",
    SMITHERS_MODEL_KEY_FAST: "fast-key",
    SMITHERS_MODEL_KEY_FAST_ORIGIN: "https://fast.test"
  }
  const fetchImpl = vi.fn<typeof fetch>()
  const grant = {
    turnId: "context-selection-select-run",
    ownerId: 7,
    runId: "select-run",
    legId: "select-run",
    generation: 1,
    token: "context_selection_context_selection_12",
    cursor: {
      version: 1 as const,
      runId: "select-run",
      legId: "select-run",
      batch: 0,
      position: 0,
      hash: "0".repeat(64)
    },
    expiresAt: "2100-01-01",
    producerBaseUrl: "https://callback.test",
    request: { runId: "select-run", instructions: "", messages: [] }
  }
  const resolver = environmentModelResolver({ binding, preflightBinding: fastBinding, env, fetchImpl })
  const selected = await Effect.runPromise(resolver(grant, input))
  expect(selected.preflight?.input).toEqual(input)
  expect(selected.preflight?.options).toEqual({ modelId: "owner-fast", credential: "fast-key" })
  // Without a selection, a turn that is not a shared conversation has no preflight.
  expect((await Effect.runPromise(resolver(grant))).preflight).toBeUndefined()
  // Without a fast binding the selection falls back to the resolved model.
  const fallback = await Effect.runPromise(environmentModelResolver({ binding, env, fetchImpl })(grant, input))
  expect(fallback.preflight?.options).toEqual({ modelId: "fixture", credential: "fixture-key" })
  expect(fetchImpl).not.toHaveBeenCalled()
})
