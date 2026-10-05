import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Layer } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { afterEach, expect, it, vi } from "vitest"
import * as NativeControl from "../src/internal/NativeControl.ts"
import { layerSeatEvaluator } from "../src/internal/NativeEquipment.ts"
import { platform } from "../src/internal/NodeControlHost.ts"
import * as NodeControl from "../src/NodeControl.ts"

afterEach(() => vi.unstubAllEnvs())

it("composes native hosts without provider keys", () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "")
  const host = NativeControl.make(platform)
  expect(() => host.layerHost({ root: "/unused" })).not.toThrow()
  expect(() => host.layerControl({ root: "/unused" })).not.toThrow()
  expect(() => NodeControl.layer({ root: "/unused" })).not.toThrow()
  expect(() => NodeControl.layerControl({ root: "/unused" })).not.toThrow()
})

it("accepts an explicitly scripted judge without reading credentials", () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "")
  const host = NativeControl.make({ ...platform, evaluator: ScriptedJudge.layer })
  expect(() => host.layerHost({ root: "/unused" })).not.toThrow()
  expect(() => NodeControl.layerControl({ root: "/unused", evaluator: ScriptedJudge.layer })).not.toThrow()
})

it("does not demand a judge from a host that drives no run", () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "")
  // A listing, a diagnosis and a log read cannot reach a completion, so there
  // is nothing for a judge to rule on and nothing to refuse. The executor
  // underneath them refuses the launch instead, which is what keeps this a
  // narrower refusal rather than a hole in it.
  const host = NativeControl.make(platform)
  expect(() => host.layerControl({ root: "/unused", startsRuns: false })).not.toThrow()
  expect(() => NodeControl.layer({ root: "/unused", startsRuns: false })).not.toThrow()
  expect(() => NodeControl.layerControl({ root: "/unused", startsRuns: false })).not.toThrow()
})

it("does not demand local credentials from a remote control client", () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "")
  expect(() => NodeControl.layerControl({ remote: "http://127.0.0.1:5300" })).not.toThrow()
})

const question = { complete: Evaluator.BooleanQuestion.of({ instructions: "Complete?" }) }
const poolEnvironment = {
  SMITHERS_ACCOUNT_POOL_URL: "https://pool.example",
  SMITHERS_ACCOUNT_POOL_KEY: "host-credential",
  SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt"
}
const jevUrl = Evaluator.defaultBaseUrl
const sse = (request: Parameters<RequestExecutor.RequestExecutor["execute"]>[0], answer: unknown) => {
  const events = [
    {
      type: "response.output_text.delta",
      item_id: "answer",
      output_index: 0,
      content_index: 0,
      delta: JSON.stringify({ answers: { complete: answer } })
    },
    { type: "response.completed", response: { id: "response", status: "completed", usage: {} } }
  ]
  return HttpClientResponse.fromWeb(
    request,
    new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" }
    })
  )
}
type Gateway = "answers" | "unreachable" | "never" | "invalid" | 400 | 401 | 403 | 422 | 429 | 503
/**
 * Jev's gateway behaves as `gateway` says, over its own HTTP client; the
 * model executor serves only the pool and Luna.
 */
const judge = (environment: Record<string, string>, gateway: Gateway) => {
  const sent: string[] = []
  const jevHttp = HttpClient.make((request) => {
    sent.push(request.url)
    if (gateway === "never") return Effect.never
    if (gateway === "unreachable") {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "connect ECONNREFUSED" })
        })
      )
    }
    if (typeof gateway === "number") {
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status: gateway })))
    }
    const answers = gateway === "answers"
      ? { complete: { type: "boolean", probability: 0.9 } }
      : { complete: { type: "boolean", probability: "high" } }
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ answers })))
  })
  const executor = RequestExecutor.RequestExecutor.of({
    execute: (request) => {
      sent.push(request.url)
      if (request.url.endsWith("/routes")) {
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ routes: ["chatgpt"] })))
      }
      return Effect.succeed(sse(request, { type: "boolean", probability: 0.95 }))
    }
  })
  const run = Effect.flatMap(
    Evaluator.Evaluator,
    (evaluator) => evaluator.evaluate({ state: "proof", questions: question })
  )
    .pipe(Effect.provide(
      layerSeatEvaluator({ ...poolEnvironment, ...environment }, Layer.succeed(HttpClient.HttpClient)(jevHttp)).pipe(
        Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor))
      )
    ))
  return { run, sent }
}

