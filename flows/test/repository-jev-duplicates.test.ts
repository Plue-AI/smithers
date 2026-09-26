import { NodeServices } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, HumanTask, Interpreter } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, FileSystem, Layer, ManagedRuntime, Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding } from "../coding/native.ts"
import { executionLayers } from "../repository/execution.ts"
import { inspectionLayers } from "../repository/inspection.ts"
import { batches } from "../repository/jev-checks.ts"
import {
  DUPLICATE_CONFIDENCE,
  duplicateCandidates,
  duplicateObservation,
  duplicateStates,
  levels,
  MAX_DUPLICATES,
  MAX_STATE_BYTES,
  pairClassifier,
  type PairState
} from "../repository/jev-duplicates.ts"
import {
  failureLayer,
  InvestigateStep,
  type Observation,
  ProposeRepro,
  Research,
  Review,
  type Work
} from "../repository/jobs.ts"
import type { Record as PriorRecord, StepResult } from "../repository/schema.ts"

const [distinct, related, same] = levels
const source = {
  changeId: "change",
  commitId: "a".repeat(40),
  treeId: "tree",
  operationId: "operation",
  parentCommitIds: []
}
const issue = {
  number: 7,
  title: "widen() drops the unit",
  body: "It returns m where km is expected",
  user: { login: "reporter" }
}

const record = (
  number: number,
  title: string,
  url = `https://example.invalid/issues/${number}`
): typeof PriorRecord.Type => ({
  source: "github",
  kind: "issue",
  number,
  title,
  body: `${title} body`,
  state: "open",
  url
})

const records = [
  record(1, "widen() returns metres"),
  record(2, "document the unit helpers"),
  record(3, "add a widen() overload")
]

const workWith = (
  prior: ReadonlyArray<typeof PriorRecord.Type>,
  intake?: typeof Work.Type["intake"]
): typeof Work.Type => ({
  repo: "example/repo",
  job: "issues",
  deadlineAt: Date.now() + 120_000,
  step: { id: "duplicates", name: "Find duplicates", mode: "automatic", prompt: "Find duplicate reports" },
  checks: [],
  landing: "ask",
  replies: "draft",
  executionMode: "live",
  event: {
    source: "github",
    type: "issues",
    action: "opened",
    deliveryKey: "delivery-1",
    issueNumber: 7,
    payload: { issue }
  },
  evidence: { repo: "example/repo", source, files: [], missing: [], history: [], records: prior, sources: [] },
  ...(intake === undefined ? {} : { intake })
})

/** One scripted answer per prior record, chosen by the candidate's number, run
 * through the real `InvestigateStep` so the branch under test is the deployed
 * one. Every action on the `repository/research` seat records its own tag, so
 * a duplicates step that reached a frontier model would show up here. */
const runStep = async (
  work: typeof Work.Type,
  answer: (number: number) => Evaluator.ScriptedAnswer | undefined,
  evaluator?: Layer.Layer<Evaluator.Evaluator>
) => {
  const asked: Array<PairState> = []
  const seat: Array<string> = []
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const scripted = evaluator ?? Evaluator.layerScripted((request) => {
    const state = request.state as PairState
    asked.push(state)
    const scored = answer(state.candidate.number)
    if (scored === undefined) {
      return Effect.fail(new Evaluator.EvaluatorError({ code: "refused", message: "scripted refusal" }))
    }
    return { score: scored }
  })
  const seatOnly = (tag: string) =>
    Effect.sync(() => {
      seat.push(tag)
      return { summary: "", question: "", citations: [], reproduction: null }
    })
  const options = { repositoryPath: "/nonexistent", fs, environment: { PATH: process.env.PATH! } }
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Interpreter.layer(InvestigateStep),
      failureLayer,
      HumanTask.layer,
      inspectionLayers(options),
      executionLayers({ ...options, evaluator: scripted }),
      Research.toLayer(() => seatOnly(Research.name)),
      ProposeRepro.toLayer(() => seatOnly(ProposeRepro.name)),
      Review.toLayer(() => seatOnly(Review.name))
    ).pipe(
      Layer.provide([Jj.layerNoop({}), Layer.succeed(NativeCoding, undefined as never)]),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeServices.layer)
    )
  )
  try {
    const result = await runtime.runPromise(InvestigateStep.execute({ work }, { executionId: "duplicates-step" }))
    return { result: result as typeof StepResult.Type, asked, seat }
  } finally {
    await runtime.dispose()
  }
}

