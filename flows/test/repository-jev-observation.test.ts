import { NodeServices } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, FlowRuntime, HumanTask, Interpreter } from "@smthrs/flow"
import { Effect, FileSystem, Layer, ManagedRuntime, Schema } from "effect"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding } from "../coding/native.ts"
import { executionLayers } from "../repository/execution.ts"
import { inspectionLayers } from "../repository/inspection.ts"
import {
  ExecuteRepro,
  failureLayer,
  Finding,
  intakeClassification,
  InvestigateStep,
  type Observation,
  observationOf,
  ProposeRepro,
  Research,
  Review,
  type Work
} from "../repository/jobs.ts"
import type { StepResult } from "../repository/schema.ts"
import { makeHostJudge } from "./fixtures/scripted-judge.ts"

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
  text: "export const greeting = 'hello'\n",
  truncated: false
}
const issue = {
  number: 7,
  title: "widen() drops the unit",
  body: "It returns m where km is expected",
  user: { login: "reporter" }
}
const step = (id: string): typeof Work.Type["step"] => ({
  id,
  name: id,
  mode: "automatic",
  prompt: `Run the ${id} step`
})

const workFor = (id: string, intake?: typeof Work.Type["intake"]): typeof Work.Type => ({
  repo: "example/repo",
  job: "issues",
  deadlineAt: Date.now() + 120_000,
  step: step(id),
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
  evidence: { repo: "example/repo", source, files: [greeting], missing: [], history: [], records: [], sources: [] },
  ...(intake === undefined ? {} : { intake })
})

/** What a seat answers. The stray `classification` is deliberate: a seat that
 * still volunteers one must not be able to overrule the screen. */
const answered = {
  summary: "The exported greeting is hello.",
  question: "",
  citations: ["greeting.mjs"],
  reproduction: null,
  classification: "bug"
} as unknown as typeof Finding.Type

/** Runs the real `InvestigateStep` with every investigation seat scripted, so
 * a step that reached a frontier model records which one. */
const runStep = async (work: typeof Work.Type, answer: typeof Finding.Type = answered) => {
  const seat: Array<string> = []
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const seatOnly = (tag: string) =>
    Effect.sync(() => {
      seat.push(tag)
      return answer
    })
  const options = { repositoryPath: "/nonexistent", fs, environment: { PATH: process.env.PATH! } }
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Interpreter.layer(InvestigateStep),
      failureLayer,
      HumanTask.layer,
      inspectionLayers(options),
      executionLayers({ ...options, evaluator: makeHostJudge().layer }),
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
    const result = await runtime.runPromise(InvestigateStep.execute({ work }, { executionId: `${work.step.id}-step` }))
    return { result: result as typeof StepResult.Type, seat }
  } finally {
    await runtime.dispose()
  }
}

const observationOut = (result: typeof StepResult.Type) =>
  Schema.decodeUnknownSync(Schema.Struct({
    classification: Schema.String,
    summary: Schema.String,
    question: Schema.String,
    citations: Schema.Array(Schema.String),
    reproduction: Schema.NullOr(Schema.Unknown),
    duplicates: Schema.Array(Schema.Unknown)
  }))(result.output)

test("the screen's answer is the observation's classification, and a seat cannot overrule it", async () => {
  const { result, seat } = await runStep(workFor("research", { kind: "spam", urgency: "low" }))
  assert.deepEqual(seat, [Research.name], "the research seat still writes the prose")
  assert.equal(result.status, "completed")
  const observation = observationOut(result)
  assert.equal(observation.classification, "irrelevant", "spam reads irrelevant, and the seat's own 'bug' is not read")
  assert.equal(observation.summary, "The exported greeting is hello.")
  assert.deepEqual([...observation.citations], ["greeting.mjs"])
  assert.deepEqual([...observation.duplicates], [], "a seat proposes no duplicate at all")
})