it("judges with Jev and never calls Luna when the gateway answers", async () => {
  const { run, sent } = judge({ AI_GATEWAY_API_KEY: "vck_test" }, "answers")
  const result = await Effect.runPromise(run)
  expect(result.answers.complete).toEqual({ type: "boolean", probability: 0.9 })
  expect(sent).toEqual([jevUrl])
})

it("judges through the metered model proxy a self-hosted Flow host is given", async () => {
  // The backend hands a Flow host a per-binding credential and the proxy URLs,
  // never a gateway key; the public gateway answers that credential 401.
  const proxied = judge({
    AI_GATEWAY_API_KEY: "smithers-binding-credential",
    SMITHERS_MODEL_PROXY_URL: "http://backend.internal:4000/model-proxy",
    SMITHERS_MODEL_PROXY_PROVIDERS: "cerebras,vercel"
  }, "answers")
  await Effect.runPromise(proxied.run)
  expect(proxied.sent).toEqual(["http://backend.internal:4000/model-proxy/vercel/v4/ai/evaluation-model"])

  const explicit = judge({
    AI_GATEWAY_API_KEY: "smithers-binding-credential",
    SMITHERS_EVALUATOR_BASE_URL: "http://backend.internal:4000/model-proxy/vercel/v4/ai/evaluation-model"
  }, "answers")
  await Effect.runPromise(explicit.run)
  expect(explicit.sent).toEqual(["http://backend.internal:4000/model-proxy/vercel/v4/ai/evaluation-model"])
})

it("keeps Jev on the public gateway when the proxy does not serve vercel", async () => {
  const { run, sent } = judge({
    AI_GATEWAY_API_KEY: "vck_test",
    SMITHERS_MODEL_PROXY_URL: "http://backend.internal:4000/model-proxy",
    SMITHERS_MODEL_PROXY_PROVIDERS: "cerebras"
  }, "answers")
  await Effect.runPromise(run)
  expect(sent).toEqual([jevUrl])
})

it("answers with Luna through the pool seat when Jev is unreachable", async () => {
  const { run, sent } = judge({ AI_GATEWAY_API_KEY: "vck_test" }, "unreachable")
  const result = await Effect.runPromise(run)
  expect(result.answers.complete).toEqual({ type: "boolean", probability: 0.95 })
  expect(sent.at(-1)).toBe("https://pool.example/chatgpt/codex/responses")
})

it("answers with Luna when Jev times out", async () => {
  vi.useFakeTimers()
  try {
    const { run, sent } = judge({ AI_GATEWAY_API_KEY: "vck_test" }, "never")
    const result = Effect.runPromise(run)
    await vi.advanceTimersByTimeAsync(Evaluator.defaultTimeoutMs + 100)
    expect((await result).answers.complete).toEqual({ type: "boolean", probability: 0.95 })
    expect(sent.at(-1)).toBe("https://pool.example/chatgpt/codex/responses")
  } finally {
    vi.useRealTimers()
  }
})

it("answers with Luna, without a gateway request, when no gateway key is set", async () => {
  const { run, sent } = judge({}, "answers")
  const result = await Effect.runPromise(run)
  expect(result.answers.complete).toEqual({ type: "boolean", probability: 0.95 })
  expect(sent).not.toContain(jevUrl)
})

it.each([429, 503] as const)("answers with Luna when the gateway keeps answering %s", async (status) => {
  const { run, sent } = judge({ AI_GATEWAY_API_KEY: "vck_test" }, status)
  const result = await Effect.runPromise(run)
  expect(result.answers.complete).toEqual({ type: "boolean", probability: 0.95 })
  expect(sent.filter((url) => url === jevUrl)).toHaveLength(Evaluator.defaultAttempts)
  expect(sent.at(-1)).toBe("https://pool.example/chatgpt/codex/responses")
})

