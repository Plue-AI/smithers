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
type Gateway = "answers" | "unreachable" | "never" | "invalid" | 401 | 400 | 503
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

it("answers with Luna when the gateway stays unavailable through its retries", async () => {
  const { run, sent } = judge({ AI_GATEWAY_API_KEY: "vck_test" }, 503)
  const result = await Effect.runPromise(run)
  expect(result.answers.complete).toEqual({ type: "boolean", probability: 0.95 })
  expect(sent.filter((url) => url === jevUrl)).toHaveLength(Evaluator.defaultAttempts)
  expect(sent.at(-1)).toBe("https://pool.example/chatgpt/codex/responses")
})

it.each([[401, "refused"], [400, "invalid_question"]] as const)(
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

it("fails unreachable when Luna cannot resolve either", async () => {
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
  ).rejects.toMatchObject({ code: "unreachable" })
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
    )).rejects.toMatchObject({ code: "unreachable", message: Evaluator.unreachableMessage })
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
  )).rejects.toMatchObject({ code: "unreachable", message: Evaluator.unreachableMessage })
  expect(sent).toEqual(["https://pool.example/routes"])
})
