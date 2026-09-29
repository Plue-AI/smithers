import { NodeCrypto } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, FlowRuntime } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { CorrectPlan } from "../coding/correction.ts"
import { PrepareRequest } from "../coding/preparation.ts"
import { Request, requestRegistration } from "../coding/request.ts"
import { CodingError, type Plan, type Revision } from "../coding/schema.ts"
import { AdmitSource } from "../coding/source-admission.ts"
import { CreateStackBase, PrepareStackBase } from "../coding/stack.ts"
import { ReceiveFeedback } from "../coding/steering.ts"
import { clipTodo, leafFeedback, MAX_TODO_BYTES, type Route, routeTodo, todoLayers } from "../coding/todo.ts"

const prompt =
  "Resolve GitHub issue #7: Saving twice loses the title\n\n<issue>\nSaving twice drops the title.\n</issue>"

test("each leaf keeps the given feedback and adds only its own instruction", () => {
  assert.equal(leafFeedback("implement", "Keep the verifier"), "Keep the verifier")
  assert.equal(leafFeedback("implement", ""), "")
  assert.match(
    leafFeedback("bug", "Keep the verifier"),
    /^Keep the verifier\n\n.*first atom adds a regression test that fails/s
  )
  assert.match(
    leafFeedback("close", ""),
    /^Jev routed this TODO as needing no code change\. Decline it with the evidence/
  )
  assert.match(leafFeedback("feature", ""), /^Jev routed this TODO as a feature request\. Lint it before planning/)
  assert.match(leafFeedback("feature", ""), /decline it with at most three questions/)
})

test("Jev answers the route from the TODO text; low confidence is still Jev deciding", async () => {
  const asked: Array<unknown> = []
  const answer = await Effect.runPromise(
    routeTodo({ prompt }).pipe(Effect.provide(Evaluator.layerScripted((request) => {
      asked.push(request.state)
      return { route: { choice: "bug", probabilities: { implement: 0.3, bug: 0.4, close: 0.3 } } }
    })))
  )
  assert.deepEqual(answer, { route: "bug", confidence: 0.4 })
  assert.deepEqual(asked, [{ todo: prompt }])
})

test("Jev reads at most one state's bytes of the TODO, never a split character", () => {
  assert.equal(clipTodo("short"), "short")
  const long = "é".repeat(MAX_TODO_BYTES)
  const clipped = clipTodo(long)
  assert.ok(new TextEncoder().encode(clipped).length <= MAX_TODO_BYTES)
  assert.ok(clipped.length > MAX_TODO_BYTES / 4 && long.startsWith(clipped))
})

test("Jev down is a typed failure, never a default route", async () => {
  const result = await Effect.runPromise(Effect.result(
    routeTodo({ prompt }).pipe(
      Effect.provide(
        Evaluator.layerScripted(() =>
          Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "gateway down" }))
        )
      )
    )
  ))
  assert.equal(result._tag, "Failure")
  const failure = result._tag === "Failure" ? result.failure : undefined
  assert.ok(failure instanceof CodingError)
  assert.equal(failure.code, "unavailable")
  assert.match(failure.message, /Jev did not route the TODO: gateway down/)
})

const revision = (name: string): Revision => ({
  changeId: `change-${name}`,
  commitId: `commit-${name}`,
  treeId: `tree-${name}`,
  operationId: `op-${name}`,
  parentCommitIds: []
})

/** The real engine runs coding/Request, factory/Todo and its Jev route over a
 * scripted evaluator; planning, source and correction are scripted children. */
