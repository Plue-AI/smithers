import { Model, ModelEvent, ModelRequest, RequestExecutor, Route } from "@smthrs/model"
import { Effect, Layer, Redacted, Result, Stream } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as http from "node:http"
import { describe, expect, it } from "vitest"
import * as Budget from "../src/Budget.ts"

describe("Responses usage admitted by the budget", () => {
  it("counts reasoning within output when the provider omits its total", async () => {
    let includeTotal = true
    const server = http.createServer((request, response) => {
      request.resume()
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(`data: ${
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "budget-response",
            usage: {
              input_tokens: 12,
              output_tokens: 8,
              output_tokens_details: { reasoning_tokens: 3 },
              ...(includeTotal ? { total_tokens: 20 } : {})
            }
          }
        })
      }\n\n`)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address() as { port: number }
    const route = Result.getOrThrow(Route.openaiResponsesCompatible({
      id: "budget-compatible",
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: Redacted.make("placeholder")
    }))
    const layer = Layer.mergeAll(
      Budget.layer({ tokens: { max: 42 } }),
      Route.layer(route).pipe(Layer.provide(RequestExecutor.layer), Layer.provide(FetchHttpClient.layer))
    )
    const modelRequest = ModelRequest.ModelRequest.make({
      modelId: "budget-model",
      system: [],
      messages: [ModelRequest.Message.user("hello")],
      tools: [],
      params: ModelRequest.GenerationParams.make()
    })

    try {
      for (const total of [true, false]) {
        includeTotal = total
        const result = await Effect.runPromise(
          Effect.gen(function*() {
            const model = yield* Model.Model
            const events = yield* Stream.runCollect(model.stream(modelRequest))
            const usage = ModelEvent.settledMessage(events).usage
            const budget = yield* Budget.Budget
            yield* budget.record("first", usage)
            return { usage, spent: yield* budget.usage, next: yield* budget.check("second") }
          }).pipe(Effect.provide(layer), Effect.scoped)
        )

        expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 8, reasoningTokens: 3 })
        expect(result.usage.totalTokens).toBe(total ? 20 : undefined)
        expect(result.spent).toMatchObject({ tokens: 20, calls: 1, largestCall: 20 })
        expect(result.next._tag).toBe("proceed")
      }
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
