import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import { Effect, Layer, Redacted, Result, Stream } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import { classifyHttpStatus } from "../src/HttpStatusClassifier.ts"
import * as ModelRequest from "../src/ModelRequest.ts"
import * as RequestExecutor from "../src/RequestExecutor.ts"
import * as Route from "../src/Route.ts"

const request = ModelRequest.ModelRequest.make({
  modelId: "test-model",
  system: [],
  messages: [],
  tools: [],
  params: ModelRequest.GenerationParams.make({ maxTokens: 100 })
})
const apiKey = Redacted.make("test-secret")
const routes = [
  ["anthropic", Route.toModel(Result.getOrThrow(Route.anthropic({ apiKey })))],
  ["responses", Route.toModel(Result.getOrThrow(Route.openai({ apiKey })))],
  [
    "chat",
    Route.toModel(
      Result.getOrThrow(Route.openaiChatCompatible({ id: "chat", baseUrl: "https://example.test", apiKey }))
    )
  ]
] as const

for (const [name, toModel] of routes) {
  describe(name, () => {
    const errorFor = async (status: number, body: string) => {
      let attempts = 0
      const client = HttpClient.make((sent) => {
        attempts += 1
        return Effect.succeed(HttpClientResponse.fromWeb(
          sent,
          new Response(body, {
            status,
            headers: { "retry-after-ms": "0" }
          })
        ))
      })
      const error = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const model = yield* toModel
            return yield* model.stream(request).pipe(Stream.runDrain, Effect.flip)
          }).pipe(
            Effect.provide(RequestExecutor.layer),
            Effect.provide(Layer.succeed(KernelHttpClient.HttpClient)(client)),
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
          )
        )
      )
      return { error, attempts }
    }

    it.each(["", "{}", JSON.stringify({ error: { message: "Insufficient credits" } })])(
      "classifies bare HTTP 402 as terminal quota: %s",
      async (body) => {
        const { error, attempts } = await errorFor(402, body)
        expect(error).toMatchObject({ code: "quota_exceeded", httpStatus: 402, retryable: false })
        expect(attempts).toBe(1)
      }
    )

    it("preserves hosted out_of_credit as a terminal typed model code", async () => {
      const body = JSON.stringify({ status: "error", code: "out_of_credit", message: "Out of credit." })
      const { error, attempts } = await errorFor(402, body)
      expect(error).toMatchObject({
        _tag: "flows/model/ModelError",
        code: "out_of_credit",
        providerCode: "out_of_credit",
        httpStatus: 402,
        retryable: false
      })
      expect(attempts).toBe(1)
    })

    it.each(
      [
        [400, "invalid_request"],
        [401, "authentication"],
        [403, "authentication"],
        [404, "invalid_request"],
        [409, "invalid_request"],
        [413, "invalid_request"],
        [418, "unknown"],
        [422, "invalid_request"],
        [429, "rate_limited"],
        [500, "provider_internal"],
        [503, "provider_internal"],
        [504, "provider_internal"],
        [529, name === "anthropic" ? "rate_limited" : "provider_internal"]
      ] as const
    )("classifies HTTP %i as %s", async (status, code) => {
      const { error } = await errorFor(status, "{}")
      expect(error).toMatchObject({ code, httpStatus: status })
    })

    it("recognizes incorrect API key wording independently of HTTP status", async () => {
      const { error } = await errorFor(418, JSON.stringify({ error: { message: "Incorrect API key provided" } }))
      expect(error).toMatchObject({ code: "authentication", httpStatus: 418 })
    })
  })
}

describe("in-stream failures", () => {
  // A `response.failed` or `error` event arrives after HTTP 200, so only the
  // provider's code and words classify it. These are transient provider
  // faults and must stay retryable.
  it.each(
    [
      [undefined, "Our servers are currently overloaded. Please try again later."],
      ["server_is_overloaded", "The server is overloaded"],
      ["overloaded_error", "Overloaded"],
      [undefined, "Service unavailable"]
    ] as const
  )("classifies %s / %s as provider_internal", (code, message) => {
    expect(classifyHttpStatus(undefined, code, message)).toBe("provider_internal")
  })

  it("leaves unrelated stream failures unknown", () => {
    expect(classifyHttpStatus(undefined, undefined, "OpenAI Responses stream failed")).toBe("unknown")
  })
})
