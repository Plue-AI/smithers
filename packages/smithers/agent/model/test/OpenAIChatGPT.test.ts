/**
 * The ChatGPT-subscription Responses route: the deltas the subscription
 * backend imposes on the API-key surface, each of which was confirmed against
 * the live backend (2026-08-25). The route must send `store:false`, refuse a
 * `params.maxTokens` budget locally because the backend rejects
 * `max_output_tokens`, request encrypted reasoning, replay it verbatim instead
 * of `item_reference` ids, and keep every credential out of the sealed view.
 */
import { Effect, Redacted, Result, Schema, Stream } from "effect"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as Auth from "../src/Auth.ts"
import * as CanonicalJson from "../src/CanonicalJson.ts"
import { ModelError } from "../src/ModelError.ts"
import * as ModelEvent from "../src/ModelEvent.ts"
import * as ModelRequest from "../src/ModelRequest.ts"
import * as OpenAIChatGPT from "../src/OpenAIChatGPT.ts"
import * as OpenAIResponses from "../src/OpenAIResponses.ts"
import * as RequestExecutor from "../src/RequestExecutor.ts"
import * as Route from "../src/Route.ts"

const request = (overrides: Partial<Parameters<typeof ModelRequest.ModelRequest.make>[0]> = {}) =>
  ModelRequest.ModelRequest.make({
    modelId: "gpt-5.6-sol",
    system: [],
    messages: [],
    tools: [],
    params: ModelRequest.GenerationParams.make(),
    ...overrides
  })

const route = () => Result.getOrThrow(OpenAIChatGPT.make({ auth: Auth.bearer(Redacted.make("chatgpt-access")) }))

const prepared = (modelRequest: ModelRequest.ModelRequest) => Effect.runPromise(Route.prepare(route(), modelRequest))

const step = (
  state: ReturnType<typeof OpenAIResponses.chatgptProtocol.stream.initial>,
  data: string
) => {
  const event = Schema.decodeUnknownSync(OpenAIResponses.chatgptProtocol.stream.event)(data)
  return Effect.runSync(OpenAIResponses.chatgptProtocol.stream.step(state, event))
}

const replayData = (data: ReadonlyArray<string>): ReadonlyArray<ModelEvent.ModelEvent> => {
  let state = OpenAIResponses.chatgptProtocol.stream.initial(request())
  const events: Array<ModelEvent.ModelEvent> = []
  for (const datum of data) {
    const [next, emitted] = step(state, datum)
    state = next
    events.push(...emitted)
  }
  return events
}

