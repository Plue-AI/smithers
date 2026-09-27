import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import * as Health from "../src/Health.ts"
import * as Jev from "../src/JevSessionChecker.ts"

const context = (outputTail: string | undefined = "Continue?", alive = true): Health.ProbeContext => ({
  subjectId: "session:one",
  state: "running",
  events: [],
  sinceCursor: 0,
  session: { alive, exitCode: null, outputCursor: 1, ...(outputTail === undefined ? {} : { outputTail }) }
})
const response = (choice = "needs-input", probability = 0.9): Evaluator.Response => ({
  answers: {
    activity: { type: "choice", choice, probabilities: { [choice]: probability } },
    question: { type: "boolean", probability }
  },
  latencyMs: 1
})
const checker = (evaluate: Evaluator.Evaluator["evaluate"]) => Jev.makeJevSessionChecker({ evaluator: { evaluate } })
const probe = (value: Health.HealthChecker, ctx = context()) => Effect.runPromise(value.probe(ctx, undefined))

describe("seat-backed session checker", () => {
  it("fails closed with no configured evaluator, regardless of ambient keys", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "unused")
    try {
      await expect(probe(Jev.jevSessionChecker)).rejects.toMatchObject({ reason: "unconfigured" })
    } finally {
      vi.unstubAllEnvs()
    }
  })
  it.each(["working", "idle", "needs-input"])("reports %s from the configured judge", async (choice) => {
    expect(await probe(checker(() => Effect.succeed(response(choice))))).toEqual({
      activity: choice,
      reason: choice === "needs-input" ? "prompt-detected" : "ok"
    })
  })
  it("keeps low confidence unknown", async () => {
    expect(await probe(checker(() => Effect.succeed(response("idle", 0.4))))).toEqual({
      activity: "unknown",
      reason: "ok"
    })
  })
  it("refuses an unoffered verdict", async () => {
    await expect(probe(checker(() => Effect.succeed(response("invented"))))).rejects.toMatchObject({
      reason: "malformed"
    })
  })
  it.each(["unreachable", "invalid_answer", "timeout", "refused"] as const)(
    "keeps %s as a probe error",
    async (code) => {
      const judge = checker(() => Effect.fail(new Evaluator.EvaluatorError({ code, message: "private details" })))
      const observation = await Effect.runPromise(
        Health.evaluate(
          { checker: judge, config: undefined, policy: Health.defaultPolicy, exposeOutput: true },
          context(),
          { monitorId: "host", incarnation: "one", evidenceSeq: 1 }
        )
      )
      expect(observation).toMatchObject({ outcome: "error", reason: "probe-error" })
      expect(observation.report).toBeUndefined()
    }
  )
  it("keeps the HTTP status of a refused judgment", async () => {
    const judge = checker(() =>
      Effect.fail(new Evaluator.EvaluatorError({ code: "refused", message: "private details", status: 429 }))
    )
    await expect(probe(judge)).rejects.toMatchObject({ reason: "http", status: 429 })
  })
  it("keeps a verdict with no stated confidence unknown", async () => {
    const unstated: Evaluator.Response = { answers: { activity: { type: "choice", choice: "idle" } }, latencyMs: 1 }
    expect(await probe(checker(() => Effect.succeed(unstated)))).toEqual({ activity: "unknown", reason: "ok" })
  })
  it("bounds a stalled subscription request", async () => {
    await expect(probe(Jev.makeJevSessionChecker({ evaluator: { evaluate: () => Effect.never }, timeoutMs: 5 })))
      .rejects.toMatchObject({ reason: "timeout" })
  })
  it("skips empty output and exited sessions", async () => {
    const evaluate = vi.fn((_request: Evaluator.Request) => Effect.succeed(response()))
    await probe(checker(evaluate), context(""))
    await probe(checker(evaluate), context("Done", false))
    expect(evaluate).not.toHaveBeenCalled()
  })
  it("clips evidence and asks both questions once", async () => {
    const evaluate = vi.fn((_request: Evaluator.Request) => Effect.succeed(response()))
    await probe(checker(evaluate), context("x".repeat(8000) + "Continue?"))
    expect(evaluate).toHaveBeenCalledOnce()
    const request = evaluate.mock.calls[0]![0] as Evaluator.Request
    expect((request.state as { outputTail: string }).outputTail).toHaveLength(Jev.jevStateTailCharacters)
    expect(Object.keys(request.questions)).toEqual(["activity", "question"])
  })
  it("binds the host evaluator through the existing registry", async () => {
    const registry = Health.makeRegistry({ bindings: { review: { checkerId: "jev.session" } } }, "session", {
      evaluate: () => Effect.succeed(response())
    })
    expect(await probe(registry.resolve("review").checker)).toMatchObject({ activity: "needs-input" })
    expect(registry.resolve("other").checker.id).toBe("lifecycle.session")
  })
})
