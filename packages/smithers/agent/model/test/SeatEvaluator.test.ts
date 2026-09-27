import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Evaluator from "../src/Evaluator.ts"
import * as Model from "../src/Model.ts"
import { ModelError } from "../src/ModelError.ts"
import type { ModelRequest } from "../src/ModelRequest.ts"

const request: Evaluator.Request = {
  state: { evidence: "tests passed" },
  questions: {
    accepted: Evaluator.BooleanQuestion.of({ instructions: "Is the evidence sufficient?" }),
    activity: { type: "choice", instructions: "Activity?", criteria: { done: "finished", busy: "working" } },
    score: { type: "score", instructions: "Quality?", criteria: ["bad", "good"] }
  }
}
const answers = {
  accepted: { type: "boolean", probability: 0.9 },
  activity: { type: "choice", choice: "done" },
  score: { type: "score", score: 1 }
}
const run = (model: Model.Model, options: { timeoutMs?: number } = {}, input = request) =>
  Effect.runPromise(
    Effect.gen(function*() {
      return yield* (yield* Evaluator.Evaluator).evaluate(input)
    }).pipe(Effect.provide(Evaluator.layerFromSeat({ modelId: "gpt-6-astra", model }, options)))
  )
const reply = (value: unknown, stopReason: "stop" | "length" = "stop") =>
  Model.make({
    stream: () =>
      Stream.make(
        { type: "text-delta", id: "answer", text: typeof value === "string" ? value : JSON.stringify(value) },
        { type: "settle", stopReason }
      )
  })

describe("subscription seat evaluator", () => {
  it("asks the resolved model with evidence and typed questions", async () => {
    let sent: ModelRequest | undefined
    const model = reply({ answers })
    const result = await run(Model.make({
      stream: (req) => {
        sent = req
        return model.stream(req)
      }
    }))
    expect(result.answers).toEqual(answers)
    expect(sent?.modelId).toBe("gpt-6-astra")
    expect(sent?.tools).toEqual([])
    expect(JSON.stringify(sent)).toContain("tests passed")
  })
  it("fails closed without leaking provider errors", async () => {
    await expect(
      run(Model.make({ stream: () => Stream.fail(new ModelError({ code: "no_route", message: "secret-token" })) }))
    )
      .rejects.toMatchObject({ code: "unreachable", message: Evaluator.unreachableMessage })
  })
  it("rejects non-JSON evidence before contacting the seat", async () => {
    let called = false
    const state: Record<string, unknown> = {}
    state.self = state
    await expect(run(
      Model.make({
        stream: () => {
          called = true
          return Stream.empty
        }
      }),
      {},
      { ...request, state }
    )).rejects.toMatchObject({ code: "invalid_question" })
    expect(called).toBe(false)
  })
  it("preserves valid probabilities and token usage", async () => {
    const scored = {
      ...answers,
      activity: { ...answers.activity, probabilities: { done: 0.9, busy: 0.1 } },
      score: { ...answers.score, probabilities: { 0: 0.1, 1: 0.9 } }
    }
    const result = await run(Model.make({
      stream: () =>
        Stream.make(
          { type: "text-delta", id: "answer", text: JSON.stringify({ answers: scored }) },
          { type: "usage", inputTokens: 12, outputTokens: 7 },
          { type: "settle", stopReason: "stop" }
        )
    }))
    expect(result.answers).toEqual(scored)
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7 })
  })
  it.each([
    "not json",
    {},
    { answers: {} },
    { answers: { ...answers, accepted: { type: "boolean", probability: 2 } } },
    { answers: { ...answers, accepted: { type: "choice", choice: "done" } } },
    { answers: { ...answers, activity: { type: "choice", choice: "invented" } } },
    { answers: { ...answers, score: { type: "score", score: 2 } } },
    { answers: { ...answers, activity: { ...answers.activity, probabilities: { done: 2 } } } },
    { answers: { ...answers, score: { ...answers.score, probabilities: { 0: -0.1 } } } }
  ])("rejects invalid verdict %#", async (value) => {
    await expect(run(reply(value))).rejects.toMatchObject({ code: "invalid_answer" })
  })
  it("bounds a seat that never answers", async () => {
    await expect(run(Model.make({ stream: () => Stream.fromEffect(Effect.never) }), { timeoutMs: 5 }))
      .rejects.toMatchObject({ code: "timeout" })
  })
  it("rejects a truncated verdict even if its JSON parses", async () => {
    await expect(run(reply({ answers }, "length"))).rejects.toMatchObject({ code: "invalid_answer" })
  })
})
