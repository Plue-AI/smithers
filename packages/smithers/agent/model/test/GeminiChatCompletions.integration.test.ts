/**
 * The Chat Completions protocol against Google's compatible endpoint.
 *
 * Requires explicit `SMITHERS_LIVE_MODEL_TESTS=1` and `GEMINI_API_KEY`.
 * Credentials are applied only by the route's auth layer and never enter a
 * prepared request or test output. Merely having a credential must not turn
 * the ordinary suite into billable provider traffic.
 */
import { Effect, Layer, Redacted, Result, Stream } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { describe, expect, it } from "vitest"
import * as ModelEvent from "../src/ModelEvent.ts"
import * as ModelRequest from "../src/ModelRequest.ts"
import * as RequestExecutor from "../src/RequestExecutor.ts"
import * as Route from "../src/Route.ts"

const apiKey = process.env["GEMINI_API_KEY"]
const live = process.env["SMITHERS_LIVE_MODEL_TESTS"] === "1"
const MODEL_ID = "gemini-3-flash-preview"

const executorLayer = Layer.provide(RequestExecutor.layer, FetchHttpClient.layer)

const route = () =>
  Route.openaiChatCompatible({
    id: "gemini",
    providerName: "gcp.gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    path: "/chat/completions",
    apiKey: Redacted.make(apiKey ?? "")
  })

const collectOnce = (request: ModelRequest.ModelRequest): Promise<ReadonlyArray<ModelEvent.ModelEvent>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const model = yield* Route.toModel(yield* Effect.fromResult(route()))
      return yield* Stream.runCollect(model.stream(request))
    }).pipe(Effect.provide(executorLayer))
  )

// The free tier can answer 429 when two suite runs share a quota window. Retry
// that provider response once after its suggested delay; any second failure is
// surfaced normally.
const collect = async (request: ModelRequest.ModelRequest): Promise<ReadonlyArray<ModelEvent.ModelEvent>> => {
  try {
    return await collectOnce(request)
  } catch (error) {
    const message = String((error as { readonly message?: unknown } | null)?.message ?? error)
    const suggested = message.match(/retry in (\d+(?:\.\d+)?)s/i)
    if (!message.includes("exceeded your current quota") && suggested === null) throw error
    const delaySeconds = Math.min(70, suggested === null ? 62 : Number(suggested[1]) + 2)
    await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000))
    return collectOnce(request)
  }
}

describe.skipIf(!live || apiKey === undefined || apiKey === "")("OpenAIChatCompletions over Gemini", () => {
  it("targets the compatible chat-completions path", () => {
    const configured = Result.getOrThrow(route())

    expect(configured.protocol.id).toBe("openai-chat-completions")
    expect(configured.endpoint.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    )
  })

  it("streams a short completion", async () => {
    const events = await collect(ModelRequest.ModelRequest.make({
      modelId: MODEL_ID,
      system: [ModelRequest.SystemPart.make({ text: "Answer with one lowercase word and no punctuation." })],
      messages: [ModelRequest.Message.user("What colour is a clear midday sky? Answer with one word.")],
      tools: [],
      params: ModelRequest.GenerationParams.make({ maxTokens: 4096, temperature: 0 })
    }))

    const { message, usage } = ModelEvent.ModelEvent.settledMessage(events)
    expect(message.stopReason).toBe("stop")
    expect(message.content.some((part) => part.type === "text" && part.text.trim() !== "")).toBe(true)
    expect(usage.inputTokens).toBeGreaterThan(0)
    expect(usage.outputTokens).toBeGreaterThan(0)
    expect(events.filter((event) => event.type === "settle")).toHaveLength(1)
  }, 180_000)

  it("streams a tool call with reassembled arguments", async () => {
    const events = await collect(ModelRequest.ModelRequest.make({
      modelId: MODEL_ID,
      system: [],
      messages: [ModelRequest.Message.user("What is the weather in Paris? Use the tool.")],
      tools: [
        ModelRequest.ToolDefinition.make({
          name: "get_weather",
          description: "Get the current weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"]
          }
        })
      ],
      params: ModelRequest.GenerationParams.make({ maxTokens: 4096, temperature: 0 })
    }))

    const { message } = ModelEvent.ModelEvent.settledMessage(events)
    expect(message.stopReason).toBe("tool-calls")
    const call = message.content.find((part) => part.type === "tool-call")
    expect(call?.name).toBe("get_weather")
    expect(JSON.parse(call?.arguments ?? "{}")).toMatchObject({ city: "Paris" })
  }, 180_000)
})