it.each([[400, "invalid_question"], [401, "refused"], [403, "refused"], [422, "invalid_question"]] as const)(
  "does not fall back to Luna when the gateway answers %s",
  async (status, code) => {
    const { run, sent } = judge({ AI_GATEWAY_API_KEY: "vck_test" }, status)
    await expect(Effect.runPromise(run)).rejects.toMatchObject({ code, status })
    expect(sent).toEqual([jevUrl])
  }
)

it("does not fall back to Luna when Jev answers something invalid", async () => {
  const { run, sent } = judge({ AI_GATEWAY_API_KEY: "vck_test" }, "invalid")
  await expect(Effect.runPromise(run)).rejects.toMatchObject({ code: "invalid_answer" })
  expect(sent).toEqual([jevUrl])
})

it("explains missing gateway setup through the TUI message, without using a provider API key", async () => {
  const executor = RequestExecutor.RequestExecutor.of({
    execute: () => Effect.die("must not call an API-key provider")
  })
  try {
    await Effect.runPromise(
      Effect.flatMap(Evaluator.Evaluator, (evaluator) => evaluator.evaluate({ state: {}, questions: question })).pipe(
        Effect.provide(
          layerSeatEvaluator({
            OPENAI_API_KEY: "sk-test",
            SMITHERS_OPENAI_AUTH: "api-key",
            CODEX_HOME: "/nonexistent"
          })
            .pipe(Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor)))
        )
      )
    )
    throw new Error("Expected missing judge setup to fail")
  } catch (error) {
    expect(error).toMatchObject({ code: "unconfigured" })
    const message = Evaluator.publicMessage(error as Evaluator.EvaluatorError)
    expect(message).toContain("AI_GATEWAY_API_KEY")
    expect(message).not.toContain("did not answer")
    expect(message).not.toContain("sk-test")
  }
})

it("judges on the gateway's second-vendor model when Jev cannot answer and no Luna subscription exists", async () => {
  // An install's Flow host: its Gateway credential reaches Jev and the
  // Gateway's chat route through the backend's model proxy, and nothing signs
  // Luna. The real-GitHub walk logged 11 unjudged completions this way.
  const proxy = "http://backend.internal:4000/model-proxy"
  const jevCalls: string[] = []
  const jevHttp = HttpClient.make((request) => {
    jevCalls.push(request.url)
    return Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: "private gateway address and token" })
      })
    )
  })
  const routed: Array<{ readonly url: string; readonly model: unknown }> = []
  const executor = RequestExecutor.RequestExecutor.of({
    execute: (request) => {
      const body = request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : {}
      routed.push({ url: request.url, model: body.model })
      const answer = JSON.stringify({ answers: { complete: { type: "boolean", probability: 0.95 } } })
      const frames = [
        { id: "chat_1", choices: [{ index: 0, delta: { role: "assistant", content: answer } }] },
        { id: "chat_1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
      ]
      return Effect.succeed(HttpClientResponse.fromWeb(
        request,
        new Response(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" }
        })
      ))
    }
  })
  const result = await Effect.runPromise(
    Effect.flatMap(Evaluator.Evaluator, (evaluator) => evaluator.evaluate({ state: {}, questions: question })).pipe(
      Effect.provide(
        layerSeatEvaluator({
          AI_GATEWAY_API_KEY: "smithers-binding-credential",
          SMITHERS_MODEL_PROXY_URL: proxy,
          SMITHERS_MODEL_PROXY_PROVIDERS: "cerebras,vercel",
          CODEX_HOME: "/nonexistent"
        }, Layer.succeed(HttpClient.HttpClient)(jevHttp)).pipe(
          Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor))
        )
      )
    )
  )
  expect(result.answers.complete).toEqual({ type: "boolean", probability: 0.95 })
  expect(jevCalls).toEqual(Array(Evaluator.defaultAttempts).fill(`${proxy}/vercel/v4/ai/evaluation-model`))
  expect(routed).toHaveLength(1)
  expect(routed[0]!.url).toBe(`${proxy}/vercel/v1/chat/completions`)
  expect(routed[0]!.model).toBe("anthropic/claude-sonnet-4.5")
})