describe("OpenAIChatGPT.make", () => {
  it("composes the codex backend endpoint, protocol, and client identity headers", async () => {
    const config = route()

    expect(config.id).toBe("openai-chatgpt")
    expect(config.protocol.id).toBe("openai-responses-chatgpt")
    expect(config.protocol.supportsDeferred("gpt-5.6-sol")).toBe(false)
    expect(config.protocol.supportsDeferred("gpt-6-sol")).toBe(true)
    expect(config.framing.id).toBe("sse")
    // No `/v1` prefix: the subscription backend serves `/codex/responses`.
    expect(config.endpoint.url).toBe("https://chatgpt.com/backend-api/codex/responses")

    const view = await prepared(request())
    expect(view.publicHeaders).toEqual({
      accept: "text/event-stream",
      "content-type": "application/json",
      "openai-beta": "responses=experimental",
      originator: "codex_cli_rs",
      "user-agent": "codex_cli_rs/0.149.1"
    })
    expect(JSON.stringify(view)).not.toContain("chatgpt-access")
  })

  it("pins the subscription body deltas: store false, stream true, encrypted reasoning", async () => {
    const view = await prepared(request({
      params: ModelRequest.GenerationParams.make({ reasoningEffort: "high" })
    }))
    const body = JSON.parse(view.bodyText)

    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.include).toEqual(["reasoning.encrypted_content"])
    // Summaries are what keep a long think streaming: live on gpt-6-sol
    // (2026-09-24) they arrived at least every 10 s, which is the liveness the
    // model call's idle timeout reads. Stock Codex asks for them the same way.
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" })
    expect(body).not.toHaveProperty("max_output_tokens")
  })

  it("routes a conversation to one prompt cache: prompt_cache_key in the body and session-id on the wire", async () => {
    // Live on gpt-6-sol (2026-09-24), a 6k-token prefix replayed across four
    // frames cached 0% with no key, 95% with both, and missed again on frame 2
    // with the body field alone: the backend derives cache affinity from the
    // `session-id` header, as codex-rs `responses_session_id` says.
    const first = await prepared(request({ cacheKey: "run-7" }))
    const second = await prepared(request({ cacheKey: "run-7", messages: [ModelRequest.Message.user("next")] }))

    expect(JSON.parse(first.bodyText).prompt_cache_key).toBe("run-7")
    expect(first.publicHeaders["session-id"]).toBe("run-7")
    expect(JSON.parse(second.bodyText).prompt_cache_key).toBe("run-7")
    expect(second.publicHeaders["session-id"]).toBe("run-7")
  })

  it("sends no cache identity for a request that names none", async () => {
    const view = await prepared(request())
    expect(JSON.parse(view.bodyText)).not.toHaveProperty("prompt_cache_key")
    expect(view.publicHeaders).not.toHaveProperty("session-id")
  })

  it("asks for no reasoning at all when the request names no effort", async () => {
    const body = JSON.parse((await prepared(request())).bodyText)
    expect(body).not.toHaveProperty("reasoning")
  })

  it("refuses params.maxTokens before signing: the backend rejects max_output_tokens", () => {
    // The backend rejects `max_output_tokens` outright and offers no other
    // output cap, so the budget cannot be honored. Dropping it would send a
    // request the caller did not bound; refusing names the member instead.
    const error = Effect.runSync(
      Route.prepare(route(), request({ params: ModelRequest.GenerationParams.make({ maxTokens: 4096 }) })).pipe(
        Effect.flip
      )
    )

    expect(error).toBeInstanceOf(ModelError)
    expect(error).toMatchObject({ code: "invalid_request", path: "params.maxTokens" })
    expect(error.message).toContain("max_output_tokens")
    // The path says where, never what: a journal must not learn the budget.
    expect(JSON.stringify(error)).not.toContain("4096")
  })

  it("rejects the account id as a route header: identity is applied through Auth", () => {
    const withAccountHeader = Result.getOrThrow(OpenAIChatGPT.make({
      auth: Auth.bearer(Redacted.make("chatgpt-access")),
      headers: { "chatgpt-account-id": "acct_1234" }
    }))

    const error = Effect.runSync(Route.prepare(withAccountHeader, request()).pipe(Effect.flip))
    expect(error).toMatchObject({ code: "invalid_request" })
    expect(JSON.stringify(error)).not.toContain("acct_1234")
  })

  it("replays encrypted reasoning verbatim and drops stored item references", async () => {
    const signature = CanonicalJson.stringify({
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "opaque-reasoning-state"
    })
    const view = await prepared(request({
      messages: [
        ModelRequest.Message.user("fix it"),
        ModelRequest.Message.assistant(
          [
            { type: "thinking", text: "", signature },
            ModelRequest.ToolCallPart.make({ id: "call_1", name: "bash", arguments: "{}" })
          ],
          // Stored-mode history carries item ids; this backend stores nothing,
          // so a reference would name an item the server does not have.
          { stopReason: "tool-calls", itemIds: ["rs_0"] }
        ),
        ModelRequest.Message.tool(ModelRequest.ToolResultPart.make({ toolCallId: "call_1", content: "ok" }))
      ]
    }))
    const body = JSON.parse(view.bodyText)

    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "fix it" }] },
      { type: "reasoning", id: "rs_1", encrypted_content: "opaque-reasoning-state" },
      { type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" }
    ])
  })
})

