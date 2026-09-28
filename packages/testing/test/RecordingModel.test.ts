import { describe, expect, it } from "@effect/vitest"
import { Capability, Permission } from "@smthrs/kernel"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Cause, Effect, Exit, Fiber, Option, Ref, Stream } from "effect"
import type { RecordedCall } from "../src/Fixture.ts"
import * as RecordingModel from "../src/RecordingModel.ts"

const request = (text: string, modelId = "openai:gpt-5-mini"): ModelRequest.ModelRequest =>
  ModelRequest.ModelRequest.make({
    modelId,
    system: [ModelRequest.SystemPart.make({ text: "You are a concise reviewer." })],
    messages: [ModelRequest.Message.user(text)],
    tools: [],
    params: ModelRequest.GenerationParams.make({ temperature: 0 })
  })

const events: ReadonlyArray<ModelEvent.ModelEvent> = [
  { type: "text-start", id: "text_1" },
  { type: "text-delta", id: "text_1", text: "Small replay change." },
  { type: "text-end", id: "text_1" },
  { type: "settle", stopReason: "stop", responseId: "resp_1" }
]

const collector = Effect.gen(function*() {
  const recorded = yield* Ref.make<ReadonlyArray<RecordedCall>>([])
  return {
    sink: (call: RecordedCall) => Ref.update(recorded, (calls) => [...calls, call]),
    calls: () => Ref.get(recorded)
  }
})

const liveOf = (stream: Stream.Stream<ModelEvent.ModelEvent, Model.ModelFailure>): Model.Model =>
  Model.make({ stream: () => stream })