it("asks for Codex login when Luna was opted in without a usable session", async () => {
  const executor = RequestExecutor.RequestExecutor.of({
    execute: () => Effect.die("An unsigned Luna must never reach model transport")
  })
  try {
    await Effect.runPromise(
      Effect.flatMap(Evaluator.Evaluator, (evaluator) => evaluator.evaluate({ state: {}, questions: question })).pipe(
        Effect.provide(
          layerSeatEvaluator({
            SMITHERS_OPENAI_AUTH: "chatgpt",
            CODEX_HOME: "/nonexistent"
          }).pipe(Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor)))
        )
      )
    )
    throw new Error("Expected missing Codex session")
  } catch (error) {
    expect(error).toMatchObject({ code: "unconfigured" })
    const message = Evaluator.publicMessage(error as Evaluator.EvaluatorError)
    expect(message).toContain("ChatGPT login")
    expect(message).toContain("codex login")
    expect(message).not.toContain("did not answer")
  }
})

it("keeps the missing gateway setup reason when Luna cannot resolve either", async () => {
  const executor = RequestExecutor.RequestExecutor.of({
    execute: () => Effect.die("must not call an API-key provider")
  })
  await expect(
    Effect.runPromise(
      Effect.flatMap(Evaluator.Evaluator, (evaluator) => evaluator.evaluate({ state: {}, questions: {} })).pipe(
        Effect.provide(
          layerSeatEvaluator({ CODEX_HOME: "/nonexistent" })
            .pipe(
              Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor))
            )
        )
      )
    )
  ).rejects.toMatchObject({ code: "unconfigured", message: expect.stringContaining("AI_GATEWAY_API_KEY") })
})

it.each(["unavailable", "disconnected"] as const)(
  "fails closed when the subscription pool is %s during resolution",
  async (failure) => {
    const sent: string[] = []
    const executor = RequestExecutor.RequestExecutor.of({
      execute: (request) => {
        sent.push(request.url)
        expect(request.url).toBe("https://pool.example/routes")
        const response = failure === "unavailable"
          ? Response.json({ error: "private pool diagnostic" }, { status: 503 })
          : Response.json({ routes: [] })
        return Effect.succeed(HttpClientResponse.fromWeb(request, response))
      }
    })
    await expect(Effect.runPromise(
      Effect.flatMap(Evaluator.Evaluator, (judge) =>
        judge.evaluate({
          state: "proof",
          questions: { complete: Evaluator.BooleanQuestion.of({ instructions: "Complete?" }) }
        })).pipe(Effect.provide(
          layerSeatEvaluator({
            SMITHERS_ACCOUNT_POOL_URL: "https://pool.example",
            SMITHERS_ACCOUNT_POOL_KEY: "host-credential",
            SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt",
            CODEX_HOME: "/nonexistent",
            OPENAI_API_KEY: "must-not-use"
          }).pipe(Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor)))
        ))
    )).rejects.toMatchObject({ code: "unconfigured", message: expect.stringContaining("AI_GATEWAY_API_KEY") })
    expect(sent).toHaveLength(1)
  }
)

it("fails closed when the subscription pool's route list cannot be read", async () => {
  const sent: string[] = []
  const executor = RequestExecutor.RequestExecutor.of({
    execute: (request) => {
      sent.push(request.url)
      const body = new ReadableStream({ start: (controller) => controller.error(new Error("connection reset")) })
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)))
    }
  })
  await expect(Effect.runPromise(
    Effect.flatMap(Evaluator.Evaluator, (judge) =>
      judge.evaluate({
        state: "proof",
        questions: { complete: Evaluator.BooleanQuestion.of({ instructions: "Complete?" }) }
      })).pipe(Effect.provide(
        layerSeatEvaluator({
          SMITHERS_ACCOUNT_POOL_URL: "https://pool.example",
          SMITHERS_ACCOUNT_POOL_KEY: "host-credential",
          SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt",
          CODEX_HOME: "/nonexistent",
          OPENAI_API_KEY: "must-not-use"
        }).pipe(Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor)))
      ))
  )).rejects.toMatchObject({ code: "unconfigured", message: expect.stringContaining("AI_GATEWAY_API_KEY") })
  expect(sent).toEqual(["https://pool.example/routes"])
})