describe("OpenAIChatGPT turn-state affinity", () => {
  const completed = `data: ${JSON.stringify({ type: "response.completed", response: { id: "r", usage: {} } })}\n\n`

  /** Streams each request through one model and records the headers it left with. */
  const drive = async (
    requests: ReadonlyArray<ModelRequest.ModelRequest>,
    turnStates: ReadonlyArray<string | undefined>,
    build: () => ReturnType<typeof route> = route
  ) => {
    const sent: Array<Readonly<Record<string, string>>> = []
    const executor = RequestExecutor.RequestExecutor.of({
      execute: (httpRequest: HttpClientRequest.HttpClientRequest) => {
        const state = turnStates[sent.length]
        sent.push({ ...httpRequest.headers })
        return Effect.succeed(HttpClientResponse.fromWeb(
          httpRequest,
          new Response(completed, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              ...(state === undefined ? {} : { "x-codex-turn-state": state })
            }
          })
        ))
      }
    })
    for (const each of requests) {
      await Effect.runPromise(Effect.scoped(
        Route.toModel(build()).pipe(
          Effect.flatMap((model) => model.stream(each).pipe(Stream.runDrain)),
          Effect.provideService(RequestExecutor.RequestExecutor, executor)
        )
      ))
    }
    return sent
  }

  it("echoes the backend's x-codex-turn-state on every later request of the same conversation", async () => {
    // The backend routes a conversation by this response header, which
    // codex-rs echoes for a turn. In a direct probe on gpt-6-sol (2026-09-24)
    // frame 3 read 0 of 11,646 input tokens from cache without the echo and
    // 9,088 with it.
    const key = `conversation-${Math.random()}`
    const sent = await drive(
      [request({ cacheKey: key }), request({ cacheKey: key }), request({ cacheKey: key })],
      ["state-1", undefined, "state-3"]
    )
    expect(sent.map((headers) => headers["x-codex-turn-state"])).toEqual([undefined, "state-1", "state-1"])
    const next = await drive([request({ cacheKey: key })], [])
    expect(next[0]?.["x-codex-turn-state"]).toBe("state-3")
  })

  it("keeps a turn state to its conversation and out of the sealed request view", async () => {
    const sent = await drive(
      [request({ cacheKey: `a-${Math.random()}` }), request({ cacheKey: `b-${Math.random()}` }), request()],
      ["state-a", "state-b", "state-none"]
    )
    expect(sent.map((headers) => headers["x-codex-turn-state"])).toEqual([undefined, undefined, undefined])
    const view = await prepared(request({ cacheKey: "sealed" }))
    expect(view.publicHeaders).not.toHaveProperty("x-codex-turn-state")
  })

  it("never carries one account's turn state onto another account's request with the same cache key", async () => {
    const key = `shared-${Math.random()}`
    const account = (token: string) => () =>
      Result.getOrThrow(OpenAIChatGPT.make({ auth: Auth.bearer(Redacted.make(token)) }))
    await drive([request({ cacheKey: key })], ["tenant-a-state"], account("tenant-a"))
    const other = await drive([request({ cacheKey: key })], [], account("tenant-b"))
    expect(other[0]?.["x-codex-turn-state"]).toBeUndefined()
    const same = await drive([request({ cacheKey: key })], [], account("tenant-a"))
    expect(same[0]?.["x-codex-turn-state"]).toBe("tenant-a-state")
  })

  it("forgets the oldest conversation once it remembers more than 1,024", async () => {
    const run = Math.random()
    const keys = Array.from({ length: 1026 }, (_, index) => `many-${run}-${index}`)
    await drive(keys.map((cacheKey) => request({ cacheKey })), keys.map((_, index) => `state-${index}`))
    const again = await drive([request({ cacheKey: keys[0]! }), request({ cacheKey: keys[1025]! })], [])
    expect(again.map((headers) => headers["x-codex-turn-state"])).toEqual([undefined, "state-1025"])
  })
})

