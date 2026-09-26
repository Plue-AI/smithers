import { NodeServices } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, FileSystem, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding } from "../coding/native.ts"
import { executionLayers } from "../repository/execution.ts"
import {
  MAX_REPRODUCTION_STATE_BYTES,
  REPRODUCTION_CONFIDENCE,
  reproductionCitations,
  reproductionClassifier,
  reproductionState,
  verdicts
} from "../repository/jev-reproduction.ts"
import {
  modelNames,
  type Observation,
  observationOf,
  type Reproduction,
  ReviewReproduction,
  type Work
} from "../repository/jobs.ts"
import type { StepResult } from "../repository/schema.ts"

const source = {
  changeId: "change",
  commitId: "a".repeat(40),
  treeId: "tree",
  operationId: "operation",
  parentCommitIds: []
}
const greeting = {
  path: "greeting.mjs",
  digest: "d".repeat(64),
  text: "export const widen = value => value\n",
  truncated: false
}
const unread = { path: "docs/unit.md", digest: "e".repeat(64), text: "Units are metres.\n", truncated: false }
const issue = { number: 7, title: "widen() drops the unit", body: "It returns m where km is expected" }
const fixture = [{
  path: "repro.mjs",
  content: "import { widen } from './greeting.mjs'\nif (widen(1) !== 'km') throw new Error('wrong unit')\n"
}]
const reproduction: typeof Reproduction.Type = {
  files: fixture,
  argv: [process.execPath, "repro.mjs"],
  cwd: ".",
  expected: "widen() returns km",
  failureContains: "wrong unit",
  timeoutMs: 5000
}

const work: typeof Work.Type = {
  repo: "example/repo",
  job: "issues",
  deadlineAt: Date.now() + 120_000,
  step: { id: "reproduce", name: "Reproduce", mode: "automatic", prompt: "Propose the smallest failing test" },
  checks: [],
  landing: "ask",
  replies: "draft",
  executionMode: "live",
  intake: { kind: "bug", urgency: "high" },
  event: {
    source: "github",
    type: "issues",
    action: "opened",
    deliveryKey: "delivery-1",
    issueNumber: 7,
    payload: { issue }
  },
  evidence: {
    repo: "example/repo",
    source,
    files: [greeting, unread],
    missing: [],
    history: [],
    records: [],
    sources: []
  }
}
const observation: typeof Observation.Type = {
  ...observationOf("bug", { summary: "The unit is dropped.", question: "", citations: ["greeting.mjs"], reproduction }),
  reproduction
}

const measured = (observed: boolean): typeof StepResult.Type => ({
  stepId: "reproduce",
  status: "completed",
  summary: observed ? "Observed failure" : "Not reproduced",
  executionId: "repro-execution",
  evidence: ["execution:repro-execution", `source:${source.commitId}`],
  output: JSON.parse(
    JSON.stringify({
      status: observed ? "failure-observed" : "not-reproduced",
      source,
      fixture,
      argv: reproduction.argv,
      cwd: ".",
      expected: reproduction.expected,
      exitCode: observed ? 1 : 0,
      stdout: "",
      stderr: observed ? "Error: wrong unit\n" : "",
      truncated: false
    })
  )
})

const scripted = (choice: string, confidence: number): Layer.Layer<Evaluator.Evaluator> => {
  const rest = (1 - confidence) / 2
  return Evaluator.layerScripted(() => ({
    verdict: {
      choice,
      probabilities: Object.fromEntries(Object.keys(verdicts).map((key) => [key, key === choice ? confidence : rest]))
    }
  }))
}

const review = async (evaluator: Layer.Layer<Evaluator.Evaluator>, observed = true) => {
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const options = { repositoryPath: "/nonexistent", fs, environment: { PATH: process.env.PATH! }, evaluator }
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(Interpreter.layer(ReviewReproduction), executionLayers(options))
      .pipe(
        Layer.provide([Jj.layerNoop({}), Layer.succeed(NativeCoding, undefined as never)]),
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(NodeServices.layer)
      )
  )
  try {
    return await runtime.runPromise(
      ReviewReproduction.execute({ work, observation, result: measured(observed) }, {
        executionId: "review-reproduction"
      }).pipe(Effect.result)
    )
  } finally {
    await runtime.dispose()
  }
}

