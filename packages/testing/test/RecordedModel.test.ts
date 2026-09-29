import { describe, expect, it } from "@effect/vitest"
import * as ProductionModelRequest from "@smthrs/model/ModelRequest"
import { Cause, Effect, type Exit, Fiber, Option, Result, Stream } from "effect"
import { decode, type Fixture } from "../src/Fixture.ts"
import { modelErrorTag, ModelLike, type ModelRequestLike } from "../src/ModelLike.ts"
import { layer, make, RecordedModel, scripted } from "../src/RecordedModel.ts"
import { ReplayHarnessMismatchError, UnscriptedModelError } from "../src/TestingError.ts"
import journal from "./fixtures/small-run/journal.json" with { type: "json" }

const defectOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  exit._tag === "Failure" ? Option.getOrUndefined(Result.getSuccess(Cause.findDefect(exit.cause))) : undefined

const request = (text: string, modelId = "openai:gpt-5-mini"): ModelRequestLike => ({
  modelId,
  system: [{ type: "text", text: "You are a concise reviewer." }],
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  tools: [],
  params: {}
})

const fixture: Fixture = {
  calls: [
    {
      request: request("Summarize PR 4821."),
      model: "openai:gpt-5-mini",
      events: [
        { type: "text-start", id: "text_1" },
        { type: "text-delta", id: "text_1", text: "Small replay change." },
        { type: "text-end", id: "text_1" },
        { type: "settle", stopReason: "stop", responseId: "resp_1" }
      ]
    },
    {
      request: request("Classify PR 4821."),
      model: "openai:gpt-5-mini",
      events: [{ type: "settle", stopReason: "stop", responseId: "resp_2" }]
    }
  ]
}

