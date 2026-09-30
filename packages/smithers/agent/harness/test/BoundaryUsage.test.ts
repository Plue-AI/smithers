/**
 * What a recorded boundary says it paid a model for (#2681).
 *
 * A completion judge, a relevance reading and the supervisor each take an
 * evaluator reading inside a durable boundary. The reading is paid model work,
 * so each boundary names its usage off the value it recorded, and a budgeted
 * engine accounts it before the next paid call is admitted. Reading it off the
 * record, never the live call, is what makes a replayed frame report the same
 * spend without asking the judge again.
 */
import { ModelRequest } from "@smthrs/model"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as CellTurn from "../src/CellTurn.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import { paidUsage } from "../src/internal/paidUsage.ts"
import { emits, run } from "./fixtures/cellTurn.ts"

describe("paidUsage", () => {
  it("is absent when no reading was metered, not zero", () => {
    expect(paidUsage([])).toBeUndefined()
    expect(paidUsage([undefined, undefined])).toBeUndefined()
  })

  it("sums every metered reading and skips the unmetered ones", () => {
    expect(paidUsage([{ inputTokens: 90, outputTokens: 10 }])).toEqual({ inputTokens: 90, outputTokens: 10 })
    expect(paidUsage([undefined, { inputTokens: 90, outputTokens: 10 }, { inputTokens: 5, outputTokens: 1 }]))
      .toEqual({ inputTokens: 95, outputTokens: 11 })
  })
})

/** A judge that answers every claim with `invented` and reports usage on each reading. */
const metered = (invented: number, usage: Evaluator.Usage | undefined) => {
  const asked = { count: 0 }
  const layer = Layer.succeed(Evaluator.Evaluator)(Evaluator.Evaluator.of({
    evaluate: (request) =>
      Effect.sync(() => {
        asked.count++
        const answers = Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            { type: "boolean" as const, probability: id === "invented" ? invented : id === "complete" ? 0.99 : 0.01 }
          ])
        )
        return { answers, latencyMs: 0, ...(usage === undefined ? {} : { usage }) }
      })
  }))
  return { asked, layer }
}

/** A window that states a task, so the claim brake has something to judge the claim against. */
const window = ContextWindow.make({
  modelId: "test-model",
  segments: [
    { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "cell contract" })] },
    {
      kind: "instructions",
      zone: "prefix",
      content: [ModelRequest.SystemPart.make({ text: "The task for this run:\n\nSay whether the tests pass." })]
    },
    { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("Begin")] }
  ]
})

const state = (maxFrames: number) =>
  CellTurn.make({
    session: "session-1",
    seat: "anthropic:test-model",
    modelParams: ModelRequest.GenerationParams.make(),
    layers: ["layer-a"],
    capabilityEnvelope: [],
    placement: Option.none(),
    contextWindow: window,
    maxFrames,
    readOnlyCap: 0,
    approvalChannel: false
  })

const paidFor = (paid: ReadonlyArray<{ readonly name: string; readonly usage: unknown }>) =>
  paid.filter((entry) => entry.name === "completion-judgement").map((entry) => entry.usage)

describe("the completion judgement boundary", () => {
  it("names the judge's usage for a claim that stands, and the same usage on replay", async () => {
    const judge = metered(0.01, { inputTokens: 90, outputTokens: 10 })
    const records = new Map<string, unknown>()
    const script = [emits(`ctx.done("done")`)]
    const first = await run({ script, state: state(2), evaluator: judge.layer, records })
    expect(first.failure).toBeUndefined()
    expect(paidFor(first.engine.recorder.paid)).toEqual([{ inputTokens: 90, outputTokens: 10 }])
    expect(judge.asked.count).toBe(1)

    // The replay is served the recorded judgement, pays the judge nothing, and
    // still names the spend the original attempt paid.
    const replayed = await run({ script, state: state(2), evaluator: judge.layer, records })
    expect(paidFor(replayed.engine.recorder.paid)).toEqual([{ inputTokens: 90, outputTokens: 10 }])
    expect(judge.asked.count).toBe(1)
  })

  it("names the usage of a reading that handed the completion back, and of the reading after it", async () => {
    const judge = metered(0.95, { inputTokens: 90, outputTokens: 10 })
    const result = await run({
      script: [emits(`ctx.done("done")`), emits(`ctx.done("done")`)],
      state: state(3),
      evaluator: judge.layer
    })
    // The bounce carries the reading as its demand; the second reading stands
    // or ends the run, and either way it was paid for.
    expect(judge.asked.count).toBe(2)
    expect(paidFor(result.engine.recorder.paid)).toEqual([
      { inputTokens: 90, outputTokens: 10 },
      { inputTokens: 90, outputTokens: 10 }
    ])
  })

  it("names nothing for a judge that reported no usage", async () => {
    const judge = metered(0.01, undefined)
    const result = await run({ script: [emits(`ctx.done("done")`)], state: state(2), evaluator: judge.layer })
    expect(paidFor(result.engine.recorder.paid)).toEqual([undefined])
  })
})
