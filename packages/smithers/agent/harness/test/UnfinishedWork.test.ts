/**
 * A completion that reports its own work unfinished is not a completed run
 * (#3009).
 *
 * Driven through `Frame.judgeCompletion`, where the claim brake reaches its
 * verdict: the question is asked only of a completion read as not done with
 * no bounce left and nothing to refuse, and one that says its work is
 * unfinished ends the run as `completion_incomplete` quoting its own report.
 */
import { ModelRequest } from "@smthrs/model"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as CellTurn from "../src/CellTurn.ts"
import * as CompletionClaim from "../src/CompletionClaim.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as EngineLike from "../src/EngineLike.ts"
import * as FailedCall from "../src/FailedCall.ts"
import type { HarnessError } from "../src/HarnessError.ts"
import * as Frame from "../src/internal/frame.ts"
import * as UnfinishedWork from "../src/internal/unfinishedWork.ts"

const task = "Migrate the orders table to the new schema."
const report = "I could not finish the migration: it needs database credentials this run does not have."

const window = ContextWindow.make({
  modelId: "test-model",
  segments: [
    {
      kind: "instructions",
      zone: "prefix",
      content: [ModelRequest.SystemPart.make({ text: `The task for this run:\n\n${task}` })]
    }
  ]
})

const base = CellTurn.make({
  session: "session-1",
  seat: "anthropic:test-model",
  modelParams: ModelRequest.GenerationParams.make(),
  layers: [],
  capabilityEnvelope: [],
  placement: Option.none(),
  contextWindow: window,
  maxFrames: 10
})

const tree = (digest: string) => Option.some(new EngineLike.Observation({ digest, paths: 3, complete: true }))

/** The claim brake's cap is spent unless a case says otherwise. */
const spent: Frame.StateChanges = { claimCap: 1, claimDemands: 1 }

const judge = (layer: Layer.Layer<Evaluator.Evaluator>, changes: Frame.StateChanges = spent, claim = report) => {
  const state = new CellTurn.State({ ...base, openingDigest: "t0", failedCallDemands: FailedCall.cap, ...changes })
  return Frame.judgeCompletion(
    state,
    Frame.account({
      state,
      calls: [],
      opened: tree("t0"),
      closed: tree("t1"),
      minted: [],
      bindings: [],
      captures: []
    }),
    state.contextWindow,
    claim
  ).pipe(Effect.provide(layer))
}

const settled = (layer: Layer.Layer<Evaluator.Evaluator>, changes?: Frame.StateChanges, claim?: string) =>
  Effect.runPromise(judge(layer, changes, claim))

const failed = async (layer: Layer.Layer<Evaluator.Evaluator>): Promise<HarnessError> => {
  const outcome = await Effect.runPromise(Effect.result(judge(layer)))
  if (outcome._tag !== "Failure") throw new Error("the judgement settled")
  return outcome.failure
}

type Usage = { readonly inputTokens: number; readonly outputTokens: number } | undefined

/**
 * A Jev answering the claim question with `claim` and the unfinished question
 * with `unfinished`, recording the question ids of every request.
 */
const jev = (
  claim: { readonly complete?: number; readonly overclaims?: number; readonly invented?: number },
  unfinished: number | Evaluator.EvaluatorError,
  usage: { readonly claim?: Usage; readonly unfinished?: Usage } = {}
) => {
  const asked: Array<ReadonlyArray<string>> = []
  const layer = Layer.succeed(Evaluator.Evaluator)(Evaluator.Evaluator.of({
    evaluate: (request) => {
      asked.push(Object.keys(request.questions))
      if ("unfinished" in request.questions) {
        return typeof unfinished === "number"
          ? Effect.succeed({
            answers: { unfinished: { type: "boolean", probability: unfinished } },
            latencyMs: 4,
            ...(usage.unfinished === undefined ? {} : { usage: usage.unfinished })
          })
          : Effect.fail(unfinished)
      }
      return Effect.succeed({
        answers: {
          complete: { type: "boolean", probability: claim.complete ?? 0.9 },
          overclaims: { type: "boolean", probability: claim.overclaims ?? 0.1 },
          invented: { type: "boolean", probability: claim.invented ?? 0.05 }
        },
        latencyMs: 6,
        ...(usage.claim === undefined ? {} : { usage: usage.claim })
      })
    }
  }))
  return { asked, layer }
}