describe("RecordedModel", () => {
  it.effect("replays recorded events in order", () =>
    Effect.gen(function*() {
      const replay = yield* make(fixture)
      const events = yield* Stream.runCollect(replay.model.stream(fixture.calls[0]!.request))
      expect([...events]).toEqual(fixture.calls[0]!.events)
    }))

  it.effect("accepts the production ModelRequest class shape", () =>
    Effect.gen(function*() {
      const replay = yield* make(fixture)
      const productionRequest = ProductionModelRequest.ModelRequest.make({
        modelId: "openai:gpt-5-mini",
        system: [ProductionModelRequest.SystemPart.make({ text: "You are a concise reviewer." })],
        messages: [ProductionModelRequest.Message.user("Summarize PR 4821.")],
        tools: [],
        params: ProductionModelRequest.GenerationParams.make()
      })
      const events = yield* Stream.runCollect(replay.model.stream(productionRequest))
      expect([...events]).toEqual(fixture.calls[0]!.events)
    }))

  it.effect("dies for an unscripted request", () =>
    Effect.gen(function*() {
      const replay = yield* make(fixture)
      const attempted = {
        ...request("An unrecorded prompt."),
        tools: [{ name: "search", description: "Search", parameters: { type: "object" } }]
      } satisfies ModelRequestLike
      const exit = yield* Stream.runCollect(replay.model.stream(attempted)).pipe(Effect.exit)
      const defect = defectOf(exit)
      expect(defect).toBeInstanceOf(UnscriptedModelError)
      expect(defect).toMatchObject({
        code: "unscripted_model",
        modelId: "openai:gpt-5-mini",
        messageCount: 1,
        toolNames: ["search"]
      })
    }))

  it.effect("cannot claim one recorded call twice", () =>
    Effect.gen(function*() {
      const replay = yield* make({ calls: [fixture.calls[0]!] })
      yield* Stream.runDrain(replay.model.stream(fixture.calls[0]!.request))
      const exit = yield* Stream.runDrain(replay.model.stream(fixture.calls[0]!.request)).pipe(Effect.exit)
      expect(defectOf(exit)).toMatchObject({
        code: "unscripted_model",
        modelId: "openai:gpt-5-mini",
        messageCount: 1,
        toolNames: []
      })
      expect(yield* replay.controller.unconsumed()).toEqual([])
    }))

  it.effect("enforces strict fixture order before claiming a call", () =>
    Effect.gen(function*() {
      const replay = yield* make(fixture, { strictRequestOrder: true })
      const outOfOrder = yield* Stream.runDrain(replay.model.stream(fixture.calls[1]!.request)).pipe(Effect.exit)
      expect(defectOf(outOfOrder)).toMatchObject({
        code: "unscripted_model",
        modelId: "openai:gpt-5-mini"
      })
      expect(yield* replay.controller.unconsumed()).toEqual(fixture.calls)
    }))

  it.effect("provides the model and replay controller through its layer", () =>
    Effect.gen(function*() {
      const services = yield* Effect.all([ModelLike, RecordedModel]).pipe(Effect.provide(layer(fixture)))
      yield* Stream.runDrain(services[0].stream(fixture.calls[0]!.request))
      expect(yield* services[1].unconsumed()).toEqual([fixture.calls[1]])
    }))

  it.effect("dies when the fixture model identity differs", () =>
    Effect.gen(function*() {
      const mismatch: Fixture = {
        calls: [{ ...fixture.calls[0]!, model: "anthropic:claude-sonnet-4" }]
      }
      const replay = yield* make(mismatch)
      const exit = yield* Stream.runCollect(replay.model.stream(mismatch.calls[0]!.request)).pipe(Effect.exit)
      expect(defectOf(exit)).toBeInstanceOf(ReplayHarnessMismatchError)
    }))

  it.effect("replays the recorded events before the recorded failure", () =>
    Effect.gen(function*() {
      const failing: Fixture = {
        calls: [{ ...fixture.calls[0]!, failure: { code: "context_overflow", message: "prompt is too long" } }]
      }
      const replay = yield* make(failing)
      const seen: Array<unknown> = []
      const error = yield* replay.model.stream(failing.calls[0]!.request).pipe(
        Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
        Effect.flip
      )
      expect(seen).toEqual(failing.calls[0]!.events)
      expect(error).toEqual({ _tag: modelErrorTag, code: "context_overflow", message: "prompt is too long" })
    }))

  it.effect("replays a recorded refusal as a tagged model error", () =>
    Effect.gen(function*() {
      // A fixture stores a refusal's fields, not its tag. A consumer that
      // classifies one matches on the tag — the agent parks a run on a quota
      // refusal that way — so a replay that failed with a bare structural
      // object would not reproduce the recording it came from.
      const refusing: Fixture = {
        calls: [{
          ...fixture.calls[0]!,
          events: [],
          failure: {
            code: "rate_limited",
            message: "Too many requests",
            retryAfterMillis: 3_000,
            httpStatus: 429,
            quotaScope: "model"
          }
        }]
      }
      const replay = yield* make(refusing)
      const error = yield* Stream.runCollect(replay.model.stream(refusing.calls[0]!.request)).pipe(Effect.flip)

      expect(error).toEqual({
        _tag: modelErrorTag,
        code: "rate_limited",
        message: "Too many requests",
        retryAfterMillis: 3_000,
        httpStatus: 429,
        quotaScope: "model"
      })
    }))

  it.effect("reports untouched fixture calls", () =>
    Effect.gen(function*() {
      const replay = yield* scripted(...fixture.calls)
      yield* Stream.runDrain(replay.model.stream(fixture.calls[0]!.request))
      expect(yield* replay.controller.unconsumed()).toEqual([fixture.calls[1]])
    }))

  it.effect("settles cleanly when a partially consumed replay is interrupted", () =>
    Effect.gen(function*() {
      const replay = yield* make(fixture)
      const fiber = yield* replay.model.stream(fixture.calls[0]!.request).pipe(
        Stream.runForEach(() => Effect.never),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      expect(yield* replay.controller.unconsumed()).toEqual([fixture.calls[1]])
    }))

  it.effect("decodes the small checked-in JSON fixture shape", () =>
    Effect.gen(function*() {
      const decoded = yield* decode(journal)
      expect(decoded.calls).toHaveLength(2)
      expect(decoded.calls[0]!.events[1]).toEqual({
        type: "text-delta",
        id: "text_1",
        text: "PR 4821 updates the replay harness."
      })
    }))
})
