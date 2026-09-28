import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Schema } from "effect"
import * as Monitors from "../src/monitors.ts"
import type { Record as SessionRecord } from "../src/session.ts"

const input = { watch: "the build fails", before: "green", after: "red" }
const booleanResponse = (probability: number): Evaluator.Response => ({
  latencyMs: 0,
  answers: { notable: Schema.decodeUnknownSync(Evaluator.RawBooleanAnswer)({ type: "boolean", probability }) }
})

test.each([[0, false], [0.49999999999999994, false], [0.5, true], [0.5000000000000001, true], [1, true]] as const)(
  "notability probability %s yields %s at the canonical half boundary",
  async (probability, expected) => {
    const requests: Evaluator.Request[] = []
    const judge = Monitors.jev(async (request) => {
      requests.push(request)
      return booleanResponse(probability)
    })
    expect(await judge(input)).toBe(expected)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.state).toEqual({ watching: "the build fails", before: "green", after: "red" })
    expect(Object.keys(requests[0]!.questions)).toEqual(["notable"])
    expect(requests[0]?.questions.notable?.type).toBe("boolean")
  }
)

const wrongAnswers: ReadonlyArray<{ name: string; answers: Evaluator.RawAnswers }> = [
  { name: "missing", answers: {} },
  { name: "another question", answers: { other: { type: "boolean", probability: 1 } } },
  { name: "choice", answers: { notable: { type: "choice", choice: "yes" } } },
  { name: "score", answers: { notable: { type: "score", score: 1 } } }
]
test.each(wrongAnswers)("a %s answer refuses once and the next valid response recovers", async ({ answers }) => {
  let calls = 0
  const judge = Monitors.jev(async () => ({
    latencyMs: 0,
    answers: ++calls === 1 ? answers : booleanResponse(0.5).answers
  }))
  const failure: unknown = await judge(input).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Monitors.MonitorError)
  if (!(failure instanceof Monitors.MonitorError)) throw new Error("Expected a typed monitor failure")
  expect(failure.failure).toEqual({
    _tag: "JevFailed",
    code: "invalid_answer",
    message: "Jev did not answer the notable question"
  })
  expect(calls).toBe(1)
  expect(await judge(input)).toBe(true)
  expect(calls).toBe(2)
})

test.each(
  [
    ["unreachable", "Jev was unavailable: the judge this host binds did not answer."],
    ["refused", "Request refused"],
    ["empty", "Request refused"],
    ["timeout", "Request refused"],
    ["invalid_answer", "Request refused"],
    ["invalid_question", "Request refused"]
  ] as const
)("typed evaluator %s preserves its public classification", async (code, message) => {
  let calls = 0
  const judge = Monitors.jev(async () => {
    calls++
    throw new Evaluator.EvaluatorError({
      code,
      message: code === "unreachable" ? "http://private-host.example?credential=synthetic" : "Request refused"
    })
  })
  const failure: unknown = await judge(input).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Monitors.MonitorError)
  if (!(failure instanceof Monitors.MonitorError)) throw new Error("Expected a typed monitor failure")
  expect(failure.failure).toEqual({ _tag: "JevFailed", code, message })
  expect(failure.message).not.toContain("private-host")
  expect(calls).toBe(1)
})

test.each([new Error("Adapter failed"), "Adapter failed"])(
  "untyped evaluator failures become an unreachable monitor failure",
  async (error) => {
    let calls = 0
    const judge = Monitors.jev(async () => {
      calls++
      throw error
    })
    const failure: unknown = await judge(input).catch((reason: unknown) => reason)
    expect(failure).toBeInstanceOf(Monitors.MonitorError)
    if (!(failure instanceof Monitors.MonitorError)) throw new Error("Expected a typed monitor failure")
    expect(failure.failure).toEqual({ _tag: "JevFailed", code: "unreachable", message: "Adapter failed" })
    expect(calls).toBe(1)
  }
)

test.each([-1, 2, NaN, Infinity, -Infinity])(
  "raw probability %s must refuse under the canonical boolean contract",
  async (probability) => {
    const response = booleanResponse(probability)
    // The transport admits a raw Number; the shared classifier owns probability-domain admission.
    expect(Schema.is(Evaluator.RawAnswers)(response.answers)).toBe(true)
    const canonical = await Effect.runPromiseExit(
      Classifier.decodeAnswers({ notable: Classifier.boolean({ instructions: "Is this notable?" }) }, response.answers)
    )
    expect(Exit.isFailure(canonical)).toBe(true)
    if (!Exit.isFailure(canonical)) throw new Error("Canonical classifier must refuse an invalid probability")
    const canonicalError = Cause.squash(canonical.cause)
    expect(canonicalError).toBeInstanceOf(Classifier.ClassifierError)
    if (!(canonicalError instanceof Classifier.ClassifierError)) throw new Error("Expected a classifier refusal")
    expect(canonicalError.code).toBe("invalid_answer")
    expect(canonicalError.message).toBe(`Answer to "notable": probability is ${probability}`)
    let calls = 0
    const judge = Monitors.jev(async () => {
      calls++
      return response
    })
    const result: unknown = await judge(input).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(Monitors.MonitorError)
    if (!(result instanceof Monitors.MonitorError)) {
      throw new Error(
        "Invalid probability must not become a notability verdict"
      )
    }
    expect(result.failure).toMatchObject({ _tag: "JevFailed", code: "invalid_answer" })
    expect(calls).toBe(1)
  }
)

test.each([-1, 2])(
  "wire-representable invalid probability %s cannot compose or publish a successful update",
  async (probability) => {
    const response = booleanResponse(probability)
    const deliveries: Monitors.Delivery[] = []
    const records: SessionRecord[] = []
    let observed = 0
    let composed = 0
    const monitors = new Monitors.Monitors({
      judged: true,
      observe: async () => ++observed === 1 ? "green" : "red",
      judge: Monitors.jev(async () => response),
      compose: async () => {
        composed++
        return "Wrongly published"
      },
      persist: (record) => records.push(record),
      deliver: (delivery) => deliveries.push(delivery),
      subscribe: () => () => {}
    })
    try {
      monitors.create({ id: "build", title: "Build", watch: "the build fails", source: { kind: "tab", id: "worker" } })
      await monitors.tick("build")
      await monitors.tick("build")
      expect(monitors.list()).toEqual([{
        id: "build",
        title: "Build",
        watch: "the build fails",
        source: { kind: "tab", id: "worker" },
        trigger: { kind: "events" },
        status: "failed",
        updates: 0,
        createdAt: expect.any(Number),
        endedAt: expect.any(Number),
        failure: { _tag: "JevFailed", code: "invalid_answer", message: expect.any(String) }
      }])
      expect(composed).toBe(0)
      expect(deliveries).toEqual([{
        _tag: "failed",
        id: "build",
        title: "Build",
        at: expect.any(Number),
        failure: { _tag: "JevFailed", code: "invalid_answer", message: expect.any(String) }
      }])
      expect(records.filter((record) => record.type === "monitor-update")).toEqual([{
        type: "monitor-update",
        id: "build",
        title: "Build",
        at: expect.any(Number),
        failed: true,
        text: expect.stringContaining("Jev failed (invalid_answer)")
      }])
    } finally {
      await monitors.dispose()
    }
  }
)