describe("a completion that reports its own work unfinished", () => {
  it("ends the run as completion_incomplete, keeping the report, once no bounce is left", async () => {
    const judge = jev({ complete: 0.04 }, 0.97)
    const judged = await settled(judge.layer)

    expect(judge.asked).toEqual([["complete", "overclaims", "invented"], ["unfinished"]])
    expect(judged.demand).toBeUndefined()
    expect(judged.unproven).toMatchObject({ _tag: "/harness/HarnessError", code: "completion_incomplete" })
    expect(judged.unproven?.message).toContain("unfinished 0.97 (complete 0.04)")
    expect(judged.unproven?.message).toContain(report)
    // The reading that ended the run is on the record, and says it neither
    // stood as a success nor refused an invented claim.
    expect(judged.observed).toMatchObject({ _tag: "claim-demanded", demanded: false, refused: false })
    expect(judged.decision).toMatchObject({ classifier: "completion/claim", acted: true })
    expect(judged.unfinishedDecision).toMatchObject({
      _tag: "decision-settled",
      classifier: UnfinishedWork.classifier.id,
      digest: UnfinishedWork.classifier.digest,
      acted: true,
      decidedBy: "jev",
      frame: 0
    })
  })

  it("ends the run at the last frame too, where nothing could be handed back", async () => {
    const judged = await settled(jev({ complete: 0.1 }, 0.95).layer, { frame: 9 })

    expect(judged.demand).toBeUndefined()
    expect(judged.unproven?.code).toBe("completion_incomplete")
  })

  it("fails at the threshold and lets a completion below it stand, journaling the reading either way", async () => {
    const at = await settled(jev({ complete: 0.2 }, UnfinishedWork.reportedAt).layer)
    const below = await settled(jev({ complete: 0.2 }, 0.89).layer)

    expect(UnfinishedWork.reportedAt).toBe(0.9)
    expect(at.unproven?.code).toBe("completion_incomplete")
    expect(below.unproven).toBeUndefined()
    expect(below.demand).toBeUndefined()
    expect(below.decision?.acted).toBe(false)
    expect(below.unfinishedDecision?.acted).toBe(false)
  })

  it("asks nothing more of a completion read as done, handed back, refused, or not read", async () => {
    const done = jev({ complete: 0.95 }, 0.97)
    const doneJudged = await settled(done.layer)
    // At the bounce height and above it: only a completion read as not done is asked.
    const atHeight = jev({ complete: CompletionClaim.disprovenAt + 0.01, overclaims: 0.9 }, 0.97)
    const heightJudged = await settled(atHeight.layer)
    const bounced = jev({ complete: 0.04 }, 0.97)
    const bouncedJudged = await settled(bounced.layer, {})
    const invented = jev({ complete: 0.04, invented: 0.95 }, 0.97)
    const inventedJudged = await settled(invented.layer)
    const disarmed = jev({ complete: 0.04 }, 0.97)
    const disarmedJudged = await settled(disarmed.layer, { claimCap: 0 })

    for (const asked of [done.asked, atHeight.asked, bounced.asked, invented.asked]) {
      expect(asked).toEqual([["complete", "overclaims", "invented"]])
    }
    expect(disarmed.asked).toEqual([])
    expect(doneJudged.unproven).toBeUndefined()
    expect(heightJudged.unproven).toBeUndefined()
    // A frame to answer in is still spent first: the bounce asks the run to
    // finish the work before its report is taken as the outcome.
    expect(bouncedJudged.demand?.event).toMatchObject({ _tag: "claim-demanded", demanded: true })
    expect(bouncedJudged.unproven).toBeUndefined()
    expect(inventedJudged.unproven?.code).toBe("claim_unproven")
    expect(disarmedJudged.unproven).toBeUndefined()
    for (const judged of [doneJudged, heightJudged, bouncedJudged, inventedJudged, disarmedJudged]) {
      expect(judged.unfinishedDecision).toBeUndefined()
    }
  })

  it("charges the reading it asked on the claim reading, whichever of the two was metered", async () => {
    const claim = { inputTokens: 300, outputTokens: 10 }
    const unfinished = { inputTokens: 120, outputTokens: 2 }
    const both = await settled(jev({ complete: 0.04 }, 0.97, { claim, unfinished }).layer)
    const claimOnly = await settled(jev({ complete: 0.04 }, 0.97, { claim }).layer)
    const unfinishedOnly = await settled(jev({ complete: 0.04 }, 0.97, { unfinished }).layer)
    const neither = await settled(jev({ complete: 0.04 }, 0.97).layer)

    expect(both.observed?.usage).toEqual({ inputTokens: 420, outputTokens: 12 })
    expect(claimOnly.observed?.usage).toEqual(claim)
    expect(unfinishedOnly.observed?.usage).toEqual(unfinished)
    expect(neither.observed?.usage).toBeUndefined()
  })

  it("fails the turn when the question cannot be had, carrying what the claim reading paid", async () => {
    const deadline = new Evaluator.EvaluatorError({ code: "timeout", message: "deadline", status: 504 })
    const claim = { inputTokens: 300, outputTokens: 10 }
    const paid = await failed(jev({ complete: 0.04 }, deadline, { claim }).layer)
    const unpaid = await failed(
      jev({ complete: 0.04 }, new Evaluator.EvaluatorError({ code: "refused", message: "no", resetAtEpochMillis: 9 }))
        .layer
    )

    expect(paid.code).toBe("completion_unjudged")
    expect(paid.message).toContain(report)
    expect(paid.cause).toMatchObject({ code: "timeout", status: 504, usage: claim })
    // A reading that failed after it was metered is charged beside the claim's.
    const metered = await failed(
      jev(
        { complete: 0.04 },
        new Evaluator.EvaluatorError({
          code: "invalid_answer",
          message: "bad",
          usage: { inputTokens: 50, outputTokens: 1 }
        }),
        { claim }
      ).layer
    )
    expect((metered.cause as Evaluator.EvaluatorError).usage).toEqual({ inputTokens: 350, outputTokens: 11 })
    expect(unpaid.cause).toMatchObject({ code: "refused", resetAtEpochMillis: 9 })
    expect((unpaid.cause as Evaluator.EvaluatorError).usage).toBeUndefined()
  })

  it("keeps the whole report where it fits, and says what it dropped where it does not", () => {
    const long = "x".repeat(CompletionClaim.refusedBytes + 100)
    const clipped = UnfinishedWork.incomplete(0.1, 0.95, long)

    expect(UnfinishedWork.incomplete(0.1, 0.95, "  short  ").message).toMatch(/\n\nshort$/)
    expect(clipped.message).toContain("the run record has the whole completion")
    expect(clipped.message).not.toContain(long)
  })
})