test("every intake kind carries onto the observation's own vocabulary", () => {
  const of = (kind: NonNullable<typeof Work.Type["intake"]>["kind"] | undefined) =>
    intakeClassification(kind === undefined ? workFor("research") : workFor("research", { kind, urgency: "low" }))
  assert.equal(of("bug"), "bug")
  assert.equal(of("feature"), "feature")
  assert.equal(of("question"), "question")
  assert.equal(of("spam"), "irrelevant")
  assert.equal(of("irrelevant"), "irrelevant")
  assert.equal(of(undefined), undefined, "an unscreened event has no classification, not a guessed one")
  assert.deepEqual(
    observationOut(
      { output: JSON.parse(JSON.stringify(observationOf("feature", answered))) } as typeof StepResult.Type
    ),
    {
      classification: "feature",
      summary: answered.summary,
      question: "",
      citations: ["greeting.mjs"],
      reproduction: null,
      duplicates: []
    }
  )
})

test("a step Jev never screened fails typed, and no seat is asked instead", async () => {
  const { result, seat } = await runStep(workFor("research"))
  assert.deepEqual(seat, [], "a missing screen answer is never a reason to ask a frontier model")
  assert.equal(result.status, "error")
  const retained = result.output as { readonly code?: string; readonly _tag?: string; readonly message?: string }
  assert.equal(retained.code, "unavailable")
  assert.equal(retained._tag, "coding/Error")
  assert.match(retained.message!, /screen/i)
})

test("no investigation seat is asked to classify anything", () => {
  assert.deepEqual(
    Object.keys(Finding.fields),
    ["summary", "question", "citations", "reproduction"],
    "a seat answers only what is genuinely text"
  )
  const text = readFileSync(fileURLToPath(new URL("../repository/jobs.ts", import.meta.url)), "utf8")
  const seats = text.slice(text.indexOf("const model = "), text.indexOf("export const JevDuplicates"))
  assert.ok(seats.includes("repository/review"), "the slice covers all three seat declarations")
  assert.doesNotMatch(seats, /classif/i, "neither the shared teaching nor any role mentions classification")
})

/** The gate at the head of `repository/execute-repro`, reached through the
 * layer the host binds rather than through a re-implementation of it. */
const runRepro = async (classification: typeof Observation.Type["classification"]) => {
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const handlers = new Map<string, (payload: unknown) => { execute: Effect.Effect<unknown, unknown, never> }>()
  const runtime = {
    register: (
      declared: { _tag: string },
      action: (payload: unknown) => { execute: Effect.Effect<unknown, unknown, never> }
    ) => Effect.sync(() => handlers.set(declared._tag, action)),
    execute: () => Effect.die("no child execution is expected")
  }
  const work = workFor("reproduce", { kind: "bug", urgency: "high" })
  const observation: typeof Observation.Type = {
    ...observationOf(classification, answered),
    reproduction: {
      files: [{ path: "repro.mjs", content: "import { greeting } from './greeting.mjs'\n" }],
      argv: [process.execPath, "repro.mjs"],
      cwd: ".",
      expected: "km",
      failureContains: "km",
      timeoutMs: 5000
    }
  }
  return Effect.runPromise(
    Effect.gen(function*() {
      yield* Layer.build(
        executionLayers({
          evaluator: makeHostJudge().layer,
          repositoryPath: "/nonexistent",
          fs,
          environment: { PATH: process.env.PATH! }
        })
          .pipe(
            Layer.provide([
              Layer.succeed(FlowRuntime.FlowRuntime, runtime as never),
              Action.layerImplementations,
              Jj.layerNoop({}),
              Layer.succeed(NativeCoding, undefined as never)
            ])
          )
      )
      return yield* handlers.get(ExecuteRepro.name)!({ work, observation }).execute.pipe(
        Effect.provideService(FlowRuntime.FlowInstance, { executionId: "repro-step" } as never),
        Effect.result
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
}

test("the reproduction gate reads the screen's answer", async () => {
  const refused = await runRepro("question")
  assert.equal(refused._tag, "Failure")
  assert.match(
    String((refused as { failure: { message: string } }).failure.message),
    /A reproduction needs a bug report/
  )
  const admitted = await runRepro("bug")
  assert.equal(admitted._tag, "Failure", "this fixture holds no source tree to execute in")
  assert.doesNotMatch(
    String((admitted as { failure: { message: string } }).failure.message),
    /A reproduction needs a bug report/,
    "a screened bug passes the gate and fails later, on the source"
  )
})
