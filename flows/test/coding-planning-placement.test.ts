import { NodeCrypto } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, HumanTask, Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  declineLayer,
  type Draft,
  DraftPlan,
  finalize,
  GatherContext,
  type PlanningContext,
  planningPolicy,
  PreparePlan,
  ReviewRequest,
  VerifyContext
} from "../coding/planning.ts"
import { type Check, CodingError, type Revision } from "../coding/schema.ts"

/*
 * Plans place work anywhere in the mythical stack: a new change may be
 * inserted between existing ones (the native adapter creates it with
 * `jj new --insert-after`, and JJ restacks what follows), while every existing
 * descendant must still appear once, in native order. A request the reviewer
 * declines plans nothing and fails with the visible reason.
 */

const revision = (name: string, parent?: Revision): Revision & { description: string } => ({
  changeId: `change-${name}`,
  commitId: `commit-${name}`,
  treeId: `tree-${name}`,
  operationId: "op",
  parentCommitIds: parent === undefined ? ["commit-root"] : [parent.commitId],
  description: `✨ feat: ${name}`
})
const a = revision("a"), b = revision("b", a), c = revision("c", b)
const checks: ReadonlyArray<Check> = [
  { id: "fast", target: "flows", flow: "checks/fast", flowDigest: "f".repeat(64), tier: "fast", required: true },
  { id: "slow", target: "flows", flow: "checks/slow", flowDigest: "s".repeat(64), tier: "slow", required: true }
]
const context: PlanningContext = {
  head: c,
  history: [a, b, c],
  memory: [],
  memoryRevision: "memory",
  implementation: "coding/implementation",
  implementationDigest: "i".repeat(64),
  checks,
  sources: [],
  missing: []
}
const input = { prompt: "Fix the bug where it was introduced", feedback: "" }
const atom = (changeId: string | null, message: string) => ({
  changeId,
  message,
  intent: message,
  reads: [],
  writes: ["a.ts"]
})
const draft = (baseChangeId: string, atoms: ReadonlyArray<ReturnType<typeof atom>>): Draft => ({
  rationale: "fixture",
  baseChangeId,
  changes: [{ id: "fix", title: "Fix", intent: "Fix it", atoms, checks: ["fast", "slow"] }]
})

test("a new change is inserted between existing ones and existing descendants keep their order", () => {
  const plan = finalize(
    input,
    context,
    draft(a.changeId, [
      atom(b.changeId, "✨ feat: b"),
      atom(null, "🐛 fix: b's bug"),
      atom(c.changeId, "✨ feat: c"),
      atom(null, "✅ test: c")
    ])
  )
  assert.equal(plan.base.changeId, a.changeId)
  assert.deepEqual(plan.changes[0]!.atoms.map((value) => value.changeId), [b.changeId, null, c.changeId, null])
  assert.equal(plan.observedHead?.changeId, c.changeId)
})

test("an amendment of the oldest visible change keeps every descendant", () => {
  const plan = finalize(
    input,
    context,
    draft(a.changeId, [atom(b.changeId, "✨ feat: b, fixed"), atom(c.changeId, "✨ feat: c")])
  )
  assert.deepEqual(plan.changes[0]!.atoms.map((value) => value.changeId), [b.changeId, c.changeId])
  // Appending is still the head-based plan.
  const append = finalize(input, context, draft(c.changeId, [atom(null, "✨ feat: d")]))
  assert.equal(append.base.changeId, c.changeId)
})

test("reordering or dropping an existing descendant is refused", () => {
  assert.throws(
    () => finalize(input, context, draft(a.changeId, [atom(c.changeId, "c"), atom(b.changeId, "b")])),
    (error: unknown) => error instanceof CodingError && error.code === "invalid_plan"
  )
  assert.throws(
    () => finalize(input, context, draft(a.changeId, [atom(null, "new"), atom(c.changeId, "c")])),
    (error: unknown) => error instanceof CodingError && /retain every existing descendant/.test(error.message)
  )
})

const host = (decline: string | undefined) => {
  const counts = { drafts: 0 }
  const layer = Layer.mergeAll(
    Interpreter.layer(PreparePlan),
    declineLayer,
    HumanTask.layer,
    planningPolicy,
    VerifyContext.toLayer(({ context }) => Effect.succeed(context)),
    GatherContext.toLayer(() => Effect.succeed(context)),
    ReviewRequest.toLayer(() =>
      Effect.succeed({
        explanation: "The evidence shows it",
        clarification: "",
        ...(decline === undefined ? {} : { decline })
      })
    ),
    DraftPlan.toLayer(() =>
      Effect.sync(() => {
        counts.drafts++
        return draft(c.changeId, [atom(null, "✨ feat: d")])
      })
    )
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )
  return { runtime: ManagedRuntime.make(layer), counts }
}

test("an actionable request is drafted into a plan", { timeout: 60_000 }, async (t) => {
  const { runtime, counts } = host(undefined)
  t.after(() => runtime.dispose())
  const plan = await runtime.runPromise(PreparePlan.execute(input, { executionId: "actionable" }))
  assert.equal(counts.drafts, 1)
  assert.equal(plan.base.changeId, c.changeId)
})

test("a declined request plans nothing and fails with the reviewer's reason", { timeout: 60_000 }, async (t) => {
  const { runtime, counts } = host("Already done: README.md has the Purpose section.")
  t.after(() => runtime.dispose())
  const exit = await runtime.runPromiseExit(PreparePlan.execute(input, { executionId: "declined" }))
  assert.equal(counts.drafts, 0)
  assert.ok(Exit.isFailure(exit))
  const rendered = JSON.stringify(exit.cause)
  assert.match(rendered, /declined/)
  assert.match(rendered, /Already done: README.md has the Purpose section./)
})
