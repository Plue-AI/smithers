import { NodeServices } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { evaluationLayers, ScoreCase, ScoreExecution, SeatScore } from "../repository/evaluation.ts"
import { caseClassifier, SCORE_CONFIDENCE, scoreState, verdicts } from "../repository/jev-score.ts"
import type { EvalCase, EvalResult, JobResult, RepositoryEvidence } from "../repository/schema.ts"

const sourceRevision = "a".repeat(40)
const event = {
  source: "smithers-cloud",
  type: "issues",
  action: "opened",
  deliveryKey: "case-1",
  issueNumber: 3,
  payload: { issue: { title: "What does widen() return?", body: "The README is short." } }
}
const heldOut: typeof EvalCase.Type = {
  id: "readme-question",
  name: "Answer the README question",
  required: true,
  expected: "HELD_OUT: the answer cites greeting.mjs and says the unit is metres.",
  input: JSON.stringify({ event, sourceRevision, assertions: [{ path: "/results/0/status", equals: "completed" }] })
}
const observed: JobResult = {
  repo: "example/repo",
  job: "issues",
  revision: 3,
  digest: "b".repeat(64),
  sourceRevision,
  eventKey: "case-1",
  status: "completed",
  publicActions: [],
  results: [{
    stepId: "research",
    status: "completed",
    summary: "The unit is metres.",
    executionId: "research-step",
    evidence: ["source:greeting.mjs@0123"],
    output: { classification: "question", summary: "The unit is metres." }
  }]
}
const evidence: RepositoryEvidence = {
  repo: "example/repo",
  missing: [],
  history: [],
  records: [],
  sources: [],
  files: [],
  source: {
    changeId: "change",
    commitId: sourceRevision,
    treeId: "tree",
    operationId: "operation",
    parentCommitIds: []
  }
}
const written = { reason: "The recorded research answers the question from the captured source.", evidenceIds: [0] }

const scripted = (choice: string, confidence: number): Layer.Layer<Evaluator.Evaluator> => {
  const rest = (1 - confidence) / 2
  return Evaluator.layerScripted(() => ({
    verdict: {
      choice,
      probabilities: Object.fromEntries(Object.keys(verdicts).map((key) => [key, key === choice ? confidence : rest]))
    }
  }))
}

const score = async (evaluator: Layer.Layer<Evaluator.Evaluator>) => {
  const seat: Array<string> = []
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      evaluationLayers({ evaluator }),
      ScoreCase.toLayer(() =>
        Effect.sync(() => {
          seat.push(ScoreCase.name)
          return written
        })
      )
    )
      .pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(NodeServices.layer)
      )
  )
  try {
    const result = await runtime.runPromise(
      ScoreExecution.execute({ test: heldOut, observed, evidence, deadlineAt: Date.now() + 120_000 }, {
        executionId: "score-case"
      }).pipe(Effect.result)
    )
    return { result, seat }
  } finally {
    await runtime.dispose()
  }
}
const row = (result: unknown) => (result as { success: typeof EvalResult.Type }).success

test("the verdict is one Jev choice, and the seat keeps only what Jev cannot produce", () => {
  assert.deepEqual(Object.keys(verdicts), ["pass", "fail", "review"])
  assert.equal(caseClassifier.id, "eval/case")
  assert.equal(caseClassifier.questions.verdict.type, "choice")
  assert.equal(SCORE_CONFIDENCE, 0.8)
  assert.deepEqual(
    Object.keys(SeatScore.fields),
    ["reason", "evidenceIds"],
    "the seat writes the prose and picks the numbered evidence; it no longer votes"
  )
})

test("Jev's verdict decides the recorded row, and the seat's prose and evidence ride along", async () => {
  const passed = await score(scripted("pass", 0.93))
  assert.deepEqual(passed.seat, [ScoreCase.name])
  assert.equal(row(passed.result).status, "passed")
  assert.equal(row(passed.result).observed, written.reason)
  assert.deepEqual([...row(passed.result).evidence], ["execution:research-step"])
  const failed = await score(scripted("fail", 0.91))
  assert.equal(row(failed.result).status, "failed", "the same recorded job, the other verdict")
})

test("a verdict under the floor is review, which is Jev deciding", async () => {
  const unsure = await score(scripted("pass", 0.55))
  assert.ok(SCORE_CONFIDENCE > 0.55 && SCORE_CONFIDENCE <= 0.91, "the floor this pair of tests straddles")
  assert.equal(row(unsure.result).status, "review")
  assert.equal(row(unsure.result).observed, written.reason)
})

test("an evaluator failure fails the score typed, and no seat is asked", async () => {
  const { result, seat } = await score(Evaluator.layerUnavailable())
  assert.deepEqual(seat, [], "a Jev failure never falls back to a frontier model")
  assert.equal(result._tag, "Failure")
  const failure = (result as { failure: { _tag: string; code: string; message: string } }).failure
  assert.equal(failure._tag, "coding/Error")
  assert.equal(failure.code, "unavailable")
  assert.match(failure.message, /unreachable/)
})

test("the state carries the frozen expectation and the recorded job, bounded", () => {
  const state = scoreState(heldOut, observed)
  assert.equal(state.expected, heldOut.expected)
  assert.deepEqual(state.observed.results.map((result) => result.stepId), ["research"])
  assert.ok(
    new TextEncoder().encode(JSON.stringify(Schema.encodeUnknownSync(caseClassifier.state)(state))).length <= 32 * 1024
  )
  const flooded = scoreState({ ...heldOut, expected: "y".repeat(9000) }, {
    ...observed,
    results: Array.from(
      { length: 40 },
      (_, index) => ({ ...observed.results[0]!, stepId: `step-${index}`, summary: "z".repeat(4000) })
    )
  })
  assert.ok(new TextEncoder().encode(JSON.stringify(flooded)).length <= 32 * 1024)
})