const observationOf = (result: typeof StepResult.Type) =>
  Schema.decodeUnknownSync(Schema.Struct({
    classification: Schema.String,
    summary: Schema.String,
    question: Schema.String,
    citations: Schema.Array(Schema.String),
    reproduction: Schema.NullOr(Schema.Unknown),
    duplicates: Schema.Array(Schema.Struct({ source: Schema.String, number: Schema.Int, reason: Schema.String }))
  }))(result.output)

const scoredSame = (confidence: number): Evaluator.ScriptedAnswer => ({
  score: 2,
  probabilities: { [same!]: confidence, [related!]: (1 - confidence) / 2, [distinct!]: (1 - confidence) / 2 }
})
const scoredRelated = (confidence: number): Evaluator.ScriptedAnswer => ({
  score: 1,
  probabilities: { [related!]: confidence, [same!]: (1 - confidence) / 2, [distinct!]: (1 - confidence) / 2 }
})
const scoredDistinct: Evaluator.ScriptedAnswer = {
  score: 0,
  probabilities: { [distinct!]: 0.97, [related!]: 0.02, [same!]: 0.01 }
}

test("the three ordered levels say what similar-but-different means", () => {
  assert.deepEqual([...levels], [
    "distinct: different defects or requests",
    "related: same area or symptom, different cause",
    "same: the same underlying defect or request"
  ])
  assert.equal(DUPLICATE_CONFIDENCE, 0.8)
  assert.equal(pairClassifier.id, "duplicates/pair")
  assert.match(pairClassifier.questions.score.instructions, /similar/i)
})

test("one candidate answered same and confident is the only duplicate", async () => {
  const { result, asked, seat } = await runStep(
    workWith(records, { kind: "bug", urgency: "medium" }),
    (number) => number === 2 ? scoredSame(0.93) : scoredDistinct
  )
  assert.deepEqual(asked.map((state) => state.candidate.number), [1, 2, 3], "one state per prior record")
  assert.deepEqual(asked.map((state) => state.subject.title), [issue.title, issue.title, issue.title])
  assert.deepEqual(seat, [], "a duplicates step spends no frontier call at all")
  assert.equal(result.status, "completed")
  const observation = observationOf(result)
  assert.deepEqual([...observation.duplicates], [{ source: "github", number: 2, reason: same }])
  assert.deepEqual([...observation.citations], ["https://example.invalid/issues/2"])
  assert.equal(observation.summary, "Jev matched 1 of 3 prior records as the same defect.")
  assert.equal(observation.classification, "bug", "the intake screen's kind, never a second opinion")
  assert.equal(observation.question, "")
  assert.equal(observation.reproduction, null)
})

test("same under the confidence floor is not a duplicate", async () => {
  const { result } = await runStep(
    workWith(records, { kind: "bug", urgency: "medium" }),
    (number) => number === 2 ? scoredSame(0.6) : scoredDistinct
  )
  assert.ok(DUPLICATE_CONFIDENCE > 0.6 && DUPLICATE_CONFIDENCE <= 0.93, "the floor this pair of tests straddles")
  const observation = observationOf(result)
  assert.deepEqual([...observation.duplicates], [])
  assert.deepEqual([...observation.citations], [])
  assert.equal(observation.summary, "Jev found no prior record describing the same defect.")
})

test("a confident related answer is not a duplicate", async () => {
  const { result } = await runStep(
    workWith(records, { kind: "bug", urgency: "medium" }),
    (number) => number === 2 ? scoredRelated(0.95) : scoredDistinct
  )
  const observation = observationOf(result)
  assert.deepEqual([...observation.duplicates], [], "the same area is not the same defect")
  assert.equal(observation.summary, "Jev found no prior record describing the same defect.")
})

