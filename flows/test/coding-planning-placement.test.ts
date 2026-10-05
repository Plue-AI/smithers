import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as Budget from "@smthrs/agent/Budget"
import * as RunawayGuard from "@smthrs/agent/RunawayGuard"
import { FlowEngine } from "@smthrs/engine"
import { Action, FlowRuntime, HumanTask, Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer, ManagedRuntime, Option, Schema } from "effect"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { contractFailure } from "../coding/planning-memory.ts"
import {
  declineLayer,
  Draft,
  DraftPlan,
  finalize,
  GatherContext,
  PlanningContext,
  planningPolicy,
  PreparePlan,
  preparePlanLayer,
  ReviewRequest,
  VerifyContext
} from "../coding/planning.ts"
import { detectChecks } from "../coding/project-config.ts"
import { type Check, CodingError, type Revision, validatePlan } from "../coding/schema.ts"

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

test("a repository with one detected check, or none, plans (mvp.md J1.4)", async () => {
  // The 2026-10-05 walk: a package.json with only `test` detects one slow
  // check, and planning refused it three times as stale_revision.
  const root = await mkdtemp(join(tmpdir(), "coding-planning-checks-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }))
    const detected = await Effect.runPromise(detectChecks(root).pipe(Effect.provide(NodeServices.layer)))
    const one = detected.checks.map((check) => ({ ...check, flowDigest: "t".repeat(64) }))
    assert.deepEqual(one.map((check) => `${check.id}:${check.tier}`), ["test:slow"])
    for (const repository of [one, []]) {
      const gathered = Schema.decodeUnknownSync(PlanningContext)({ ...context, checks: repository })
      // The model may select nothing: the host attaches every required check.
      const appended = draft(c.changeId, [atom(null, "✅ test: cover d")])
      const drafted = Schema.decodeUnknownSync(Draft)({
        ...appended,
        changes: [{ ...appended.changes[0]!, checks: [] }]
      })
      const plan = finalize(input, gathered, drafted)
      assert.deepEqual(plan.changes[0]!.checks, repository)
      // A plan with one check, or none, is a valid plan everywhere it is read.
      assert.doesNotThrow(() => validatePlan(plan))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a gathered context that breaks its contract names why, as a host fault, not a stale source", () => {
  const error = Effect.runSync(Effect.flip(Schema.decodeUnknownEffect(PlanningContext)({ ...context, history: [] })))
  const refusal = contractFailure(error.message)
  assert.equal(refusal.code, "execution")
  assert.match(refusal.message, /^Gathered planning context violates its contract: .*history/)
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

test(
  "planning past the tool-call limit parks on the runaway guard's tool-call facts (#2279)",
  { timeout: 60_000 },
  async (t) => {
    // The guard's host side: a trip opens a question, and a drive while it is
    // open re-parks without planning again.
    const tripped: Array<RunawayGuard.Timeout> = []
    const parked: Budget.Parked = {
      waiting: { reason: "budget", token: "budget/run/timeout/plan/1" },
      // What a model call refused under this park fails with; planning reads the wait.
      failure: RunawayGuard.stopped({ classification: "Stuck", source: "tool-call", message: "parked" })
    }
    const parking = Layer.succeed(Budget.Parking)({
      guardsTimeouts: true,
      park: () => Effect.die("no budget park is expected"),
      trip: (timeout) => Effect.sync(() => (tripped.push(timeout), parked)),
      admit: () =>
        Effect.succeed(
          tripped.length === 0 ? { _tag: "proceed" as const, continued: 0 } : { _tag: "park" as const, parked }
        )
    })
    let drafts = 0
    const layer = Layer.mergeAll(
      preparePlanLayer(20),
      declineLayer,
      HumanTask.layer,
      planningPolicy,
      VerifyContext.toLayer(({ context }) => Effect.succeed(context)),
      GatherContext.toLayer(() => Effect.succeed(context)),
      ReviewRequest.toLayer(() => Effect.succeed({ explanation: "The evidence shows it", clarification: "" })),
      DraftPlan.toLayer(() =>
        Effect.as(Effect.sleep("300 millis"), draft(c.changeId, [atom(null, "✨ feat: d")])).pipe(
          Effect.ensuring(Effect.sync(() => drafts++))
        )
      )
    ).pipe(
      Layer.provideMerge(parking),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer)
    )
    const runtime = ManagedRuntime.make(layer)
    t.after(() => runtime.dispose())
    const settled = await runtime.runPromise(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.execute(PreparePlan, { executionId: "stuck", payload: input, discard: true })
      for (let attempt = 0; attempt < 200; attempt++) {
        const polled = yield* engine.poll(PreparePlan, "stuck")
        if (Option.isSome(polled)) return polled.value._tag
        yield* Effect.sleep("10 millis")
      }
      return "unsettled"
    }))

    assert.equal(settled, "Suspended")
    assert.deepEqual(tripped.map((timeout) => [timeout.source, timeout.subject, timeout.limitMillis]), [
      ["tool-call", "coding/PreparePlan:stuck", 20]
    ])
    // The drafting call the limit cut off never settled into a plan.
    assert.equal(drafts, 1)
  }
)
