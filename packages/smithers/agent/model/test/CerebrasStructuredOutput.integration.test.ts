/**
 * The native-structured-output toggle against a live Cerebras seat.
 *
 * Cerebras serves the Chat Completions wire shape and is the release-validation
 * seat for this check. Live cases require `SMITHERS_LIVE_MODEL_TESTS=1` and
 * `CEREBRAS_API_KEY`; the credential is
 * applied only by the route's auth layer and never enters a prepared request or
 * test output.
 *
 * The gate is a `ctx.skip` in each case body rather than a `describe.skipIf`,
 * so a machine without the credential reports the missing variable by name
 * instead of a bare skipped count that reads the same as covered work.
 */
import { Effect, Layer, Redacted, Result, Schema, Stream } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import type { TestContext } from "vitest"
import { describe, expect, it } from "vitest"
import * as ModelEvent from "../src/ModelEvent.ts"
import * as ModelRequest from "../src/ModelRequest.ts"
import type * as OpenAIChatCompletions from "../src/OpenAIChatCompletions.ts"
import * as RequestExecutor from "../src/RequestExecutor.ts"
import * as Route from "../src/Route.ts"

const apiKey = process.env["CEREBRAS_API_KEY"]
const BASE_URL = "https://api.cerebras.ai/v1"
const MODEL_ID = "qwen-3.8-27b"

const executorLayer = Layer.provide(RequestExecutor.layer, FetchHttpClient.layer)

const capital = {
  name: "capital",
  schema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false
  }
} as const

const Capital = Schema.Struct({ city: Schema.String })

const route = (structuredOutput?: OpenAIChatCompletions.StructuredOutput) =>
  Route.openaiChatCompatible({
    id: "cerebras",
    providerName: "cerebras",
    baseUrl: BASE_URL,
    path: "/chat/completions",
    apiKey: Redacted.make(apiKey ?? ""),
    ...(structuredOutput === undefined ? {} : { structuredOutput })
  })

const ask = (
  structuredOutput: OpenAIChatCompletions.StructuredOutput | undefined,
  tools: ReadonlyArray<ModelRequest.ToolDefinition>
): Promise<ReadonlyArray<ModelEvent.ModelEvent>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const model = yield* Route.toModel(yield* Effect.fromResult(route(structuredOutput)))
      return yield* Stream.runCollect(model.stream(ModelRequest.ModelRequest.make({
        modelId: MODEL_ID,
        system: [],
        messages: [ModelRequest.Message.user("What is the capital of France?")],
        tools,
        params: ModelRequest.GenerationParams.make({ maxTokens: 256, temperature: 0 })
      })))
    }).pipe(Effect.provide(executorLayer))
  )

const weather = ModelRequest.ToolDefinition.make({
  name: "get_weather",
  description: "Get the current weather for a city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
})

/** Skips with the missing credential named, never with a bare skipped count. */
const requireKey = (ctx: TestContext): void => {
  if (process.env["SMITHERS_LIVE_MODEL_TESTS"] !== "1") {
    ctx.skip("live provider tests require SMITHERS_LIVE_MODEL_TESTS=1")
  }
  if (apiKey === undefined || apiKey === "") ctx.skip("CEREBRAS_API_KEY is unset")
}

describe("Route.openaiChatCompatible over Cerebras", () => {
  it("targets the compatible chat-completions path", (ctx) => {
    requireKey(ctx)
    const configured = Result.getOrThrow(route(capital))

    expect(configured.protocol.id).toBe("openai-chat-completions")
    expect(configured.endpoint.url).toBe("https://api.cerebras.ai/v1/chat/completions")
  })

  it("streams an answer the declared schema decodes", async (ctx) => {
    requireKey(ctx)
    const events = await ask(capital, [])

    const { message } = ModelEvent.ModelEvent.settledMessage(events)
    expect(message.stopReason).toBe("stop")
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("")
    expect(Schema.decodeUnknownSync(Capital)(JSON.parse(text)).city).toContain("Paris")
  }, 180_000)

  it("still streams a plain completion with the toggle off", async (ctx) => {
    requireKey(ctx)
    const events = await ask(undefined, [])

    const { message, usage } = ModelEvent.ModelEvent.settledMessage(events)
    expect(message.stopReason).toBe("stop")
    expect(usage.outputTokens).toBeGreaterThan(0)
  }, 180_000)

  it("refuses tools locally instead of taking the provider's 400", async (ctx) => {
    requireKey(ctx)
    const failure = await Effect.runPromise(
      Effect.result(
        Effect.gen(function*() {
          const configured = yield* Effect.fromResult(route(capital))
          return yield* Route.prepare(
            configured,
            ModelRequest.ModelRequest.make({
              modelId: MODEL_ID,
              system: [],
              messages: [ModelRequest.Message.user("What is the capital of France?")],
              tools: [weather],
              params: ModelRequest.GenerationParams.make({})
            })
          )
        })
      )
    )

    expect(Result.isFailure(failure)).toBe(true)
    expect(Result.isFailure(failure) ? failure.failure.code : undefined).toBe("invalid_request")
  })

  // The refusal above is only worth having because the provider really does
  // reject the combination. This proves the premise on the live endpoint,
  // through fetch rather than the route, since the route will not build such a
  // body any more.
  it("proves the provider rejects tools together with response_format", async (ctx) => {
    requireKey(ctx)
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey ?? ""}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: [{ role: "user", content: "What is the capital of France?" }],
        tools: [{
          type: "function",
          function: { name: "get_weather", description: "weather", parameters: { type: "object", properties: {} } }
        }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "capital", strict: true, schema: capital.schema }
        },
        max_tokens: 64
      })
    })

    expect(response.status).toBe(400)
    const body = await response.json() as { readonly message?: string; readonly code?: string }
    expect(body.message).toContain("incompatible")
    expect(body.code).toBe("wrong_api_format")
  }, 180_000)
})
