/**
 * Tool-free review inference. No agent process, local tools, or repository configuration.
 * @since 1.0.0
 */

import { Model, ModelRequest, RequestExecutor, Route } from "@smthrs/model"
import { Effect, Layer, Redacted, Result, Stream } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import type { Engine } from "../ModelEngine.ts"

/** A provider refusal: recorded as refused, never as clean or a generic failure. */
class ReviewRefused extends Error {
  constructor() {
    super("Review provider refused the request")
  }
}

/**
 * Sends only the supplied review text to a fixed provider endpoint.
 * @category execution
 * @since 1.0.0
 */
export const reviewModel = (
  engine: Engine,
  modelId: string,
  prompt: string,
  timeoutMs: number,
  maximumBytes: number,
  policy?: string
): Effect.Effect<string, Error> =>
  Effect.suspend(() => {
    const name = engine === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"
    const key = process.env[name]
    if (key === undefined || key.trim() === "") return Effect.fail(new Error(`Review requires ${name}`))
    const route = engine === "claude"
      ? Result.map(Route.anthropic({ apiKey: Redacted.make(key) }), Route.layer)
      : Result.map(Route.openai({ apiKey: Redacted.make(key) }), Route.layer)
    if (Result.isFailure(route)) return Effect.fail(new Error("Review provider configuration is invalid"))
    const layer = route.success.pipe(
      Layer.provide(RequestExecutor.layer),
      Layer.provide(FetchHttpClient.layer)
    )
    const request = ModelRequest.ModelRequest.make({
      modelId,
      system: policy === undefined ? [] : [ModelRequest.SystemPart.make({ text: policy })],
      messages: [ModelRequest.Message.user(prompt)],
      tools: [],
      toolChoice: "none",
      params: ModelRequest.GenerationParams.make({ maxTokens: 16_384 })
    })
    return Effect.gen(function*() {
      const model = yield* Model.Model
      let text = ""
      let bytes = 0
      let settled = false
      yield* Stream.runForEach(model.stream(request), (event) =>
        Effect.try({
          try: () => {
            if (event.type.startsWith("tool-")) throw new Error("Review provider attempted a tool call")
            if (event.type === "text-delta") {
              bytes += Buffer.byteLength(event.text, "utf8")
              if (bytes > maximumBytes) throw new Error("Review response exceeds its output limit")
              text += event.text
            }
            if (event.type === "settle") {
              if (event.stopReason === "content-filter") throw new ReviewRefused()
              if (event.stopReason !== "stop") throw new Error("Review response did not complete")
              settled = true
            }
          },
          catch: (cause) => cause instanceof Error ? cause : new Error("Review response is invalid")
        }))
      if (!settled) return yield* Effect.fail(new Error("Review response did not complete"))
      return text
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error", credentials: "omit" }),
      Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(new Error("Review request timed out")) }),
      // Provider bodies and transport diagnostics can contain secrets. Do not return them.
      Effect.mapError((error) =>
        error instanceof ReviewRefused
          ? new ReviewRefused()
          : new Error("Review inference failed or returned an incomplete response")
      )
    )
  })