describe("OpenAIResponses.chatgptProtocol stream", () => {
  it("captures the completed reasoning item as a replayable signature and records no item ids", () => {
    const events = replayData([
      JSON.stringify({
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_1",
        delta: "thinking aloud"
      }),
      JSON.stringify({ type: "response.reasoning_summary_text.done", item_id: "rs_1" }),
      JSON.stringify({
        type: "response.output_item.done",
        item: {
          id: "rs_1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thinking aloud" }],
          encrypted_content: "opaque-reasoning-state"
        }
      }),
      JSON.stringify({
        type: "response.completed",
        response: { id: "resp_1", usage: { input_tokens: 23, output_tokens: 5 } }
      })
    ])

    const signature = CanonicalJson.stringify({
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "thinking aloud" }],
      encrypted_content: "opaque-reasoning-state"
    })
    expect(events).toEqual([
      // The summary part carries no signature: an item id is not replayable
      // under store:false, and the real signature only exists at item done.
      { type: "thinking-start", id: "rs_1" },
      { type: "thinking-delta", id: "rs_1", text: "thinking aloud" },
      { type: "thinking-end", id: "rs_1" },
      { type: "thinking-start", id: "rs_1:encrypted", signature },
      { type: "thinking-end", id: "rs_1:encrypted" },
      {
        type: "usage",
        inputTokens: 23,
        outputTokens: 5,
        cachedInputTokens: undefined,
        reasoningTokens: undefined,
        totalTokens: undefined
      },
      { type: "settle", stopReason: "stop", responseId: "resp_1" }
    ])

    // The settled message closes the loop: its signature part lowers straight
    // back into the next request's input.
    const settled = ModelEvent.settledMessage(events)
    expect(settled.message.itemIds).toBeUndefined()
    expect(settled.usage).toMatchObject({ inputTokens: 23, outputTokens: 5 })
  })

  it("leaves a reasoning item without encrypted content unreferenced rather than fabricating one", () => {
    const events = replayData([
      JSON.stringify({ type: "response.output_item.done", item: { id: "rs_1", type: "reasoning" } }),
      JSON.stringify({ type: "response.completed", response: { id: "resp_1" } })
    ])

    expect(events).toEqual([{ type: "settle", stopReason: "stop", responseId: "resp_1" }])
  })

  it("omits the summary field from a signature whose item carried none", () => {
    const events = replayData([
      JSON.stringify({
        type: "response.output_item.added",
        item: { id: "rs_2", type: "reasoning" }
      }),
      JSON.stringify({
        type: "response.output_item.done",
        item: { id: "rs_2", type: "reasoning", encrypted_content: "opaque-reasoning-state" }
      })
    ])

    expect(events).toEqual([
      {
        type: "thinking-start",
        id: "rs_2:encrypted",
        signature: CanonicalJson.stringify({
          type: "reasoning",
          id: "rs_2",
          encrypted_content: "opaque-reasoning-state"
        })
      },
      { type: "thinking-end", id: "rs_2:encrypted" }
    ])
  })

  it("classifies the backend's flat detail envelope", () => {
    const badRequest = OpenAIResponses.chatgptProtocol.classifyError(400, "{\"detail\":\"Stream must be set to true\"}")
    expect(badRequest).toBeInstanceOf(ModelError)
    expect(badRequest).toMatchObject({
      code: "invalid_request",
      message: "Stream must be set to true",
      httpStatus: 400
    })

    const unauthenticated = OpenAIResponses.chatgptProtocol.classifyError(
      401,
      "{\"detail\":\"Could not parse your authentication token. Please try signing in again.\"}"
    )
    expect(unauthenticated).toMatchObject({ code: "authentication", httpStatus: 401 })
  })
})
