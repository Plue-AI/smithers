import { NodeCrypto } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, HumanTask, Interpreter } from "@smthrs/flow"
import { Effect, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  carriedAnswer,
  declineLayer,
  type Draft,
  DraftPlan,
  GatherContext,
  type PlanningContext,
  planningPolicy,
  planningPrompt,
  PreparePlan,
  ReviewRequest,
  VerifyContext
} from "../coding/planning.ts"
import type { CarriedAnswer, Revision } from "../coding/schema.ts"

/*
 * A person's answer to an agent's question reaches every later attempt of
 * the TODO (the 2026-10-05 real walk: attempt 2 never saw "Put it in the
 * repository root." and wrote src/greet.mjs). The stack sends the answers
 * beside the steers; planning shows them to the agent as it shows the
 * feedback, and never asks an answered question again.
 */

const head: Revision & { description: string } = {
  changeId: "change-head",
  commitId: "commit-head",
  treeId: "tree-head",
  operationId: "op",
  parentCommitIds: ["commit-root"],
  description: "✨ feat: seed"
}
const context: PlanningContext = {
  head,
  history: [head],
  memory: [],
  memoryRevision: "memory",
  implementation: "coding/implementation",
  implementationDigest: "i".repeat(64),
  checks: [],
  sources: [],
  missing: []
}
const draft: Draft = {
  rationale: "No checks found",
  baseChangeId: head.changeId,
  changes: [{
    id: "greet",
    title: "Greet",
    intent: "Add greet.mjs",
    atoms: [{ changeId: null, message: "✨ feat: add greet", intent: "add greet", reads: [], writes: ["greet.mjs"] }],
    checks: []
  }]
}
const where = "Put greet.mjs in the repository root or in src/?"
const answers: ReadonlyArray<CarriedAnswer> = [
  { question: where, answer: "Put it in the repository root.", by: "ben" },
  { question: "Export it as greet or as hello?", answer: "greet", by: "alice" }
]
const input = { prompt: "Add a greet function with a test", feedback: "keep the existing adds test", answers }

/** PreparePlan on the real engine with the model actions scripted: each
 * records the prompt the model would receive (planningPrompt), and the human
 * task records every question it is asked. */
const host = (clarification: string) => {
  const seen = {
    review: [] as Array<string>,
    draft: [] as Array<string>,
    answer: [] as Array<unknown>,
    asked: [] as Array<string>
  }
  const layer = Layer.mergeAll(
    Interpreter.layer(PreparePlan),
    declineLayer,
    planningPolicy,
    HumanTask.action.toLayer(({ prompt }) => Effect.sync(() => (seen.asked.push(prompt), "Answered now"))),
    VerifyContext.toLayer(({ context }) => Effect.succeed(context)),
    GatherContext.toLayer(() => Effect.succeed(context)),
    ReviewRequest.toLayer((payload) =>
      Effect.sync(() => {
        seen.review.push(planningPrompt(payload))
        return { explanation: "The answers settle where the code goes", clarification }
      })
    ),
    DraftPlan.toLayer((payload) =>
      Effect.sync(() => {
        seen.draft.push(planningPrompt(payload))
        seen.answer.push(payload.answer)
        return draft
      })
    )
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )
  return { runtime: ManagedRuntime.make(layer), seen }
}

test("carried answers reach the review and draft prompts and every atom's intent", { timeout: 60_000 }, async (t) => {
  const { runtime, seen } = host("")
  t.after(() => runtime.dispose())
  const plan = await runtime.runPromise(PreparePlan.execute(input, { executionId: "carried" }))
  for (const sent of [seen.review, seen.draft]) {
    assert.equal(sent.length, 1)
    const shown = JSON.parse(sent[0]!).input
    assert.equal(shown.feedback, input.feedback)
    assert.deepEqual(shown.answers, answers, "the answers sit beside the steers, in order, with who answered")
  }
  assert.deepEqual(seen.asked, [])
  const intent = JSON.parse(plan.changes[0]!.atoms[0]!.intent)
  assert.equal(intent.feedback, input.feedback)
  assert.deepEqual(intent.answers, answers, "the implementing agent sees them as it sees the steers")
})

test("with nothing carried the prompts and intents are as before", { timeout: 60_000 }, async (t) => {
  const { runtime, seen } = host("")
  t.after(() => runtime.dispose())
  const plan = await runtime.runPromise(
    PreparePlan.execute({ prompt: input.prompt, feedback: input.feedback }, { executionId: "uncarried" })
  )
  assert.deepEqual(Object.keys(JSON.parse(seen.review[0]!).input), ["prompt", "feedback"])
  assert.deepEqual(Object.keys(JSON.parse(plan.changes[0]!.atoms[0]!.intent)), [
    "request",
    "feedback",
    "change",
    "atom"
  ])
})

test("a question a person already answered is not asked again: the carried answer stands", {
  timeout: 60_000
}, async (t) => {
  const { runtime, seen } = host("  put GREET.mjs in the repository root\n or in src/? ")
  t.after(() => runtime.dispose())
  await runtime.runPromise(PreparePlan.execute(input, { executionId: "answered" }))
  assert.deepEqual(seen.asked, [], "no Needs you for an answered question")
  assert.deepEqual(seen.answer, ["Put it in the repository root."])
})

test("a new question is still asked", { timeout: 60_000 }, async (t) => {
  const { runtime, seen } = host("Should greet trim its input?")
  t.after(() => runtime.dispose())
  await runtime.runPromise(PreparePlan.execute(input, { executionId: "new-question" }))
  assert.deepEqual(seen.asked, ["Should greet trim its input?"])
  assert.deepEqual(seen.answer, ["Answered now"])
})

test("carriedAnswer matches a question by its words, ignoring case and spacing", () => {
  assert.equal(carriedAnswer(answers, "export it as GREET or as hello?"), "greet")
  assert.equal(carriedAnswer(answers, "Export it as greet?"), undefined)
  assert.equal(carriedAnswer(undefined, where), undefined)
  assert.equal(carriedAnswer([], where), undefined)
  assert.equal(carriedAnswer(answers, ""), undefined)
})