test("no prior record is an empty observation Jev is never asked about", async () => {
  const { result, asked, seat } = await runStep(
    workWith([], { kind: "feature", urgency: "low" }),
    () => scoredSame(0.99)
  )
  assert.deepEqual(asked, [], "nothing to compare is no evaluation")
  assert.deepEqual(seat, [])
  const observation = observationOf(result)
  assert.deepEqual([...observation.duplicates], [])
  assert.equal(observation.summary, "Jev found no prior record describing the same defect.")
  assert.equal(observation.classification, "feature")
  assert.equal(result.status, "completed")
})

test("an unavailable evaluator fails the step, and no seat is asked instead", async () => {
  const { result, seat } = await runStep(
    workWith(records, { kind: "bug", urgency: "medium" }),
    () => scoredSame(0.99),
    Evaluator.layerUnavailable()
  )
  assert.deepEqual(seat, [], "a Jev failure never falls back to a frontier model")
  assert.equal(result.status, "error")
  const retained = result.output as { readonly code?: string; readonly message?: string; readonly _tag?: string }
  assert.equal(retained.code, "unavailable")
  assert.equal(retained._tag, "coding/Error")
  assert.match(retained.message!, /unreachable/)
})

test("a refused answer fails the step rather than reading as no duplicate", async () => {
  const { result } = await runStep(workWith(records, { kind: "bug", urgency: "medium" }), () => undefined)
  assert.equal(result.status, "error")
  assert.equal((result.output as { readonly code?: string }).code, "unavailable")
})

test("seventy prior records are judged in two batches and every one is answered", async () => {
  const many = Array.from({ length: 70 }, (_, index) => record(index + 101, `prior ${index + 101}`))
  assert.deepEqual(batches(duplicateStates(workWith(many))).map((batch) => batch.length), [64, 6])
  const { asked, result } = await runStep(
    workWith(many, { kind: "bug", urgency: "medium" }),
    (number) => number === 170 ? scoredSame(0.9) : scoredDistinct
  )
  assert.equal(asked.length, 70, "no candidate is dropped between the batches")
  const observation = observationOf(result)
  assert.deepEqual([...observation.duplicates], [{ source: "github", number: 170, reason: same }])
  assert.equal(observation.summary, "Jev matched 1 of 70 prior records as the same defect.")
})

test("more matches than an observation may carry fails the step, never a truncated count", async () => {
  const many = Array.from({ length: MAX_DUPLICATES + 1 }, (_, index) => record(index + 101, `prior ${index + 101}`))
  const { result } = await runStep(workWith(many, { kind: "bug", urgency: "medium" }), () => scoredSame(0.95))
  assert.equal(result.status, "error")
  assert.equal((result.output as { readonly code?: string }).code, "unavailable")
  assert.match(result.summary, /21 of 21/)
})

test("the state stays under the classifier's 32 KiB bound and clips both bodies", () => {
  const huge = "x".repeat(60_000)
  const work = {
    ...workWith([{ ...record(1, "long"), body: huge }]),
    event: { ...workWith([]).event, payload: { issue: { ...issue, body: huge } } }
  } as typeof Work.Type
  const [state] = duplicateStates(work)
  assert.ok(new TextEncoder().encode(JSON.stringify(state)).length <= MAX_STATE_BYTES)
  assert.ok(state!.subject.body.length > 0 && state!.candidate.body.length > 0, "neither side is crowded out")
})

test("only a captured issue is a candidate, and never the event's own issue", () => {
  const prior = [
    record(7, "the event's own issue"),
    { ...record(8, "a pull request"), kind: "pr" as const },
    record(9, "a prior report")
  ]
  assert.deepEqual(duplicateCandidates(workWith(prior)).map((candidate) => candidate.number), [9])
})

test("a matched record with no URL cites nothing rather than an unread reference", () => {
  const prior = [record(4, "no url", "")]
  const observation: typeof Observation.Type = duplicateObservation(
    workWith(prior, { kind: "bug", urgency: "low" }),
    "bug",
    prior
  )
  assert.deepEqual([...observation.duplicates], [{ source: "github", number: 4, reason: same }])
  assert.deepEqual([...observation.citations], [])
})
