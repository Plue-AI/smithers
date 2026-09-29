import { Effect, Schema, Stream, Tracer } from "effect"
import { describe, expect, it } from "vitest"
import * as Model from "../src/Model.ts"
import { ModelError } from "../src/ModelError.ts"

describe("ModelError", () => {
  it("round-trips all stable codes and classifies retryability", () => {
    const retryable = new Set(["rate_limited", "provider_internal", "transport"])
    const codes = [
      "invalid_request",
      "no_route",
      "authentication",
      "rate_limited",
      "quota_exceeded",
      "content_policy",
      "provider_internal",
      "transport",
      "invalid_provider_output",
      "unknown"
    ] as const
    for (const code of codes) {
      const error = new ModelError({
        code,
        message: code,
        retryAfterMillis: 10,
        resetAtEpochMillis: 123456789,
        resetSource: "header",
        providerCode: "code",
        requestId: "request",
        ...(code === "unknown" ? { httpStatus: 503 } : {})
      })
      expect(Schema.decodeUnknownSync(ModelError)(Schema.encodeSync(ModelError)(error))).toEqual(error)
      expect(error.retryable).toBe(retryable.has(code) || code === "unknown")
      expect(error.resetAtEpochMillis).toBe(123456789)
    }
    expect(new ModelError({ code: "quota_exceeded", message: "quota", httpStatus: 503 }).retryable).toBe(false)
  })
})

const request = {
  modelId: "model",
  system: [],
  messages: [],
  tools: [],
  params: {}
}

describe("Model", () => {
  it("resolves its noop layer through Effect.provide", async () => {
    const program = Effect.gen(function*() {
      return yield* Model.Model
    }).pipe(Effect.provide(Model.layerNoop()))
    const service = await Effect.runPromise(program)
    const exit = await Effect.runPromiseExit(Stream.runDrain(service.stream(request)))
    expect(exit._tag).toBe("Failure")
  })

  it("reports the missing route as a typed no_route failure", async () => {
    const error = await Effect.runPromise(
      Stream.runDrain(Model.makeNoop().stream(request)).pipe(Effect.flip)
    )

    expect(error).toBeInstanceOf(ModelError)
    expect(error).toMatchObject({ code: "no_route", message: "no model route in this environment" })
  })

  it("lets an override replace the noop stream", async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(
        Model.makeNoop({ stream: () => Stream.make({ type: "text-start" as const, id: "overridden" }) }).stream(request)
      )
    )

    expect(Array.from(events)).toEqual([{ type: "text-start", id: "overridden" }])
  })

  it("provides an implementation through its layer", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function*() {
        const model = yield* Model.Model
        return yield* Stream.runCollect(model.stream(request))
      }).pipe(
        Effect.provide(
          Model.layer({
            stream: (input) => Stream.make({ type: "text-delta" as const, id: "layer", text: input.modelId })
          })
        )
      )
    )

    expect(Array.from(events)).toEqual([{ type: "text-delta", id: "layer", text: "model" }])
  })

  it("keeps the noop layer's overrides addressable through the tag", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        const model = yield* Model.Model
        return yield* Stream.runCollect(model.stream(request))
      }).pipe(
        Effect.provide(Model.layerNoop({ stream: () => Stream.empty }))
      )
    )

    expect(exit._tag).toBe("Success")
  })
})

describe("Model.withGenAiSpan", () => {
  const collect = () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    return { spans, tracer }
  }

  it("records GenAI attributes from usage and settlement without content", async () => {
    const { spans, tracer } = collect()
    const events = [
      { type: "text-delta", id: "t", text: "secret answer" },
      { type: "usage", inputTokens: 12 },
      { type: "usage", outputTokens: 7 },
      { type: "settle", stopReason: "stop", responseId: "resp-1" }
    ] as const
    const out = await Effect.runPromise(
      Stream.runCollect(Stream.fromIterable(events).pipe(Model.withGenAiSpan(request))).pipe(
        Effect.provideService(Tracer.Tracer, tracer)
      )
    )
    expect(Array.from(out)).toEqual(events)
    expect(spans.map((span) => span.name)).toEqual(["chat model"])
    const span = spans[0]!
    expect(span.kind).toBe("client")
    expect(Object.fromEntries(span.attributes)).toEqual({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "model",
      "gen_ai.usage.input_tokens": 12,
      "gen_ai.usage.output_tokens": 7,
      "gen_ai.response.finish_reasons": ["stop"],
      "gen_ai.response.id": "resp-1"
    })
    expect(span.status._tag).toBe("Ended")
  })

  it("omits the response id a provider did not report", async () => {
    const { spans, tracer } = collect()
    await Effect.runPromise(
      Stream.runDrain(Stream.make({ type: "settle", stopReason: "length" } as const).pipe(Model.withGenAiSpan(request)))
        .pipe(Effect.provideService(Tracer.Tracer, tracer))
    )
    expect(spans[0]!.attributes.get("gen_ai.response.finish_reasons")).toEqual(["length"])
    expect(spans[0]!.attributes.has("gen_ai.response.id")).toBe(false)
  })

  it("ends the span with the failure and no finish reason when the stream fails", async () => {
    const { spans, tracer } = collect()
    const exit = await Effect.runPromiseExit(
      Stream.runDrain(Model.makeNoop().stream(request).pipe(Model.withGenAiSpan(request))).pipe(
        Effect.provideService(Tracer.Tracer, tracer)
      )
    )
    expect(exit._tag).toBe("Failure")
    const span = spans[0]!
    expect(span.status._tag === "Ended" && span.status.exit._tag).toBe("Failure")
    expect(span.attributes.has("gen_ai.response.finish_reasons")).toBe(false)
    expect(span.attributes.has("gen_ai.usage.input_tokens")).toBe(false)
  })
})