const reviewed = (result: typeof StepResult.Type) =>
  (result.output as unknown as {
    readonly review: { readonly verdict: string; readonly summary: string; readonly citations: ReadonlyArray<string> }
    readonly status: string
  }).review
const recorded = (result: typeof StepResult.Type) => (result.output as unknown as { readonly status: string }).status

test("the verdict is one Jev choice over the three the step may reach", () => {
  assert.deepEqual(Object.keys(verdicts), ["demonstrates", "unrelated", "uncertain"])
  assert.equal(reproductionClassifier.id, "reproduction/verdict")
  assert.equal(reproductionClassifier.questions.verdict.type, "choice")
  assert.equal(REPRODUCTION_CONFIDENCE, 0.8)
  assert.deepEqual(
    [...modelNames].sort(),
    ["repository/propose-repro", "repository/research", "repository/review"],
    "no frontier seat reviews a reproduction any more"
  )
})

test("a confident demonstrates reproduces the report, with prose the host wrote", async () => {
  const result = await review(scripted("demonstrates", 0.94))
  assert.equal(result._tag, "Success")
  const step = (result as { success: typeof StepResult.Type }).success
  assert.equal(step.status, "completed")
  assert.equal(step.summary, "Reproduced")
  assert.equal(recorded(step), "reproduced")
  assert.equal(reviewed(step).verdict, "demonstrates")
  assert.deepEqual(
    [...reviewed(step).citations],
    ["greeting.mjs", "repro.mjs"],
    "the fixture's own reads and the fixture itself, never a source it never named"
  )
})

test("a verdict under the floor is uncertain, which is Jev deciding", async () => {
  const result = await review(scripted("demonstrates", 0.6))
  assert.ok(REPRODUCTION_CONFIDENCE > 0.6 && REPRODUCTION_CONFIDENCE <= 0.94, "the floor this pair of tests straddles")
  const step = (result as { success: typeof StepResult.Type }).success
  assert.equal(reviewed(step).verdict, "uncertain")
  assert.equal(step.status, "needs-maintainer", "an unsure reproduction is a maintainer's to read")
  assert.equal(recorded(step), "needs-review")
})

test("an unrelated answer over a run that observed no failure completes the step", async () => {
  const result = await review(scripted("unrelated", 0.97), false)
  const step = (result as { success: typeof StepResult.Type }).success
  assert.equal(reviewed(step).verdict, "unrelated")
  assert.equal(step.status, "completed")
  assert.equal(recorded(step), "not-reproduced")
})

test("an evaluator failure fails the step typed, and nothing else is asked", async () => {
  const result = await review(Evaluator.layerUnavailable())
  assert.equal(result._tag, "Failure")
  const failure = (result as { failure: { _tag: string; code: string; message: string } }).failure
  assert.equal(failure._tag, "coding/Error")
  assert.equal(failure.code, "unavailable")
  assert.match(failure.message, /unreachable/)
})

test("the citations are the captured source the fixture actually names, and the state stays bounded", () => {
  assert.deepEqual([...reproductionCitations(work, reproduction)], ["greeting.mjs", "repro.mjs"])
  assert.deepEqual(
    [...reproductionCitations(work, {
      ...reproduction,
      files: [{ path: "repro.mjs", content: "throw new Error('wrong unit')\n" }]
    })],
    ["repro.mjs"],
    "a fixture that names no captured source cites none, so it can never demonstrate one"
  )
  const huge = "x".repeat(80_000)
  const state = reproductionState(work, reproduction, measured(true).output as never)
  assert.ok(new TextEncoder().encode(JSON.stringify(state)).length <= MAX_REPRODUCTION_STATE_BYTES)
  const flooded = reproductionState(
    work,
    { ...reproduction, files: [{ path: "repro.mjs", content: huge }] },
    JSON.parse(JSON.stringify({ ...measured(true).output as object, stdout: huge, stderr: huge }))
  )
  assert.ok(new TextEncoder().encode(JSON.stringify(flooded)).length <= MAX_REPRODUCTION_STATE_BYTES)
  assert.ok(flooded.measured.stdout.length > 0 && flooded.fixture[0]!.content.length > 0, "neither side is crowded out")
})