const fixture = (route: Route | "down", decline = false) => {
  const events: Array<string> = [], planned: Array<string> = []
  let head = revision("initial")
  const children = Layer.effectDiscard(Effect.gen(function*() {
    const runtime = yield* FlowRuntime.FlowRuntime
    yield* runtime.register(PrepareRequest, (value) =>
      Effect.suspend(() => {
        events.push("plan")
        planned.push(value.feedback)
        if (decline) return Effect.fail(new CodingError({ code: "declined", message: "already done in a.ts" }))
        return Effect.succeed<Plan>({
          prompt: value.prompt,
          memoryRevision: "memory",
          base: head,
          observedHead: head,
          changes: [{
            id: "fix",
            title: "Fix",
            intent: "Fix it",
            implementation: "fixture/implement",
            implementationDigest: "0".repeat(64),
            checks: [],
            atoms: [{
              changeId: null,
              message: "🐛 fix: keep the title",
              intent: "Fix it",
              reads: [],
              writes: ["a.ts"]
            }]
          }]
        })
      }))
    yield* runtime.register(CorrectPlan, () =>
      Effect.sync(() => {
        events.push("implement")
        return {
          status: "validated" as const,
          rounds: 1,
          blocked: null,
          result: { status: "validated" as const, changes: [], findings: [] }
        }
      }))
  }))
  const evaluator = Evaluator.layerScripted(() => {
    events.push("jev")
    return route === "down"
      ? Effect.fail(new Evaluator.EvaluatorError({ code: "timeout", message: "no answer" }))
      : { route: { choice: route } }
  })
  const layer = Layer.mergeAll(
    requestRegistration,
    todoLayers(evaluator),
    children,
    PrepareStackBase.toLayer(({ base }) =>
      Effect.sync(() => ({
        operation: "create" as const,
        requestId: "00000000-0000-8000-a000-000000000001",
        expectedOperationId: "1".repeat(128),
        target: {
          changeId: "k".repeat(32),
          commitId: base.commitId,
          treeId: "e".repeat(40),
          operationId: "1".repeat(128),
          parentCommitIds: []
        },
        description: ""
      }))
    ),
    CreateStackBase.toLayer(({ base }) =>
      Effect.sync(() => {
        events.push("base")
        head = { ...revision("working"), parentCommitIds: [base.commitId] }
        return head
      })
    ),
    AdmitSource.toLayer(({ plan }) => Effect.succeed({ ...plan, observedHead: head })),
    ReceiveFeedback.toLayer(({ boundary }) => Effect.succeed({ boundary, messages: [] }))
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )
  return { host: ManagedRuntime.make(layer), events, planned }
}

const tip = "a".repeat(40)
const base = { commitId: tip, ref: `refs/smithers/workspaces/11111111-1111-4111-a111-111111111111/sources/${tip}` }

test(
  "a TODO on the stack is routed once, after it stands on the tip and before it is planned",
  { timeout: 60_000 },
  async (t) => {
    const f = fixture("bug")
    t.after(() => f.host.dispose())
    const input = { prompt, feedback: "Keep the verifier", base }
    const result = await f.host.runPromise(Request.execute(input, { executionId: "todo-bug" }))
    assert.equal(result.outcome.status, "validated")
    assert.equal(result.route, "bug", "the result says how the TODO was routed")
    assert.deepEqual(f.events, ["base", "jev", "plan", "implement"])
    assert.equal(f.planned[0], leafFeedback("bug", "Keep the verifier"), "the bug leaf plans a reproduction first")
    // A completed replay routes and plans nothing again.
    await f.host.runPromise(Request.execute(input, { executionId: "todo-bug" }))
    assert.deepEqual(f.events, ["base", "jev", "plan", "implement"])
  }
)

test(
  "the close and feature leaves ask the planner to decline with evidence or questions; implement plans as written",
  { timeout: 60_000 },
  async (t) => {
    for (const route of ["close", "feature", "implement"] as const) {
      const f = fixture(route)
      t.after(() => f.host.dispose())
      await f.host.runPromise(Request.execute({ prompt, base }, { executionId: `todo-${route}` }))
      assert.equal(f.planned[0], leafFeedback(route, ""))
    }
  }
)

test("a declined TODO fails with the planner's decline and the route Jev gave it", { timeout: 60_000 }, async (t) => {
  for (const route of ["close", "implement"] as const) {
    const f = fixture(route, true)
    t.after(() => f.host.dispose())
    const result = await f.host.runPromise(
      Effect.result(Request.execute({ prompt, base }, { executionId: `todo-declined-${route}` }))
    )
    const failure = result._tag === "Failure" ? result.failure : undefined
    assert.ok(failure instanceof CodingError, `expected a CodingError, got ${String(failure)}`)
    // The run's final output is the encoded error; the stack reads route there
    // (mythical_todo_test.go TestMythicalSnapshotShowsATodosMetrics).
    assert.deepEqual(Schema.encodeSync(CodingError)(failure), {
      _tag: "coding/Error",
      code: "declined",
      message: "already done in a.ts",
      route
    })
    assert.deepEqual(f.events, ["base", "jev", "plan"])
  }
})

test("a request without a stack base is not a TODO and is never routed", { timeout: 60_000 }, async (t) => {
  const f = fixture("close")
  t.after(() => f.host.dispose())
  const result = await f.host.runPromise(Request.execute({ prompt, feedback: "as written" }, { executionId: "chat" }))
  assert.deepEqual(f.events, ["plan", "implement"])
  assert.equal(result.route, undefined)
  assert.equal(f.planned[0], "as written")
})

test("Jev down fails the TODO's lane before anything is planned", { timeout: 60_000 }, async (t) => {
  const f = fixture("down")
  t.after(() => f.host.dispose())
  await assert.rejects(
    f.host.runPromise(Request.execute({ prompt, base }, { executionId: "todo-down" })),
    /Jev did not route the TODO: no answer/
  )
  assert.deepEqual(f.events, ["base", "jev"])
})