describe("RecordingModel", () => {
  it.effect("records the request, model, and events of a settled call", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const recorder = RecordingModel.make(liveOf(Stream.fromIterable(events)), sink.sink)
      const seen = yield* Stream.runCollect(recorder.stream(request("Summarize PR 4821.")))
      expect([...seen]).toEqual(events)
      const calls = yield* sink.calls()
      expect(calls).toHaveLength(1)
      expect(calls[0]!.model).toBe("openai:gpt-5-mini")
      expect(calls[0]!.events).toEqual(events)
      expect(calls[0]!.failure).toBeUndefined()
    }))

  it.effect("records the request as plain data, not the ModelRequest class", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const recorder = RecordingModel.make(liveOf(Stream.fromIterable(events)), sink.sink)
      yield* Stream.runDrain(recorder.stream(request("Summarize PR 4821.")))
      const [call] = yield* sink.calls()
      expect(call!.request).toEqual({
        modelId: "openai:gpt-5-mini",
        system: [{ type: "text", text: "You are a concise reviewer." }],
        messages: [{ role: "user", content: [{ type: "text", text: "Summarize PR 4821." }] }],
        tools: [],
        params: { temperature: 0 }
      })
      expect(Object.getPrototypeOf(call!.request)).toBe(Object.prototype)
    }))

  it.effect("records the tool-result and retry events the model contract carries", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const widened: ReadonlyArray<ModelEvent.ModelEvent> = [
        { type: "retry", attempt: 1, code: "transport", delayMillis: 250 },
        { type: "tool-result", id: "call_1", output: "0.42 ETH", isError: false },
        { type: "settle", stopReason: "tool-calls" }
      ]
      const recorder = RecordingModel.make(liveOf(Stream.fromIterable(widened)), sink.sink)
      yield* Stream.runDrain(recorder.stream(request("What is the balance?")))
      const [call] = yield* sink.calls()
      expect(call!.events).toEqual(widened)
    }))

  it.effect("records the events seen and the provider failure that ended them", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const failure = new ModelError({ code: "rate_limited", message: "429 too many requests", retryAfterMillis: 30 })
      const recorder = RecordingModel.make(
        liveOf(Stream.concat(Stream.fail(failure))(Stream.fromIterable(events.slice(0, 2)))),
        sink.sink
      )
      const error = yield* Stream.runDrain(recorder.stream(request("Summarize PR 4821."))).pipe(Effect.flip)
      expect(error).toBe(failure)
      const [call] = yield* sink.calls()
      expect(call!.events).toEqual(events.slice(0, 2))
      expect(call!.failure).toMatchObject({ code: "rate_limited", message: "429 too many requests" })
    }))

  it.effect("records nothing when the kernel refused the call", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const denied = Permission.permissionDenied(Capability.make("model:call", "openai:gpt-5-mini"), "no grant")
      const recorder = RecordingModel.make(liveOf(Stream.fail(denied)), sink.sink)
      const error = yield* Stream.runDrain(recorder.stream(request("Summarize PR 4821."))).pipe(Effect.flip)
      expect(error).toBe(denied)
      expect(yield* sink.calls()).toEqual([])
    }))

  it.effect("records nothing when the call is interrupted before it settles", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const unsettled = Stream.concat(Stream.fromEffect(Effect.never))(Stream.fromIterable(events.slice(0, 1)))
      const recorder = RecordingModel.make(liveOf(unsettled), sink.sink)
      const fiber = yield* Stream.runDrain(recorder.stream(request("Summarize PR 4821."))).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      expect(yield* sink.calls()).toEqual([])
    }))

  it.effect("records nothing when the consumer stops before the stream ends", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const recorder = RecordingModel.make(liveOf(Stream.fromIterable(events)), sink.sink)
      const head = yield* Stream.runHead(recorder.stream(request("Summarize PR 4821.")))
      expect(head).toEqual(Option.some(events[0]))
      expect(yield* sink.calls()).toEqual([])
    }))

  it.effect("records nothing when the consumer takes only a prefix of the events", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const recorder = RecordingModel.make(liveOf(Stream.fromIterable(events)), sink.sink)
      const seen = yield* Stream.runCollect(Stream.take(recorder.stream(request("Summarize PR 4821.")), 2))
      expect([...seen]).toEqual(events.slice(0, 2))
      expect(yield* sink.calls()).toEqual([])
    }))

  it.effect("records one call per stream, so a re-run appends a second", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const recorder = RecordingModel.make(liveOf(Stream.fromIterable(events)), sink.sink)
      yield* Stream.runDrain(recorder.stream(request("Summarize PR 4821.")))
      yield* Stream.runDrain(recorder.stream(request("Classify PR 4821.")))
      expect(yield* sink.calls()).toHaveLength(2)
    }))

  it.effect("provides the recording model as the Model seam", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const layer = RecordingModel.layer(liveOf(Stream.fromIterable(events)), sink.sink)
      yield* Effect.gen(function*() {
        const model = yield* Model.Model
        yield* Stream.runDrain(model.stream(request("Summarize PR 4821.")))
      }).pipe(Effect.provide(layer))
      expect(yield* sink.calls()).toHaveLength(1)
    }))

  // Assembled at runtime so no credential-shaped literal sits in the source.
  const secrets: ReadonlyArray<readonly [string, string]> = [
    ["api-key", ["sk", "ant", "api03", "Q1w2E3r4T5y6U7i8"].join("-")],
    ["github-token", `gh${"p"}_${"A1b2C3d4".repeat(5)}`],
    ["aws-access-key", `AK${"IA"}${"ABCDEFGH23456789"}`]
  ]
  for (const [rule, secret] of secrets) {
    it.effect(`refuses to record a call carrying a ${rule}`, () =>
      Effect.gen(function*() {
        const sink = yield* collector
        const leaking: ReadonlyArray<ModelEvent.ModelEvent> = [
          { type: "text-start", id: "text_1" },
          { type: "text-delta", id: "text_1", text: `the env holds ${secret}` },
          { type: "text-end", id: "text_1" },
          { type: "settle", stopReason: "stop", responseId: "resp_1" }
        ]
        // Providers stream a long token a few characters at a time, so the key
        // is never contiguous in the serialized call. Split into three deltas
        // interleaved with another stream, for text, thinking and tool-call
        // arguments.
        const [a, b, c] = [secret.slice(0, 4), secret.slice(4, 9), secret.slice(9)]
        const chunked: ReadonlyArray<ModelEvent.ModelEvent> = [
          { type: "text-start", id: "text_1" },
          { type: "text-start", id: "text_2" },
          { type: "text-delta", id: "text_1", text: `the env holds ${a}` },
          { type: "text-delta", id: "text_2", text: "unrelated" },
          { type: "text-delta", id: "text_1", text: b },
          { type: "text-delta", id: "text_1", text: c },
          { type: "text-end", id: "text_2" },
          { type: "text-end", id: "text_1" },
          { type: "settle", stopReason: "stop", responseId: "resp_1" }
        ]
        const chunkedThinking: ReadonlyArray<ModelEvent.ModelEvent> = [
          { type: "thinking-start", id: "think_1" },
          { type: "thinking-delta", id: "think_1", text: a },
          { type: "thinking-delta", id: "think_1", text: b },
          { type: "thinking-delta", id: "think_1", text: c },
          { type: "thinking-end", id: "think_1" },
          { type: "settle", stopReason: "stop", responseId: "resp_1" }
        ]
        const chunkedToolCall: ReadonlyArray<ModelEvent.ModelEvent> = [
          { type: "tool-call-start", id: "call_1", name: "bash" },
          { type: "tool-call-delta", id: "call_1", arguments: `{"cmd":"export KEY=${a}` },
          { type: "tool-call-delta", id: "call_1", arguments: b },
          { type: "tool-call-delta", id: "call_1", arguments: `${c}"}` },
          { type: "tool-call-end", id: "call_1" },
          { type: "settle", stopReason: "tool-calls", responseId: "resp_1" }
        ]
        for (
          const recorder of [
            RecordingModel.make(liveOf(Stream.fromIterable(events)), sink.sink).stream(request(`key ${secret}`)),
            RecordingModel.make(liveOf(Stream.fromIterable(leaking)), sink.sink).stream(request("Summarize.")),
            RecordingModel.make(liveOf(Stream.fromIterable(chunked)), sink.sink).stream(request("Summarize.")),
            RecordingModel.make(liveOf(Stream.fromIterable(chunkedThinking)), sink.sink).stream(request("Think.")),
            RecordingModel.make(liveOf(Stream.fromIterable(chunkedToolCall)), sink.sink).stream(request("Run."))
          ]
        ) {
          const exit = yield* Effect.exit(Stream.runDrain(recorder))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const message = String(Cause.squash(exit.cause))
            expect(message).toContain(`credential (${rule})`)
            expect(message).not.toContain(secret)
          }
        }
        expect(yield* sink.calls()).toEqual([])
      }))
  }

  it.effect("records ordinary token vocabulary that is not a credential", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const recorder = RecordingModel.make(liveOf(Stream.fromIterable(events)), sink.sink)
      yield* Stream.runDrain(recorder.stream(request("Set maxTokens and the token field; see sk-learn docs.")))
      expect(yield* sink.calls()).toHaveLength(1)
    }))
})
