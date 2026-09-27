import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Layer } from "effect"
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

it.each(["chatgpt", "anthropic"] as const)(
  "judges through a %s provider_connections pool seat without provider keys",
  async (route) => {
    const sent: string[] = []
    const answer = JSON.stringify({ answers: { complete: { type: "boolean", probability: 0.95 } } })
    const executor = RequestExecutor.RequestExecutor.of({
      execute: (request) => {
        sent.push(request.url)
        if (request.url.endsWith("/routes")) {
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ routes: [route] })))
        }
        const events = route === "chatgpt" ?
          [
            { type: "response.output_text.delta", item_id: "answer", output_index: 0, content_index: 0, delta: answer },
            { type: "response.completed", response: { id: "response", status: "completed", usage: {} } }
          ] :
          [
            { type: "message_start", message: { id: "response", role: "assistant", content: [], usage: {} } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
            { type: "message_stop" }
          ]
        return Effect.succeed(HttpClientResponse.fromWeb(
          request,
          new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" }
          })
        ))
      }
    })
    const result = await Effect.runPromise(
      Effect.flatMap(Evaluator.Evaluator, (judge) =>
        judge.evaluate({
          state: "proof",
          questions: { complete: Evaluator.BooleanQuestion.of({ instructions: "Complete?" }) }
        })).pipe(
          Effect.provide(
            layerSeatEvaluator({
              SMITHERS_ACCOUNT_POOL_URL: "https://pool.example",
              SMITHERS_ACCOUNT_POOL_KEY: "host-credential",
              SMITHERS_ACCOUNT_POOL_PROVIDERS: "anthropic,chatgpt"
            }).pipe(Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor)))
          )
        )
    )
    expect(result.answers.complete).toEqual({ type: "boolean", probability: 0.95 })
    expect(sent.at(-1)).toBe(
      route === "chatgpt"
        ? "https://pool.example/chatgpt/codex/responses"
        : "https://pool.example/anthropic/v1/messages"
    )
    expect(sent.every((url) => url.startsWith("https://pool.example/"))).toBe(true)
  }
)

it("does not use ambient API keys for a native judgment", async () => {
  const executor = RequestExecutor.RequestExecutor.of({
    execute: () => Effect.die("must not call an API-key provider")
  })
  await expect(
    Effect.runPromise(
      Effect.flatMap(Evaluator.Evaluator, (judge) => judge.evaluate({ state: {}, questions: {} })).pipe(
        Effect.provide(
          layerSeatEvaluator({
            AI_GATEWAY_API_KEY: "unused",
            OPENAI_API_KEY: "unused",
            ANTHROPIC_API_KEY: "unused",
            CODEX_HOME: "/nonexistent"
          }).pipe(Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor)))
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
          : Response.json({ routes: sent.length === 1 ? ["chatgpt"] : [] })
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
            AI_GATEWAY_API_KEY: "must-not-use",
            OPENAI_API_KEY: "must-not-use"
          }).pipe(Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor)))
        ))
    )).rejects.toMatchObject({ code: "unreachable", message: Evaluator.unreachableMessage })
    expect(sent).toHaveLength(failure === "unavailable" ? 1 : 2)
  }
)
