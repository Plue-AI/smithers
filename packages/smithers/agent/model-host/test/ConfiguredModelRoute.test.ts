import * as Evaluator from "@smthrs/model/Evaluator"
import { planModelBinding } from "@smthrs/rpc/ConfiguredModel"
import type { ModelProtocol } from "@smthrs/rpc/ConfiguredModel"
import { Effect, Layer, Redacted, Result } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { describe, expect, test } from "vitest"
import { toEvaluatorLayer, withRoute } from "../src/ConfiguredModelRoute.ts"

const plan = (protocol: ModelProtocol) => {
  const planned = planModelBinding({
    protocol,
    baseUrl: "https://fixture.test",
    modelId: "fixture",
    credential: "FIXTURE"
  }, [{ name: "FIXTURE", present: true, origins: ["https://fixture.test"] }])
  if (!planned.ok) throw new Error("invalid fixture plan")
  return planned.plan
}

describe("configured model routes", () => {
  test.each(
    [
      ["anthropic-messages", "/v1/messages"],
      ["openai-responses", "/v1/responses"],
      ["openai-chat", "/v1/chat/completions"]
    ] as const
  )("preserves the configured endpoint and protocol for %s", (protocol, path) => {
    const route = Result.getOrThrow(withRoute(plan(protocol), Redacted.make("fixture-key"), (value) => ({
      id: value.id,
      endpoint: value.endpoint,
      headers: value.headers
    })))
    expect(route.id).toBe(protocol)
    expect(route.endpoint.url).toBe(`https://fixture.test${path}`)
    if (protocol === "anthropic-messages") expect(route.headers).toMatchObject({ "anthropic-version": "2023-06-01" })
  })

  test.each(["{\"accessToken\":\"token\"}", "{\"accountId\":\"account\"}", "not-json"])(
    "incomplete ChatGPT sign-in refuses before visiting the route (%s)",
    (credential) => {
      let visited = false
      expect(withRoute(plan("openai-responses-chatgpt"), Redacted.make(credential), () => {
        visited = true
      })).toMatchObject({
        failure: { code: "authentication", message: "ChatGPT sign-in unavailable" }
      })
      expect(visited).toBe(false)
    }
  )

  test("refuses decision plans as generation routes", () => {
    expect(withRoute(plan("evaluation"), Redacted.make("fixture-key"), () => "unreachable")).toMatchObject({
      failure: { code: "no_route" }
    })
  })

  test("configures the evaluator with the planned URL, model, and redacted credential", async () => {
    const layer = toEvaluatorLayer(plan("evaluation"), Redacted.make("fixture-key"), 1_000).pipe(
      Layer.provide(
        FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(
              FetchHttpClient.Fetch,
              Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
                expect(String(input)).toBe("https://fixture.test/v4/ai/evaluation-model")
                expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-key")
                expect(new Headers(init?.headers).get("ai-model-id")).toBe("fixture")
                return Response.json({ answers: { ok: { type: "boolean", probability: 0.8 } } })
              }, { preconnect() {} })
            )
          )
        )
      )
    )
    const response = await Effect.runPromise(
      Effect.gen(function*() {
        const evaluator = yield* Evaluator.Evaluator
        return yield* evaluator.evaluate({
          state: {},
          questions: { ok: { type: "boolean", instructions: "OK?", criteria: { true: "yes", false: "no" } } }
        })
      }).pipe(Effect.provide(layer))
    )
    expect(response.answers).toEqual({ ok: { type: "boolean", probability: 0.8 } })
  })
})
