/**
 * The native-structured-output toggle on the OpenAI-compatible chat
 * completions route.
 *
 * The behaviour under test was measured against a live Cerebras seat on
 * 2026-08-29: `POST https://api.cerebras.ai/v1/chat/completions` answers
 * `{"message":"\"tools\" is incompatible with \"response_format\"", "code":
 * "wrong_api_format"}` when a body carries both, and answers a schema-valid
 * document when it carries `response_format` alone. The lowering therefore
 * emits `response_format` only when the route is configured for it, and
 * refuses a request that would have been rejected on the wire.
 */
import { Effect, Redacted, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as ModelError from "../src/ModelError.ts"
import * as ModelRequest from "../src/ModelRequest.ts"
import * as OpenAIChatCompletions from "../src/OpenAIChatCompletions.ts"
import * as Route from "../src/Route.ts"

const capital = {
  name: "capital",
  strict: true,
  schema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false
  }
} as const

const request = (tools: ReadonlyArray<ModelRequest.ToolDefinition> = [], toolChoice?: "none") =>
  ModelRequest.ModelRequest.make({
    modelId: "gpt-oss-120b",
    system: [],
    messages: [ModelRequest.Message.user("What is the capital of France?")],
    tools,
    params: ModelRequest.GenerationParams.make({ maxTokens: 64, temperature: 0 }),
    ...(toolChoice === undefined ? {} : { toolChoice })
  })

const weather = ModelRequest.ToolDefinition.make({
  name: "get_weather",
  description: "Get the current weather for a city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
})

const body = (route: Route.Route<OpenAIChatCompletions.Body, string, never, never>, input: ModelRequest.ModelRequest) =>
  Effect.runPromise(Effect.result(Route.prepare(route as never, input)))

const configured = (structuredOutput?: OpenAIChatCompletions.StructuredOutput) =>
  Result.getOrThrow(Route.openaiChatCompatible({
    id: "cerebras",
    providerName: "cerebras",
    baseUrl: "https://api.cerebras.ai",
    apiKey: Redacted.make("test-key"),
    ...(structuredOutput === undefined ? {} : { structuredOutput })
  }))

describe("OpenAIChatCompletions native structured output", () => {
  it("omits response_format when the route is not configured for it", async () => {
    const prepared = await body(configured() as never, request())

    expect(Result.isSuccess(prepared)).toBe(true)
    const parsed = JSON.parse(Result.getOrThrow(prepared).bodyText) as Record<string, unknown>
    expect(parsed["response_format"]).toBeUndefined()
  })

  it("lowers the configured schema into response_format", async () => {
    const prepared = await body(configured(capital) as never, request())

    const parsed = JSON.parse(Result.getOrThrow(prepared).bodyText) as Record<string, unknown>
    expect(parsed["response_format"]).toEqual({
      type: "json_schema",
      json_schema: { name: "capital", schema: capital.schema, strict: true }
    })
    expect(parsed["tools"]).toBeUndefined()
  })

  it("defaults strict to true so the provider enforces the schema", async () => {
    const prepared = await body(
      configured({ name: "capital", schema: capital.schema }) as never,
      request()
    )

    const parsed = JSON.parse(Result.getOrThrow(prepared).bodyText) as Record<string, unknown>
    expect((parsed["response_format"] as { json_schema: { strict: boolean } }).json_schema.strict).toBe(true)
  })

  it("refuses a request that declares tools, which the provider rejects on the wire", async () => {
    const prepared = await body(configured(capital) as never, request([weather]))

    expect(Result.isFailure(prepared)).toBe(true)
    const error = Result.isFailure(prepared) ? prepared.failure : undefined
    expect(error).toBeInstanceOf(ModelError.ModelError)
    expect(error?.code).toBe("invalid_request")
    expect(error?.message).toContain("response_format")
  })

  it("allows declared tools when toolChoice none keeps them off the wire", async () => {
    const prepared = await body(configured(capital) as never, request([weather], "none"))

    expect(Result.isSuccess(prepared)).toBe(true)
    const parsed = JSON.parse(Result.getOrThrow(prepared).bodyText) as Record<string, unknown>
    expect(parsed["response_format"]).toEqual({
      type: "json_schema",
      json_schema: { name: "capital", schema: capital.schema, strict: true }
    })
    expect(parsed).not.toHaveProperty("tools")
  })

  it("keeps tools available on a route without the toggle", async () => {
    const prepared = await body(configured() as never, request([weather]))

    const parsed = JSON.parse(Result.getOrThrow(prepared).bodyText) as Record<string, unknown>
    expect(Array.isArray(parsed["tools"])).toBe(true)
  })

  it("validates a configured schema against the wire body codec", () => {
    const decoded = Schema.decodeUnknownSync(OpenAIChatCompletions.ResponseFormat)({
      type: "json_schema",
      json_schema: { name: "capital", strict: true, schema: capital.schema }
    })

    expect(decoded.json_schema.name).toBe("capital")
  })
})
