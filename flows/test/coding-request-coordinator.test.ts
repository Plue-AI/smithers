import { NodeCrypto } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, FlowRuntime } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { CorrectPlan } from "../coding/correction.ts"
import { Poc } from "../coding/poc.ts"
import { PrepareRequest } from "../coding/preparation.ts"
import { Prototype, prototypeRegistration } from "../coding/prototype.ts"
import { Request, requestRegistration } from "../coding/request.ts"
import { CodingError, type Plan, type Revision } from "../coding/schema.ts"
import { AdmitSource } from "../coding/source-admission.ts"
import { CreateStackBase, PrepareStackBase } from "../coding/stack.ts"
import { type FeedbackReceipt, ReceiveFeedback } from "../coding/steering.ts"
import { todoLayers } from "../coding/todo.ts"

const revision = (name: string): Revision => ({
  changeId: `change-${name}`,
  commitId: `commit-${name}`,
  treeId: `tree-${name}`,
  operationId: `op-${name}`,
  parentCommitIds: []
})
const message = (id: string): FeedbackReceipt["messages"][number] => ({
  _tag: "human-steer",
  id,
  targetLineageId: "fixture-coordinator",
  delivery: "steer",
  payload: { kind: "Message", body: id },
  provenance: { sourceRunId: "request", sourceLineageId: "request", sourceTurn: 0, sourceActor: "human:fixture" }
})
const input = { prompt: "Keep the requested behavior", feedback: "Keep the verifier", maxRounds: 2 }

/** Real flow engine/interpreter with explicitly scripted child work. These
 * tests check coordination, not native JJ, notification routing or model quality. */
const fixture = (
  arrivals: (boundary: string, revision: number) => ReadonlyArray<string>,
  stale = false,
  pocMutates = false
) => {
  const events: string[] = [], feedback: string[] = []
  let plans = 0, implementations = 0, prototypes = 0
  let head = revision("initial")
  const registration = Layer.effectDiscard(Effect.gen(function*() {
    const runtime = yield* FlowRuntime.FlowRuntime
    yield* runtime.register(PrepareRequest, (value) =>
      Effect.sync((): Plan => {
        events.push(`plan:${plans++}`)
        feedback.push(value.feedback)
        return {
          prompt: value.prompt,
          memoryRevision: `memory-${plans}`,
          base: head,
          observedHead: head,
          changes: [{
            id: "requested",
            title: "Requested",
            intent: "Apply request",
            implementation: "fixture/implement",
            implementationDigest: "0".repeat(64),
            checks: [],
            atoms: [{
              changeId: null,
              message: "✨ feat: apply request",
              intent: "Apply request",
              reads: [],
              writes: ["hello.txt"]
            }]
          }]
        }
      }))
    yield* runtime.register(Poc, (value) =>
      Effect.sync(() => {
        events.push("poc")
        prototypes++
        if (pocMutates) head = revision("unexpected-poc-mutation")
        return {
          status: "drafted-unvalidated" as const,
          source: value.source,
          changes: {
            sourceDigest: "source",
            transactionBase: "scratch",
            files: [],
            preview: { mediaType: "text/html" as const, content: "" }
          },
          findings: ["Try the compact layout"],
          feedback: "POC evidence: compact layout"
        }
      }))
    yield* runtime.register(CorrectPlan, (value) =>
      Effect.sync(() => {
        assert.deepEqual(value.plan.observedHead, head)
        events.push(`implement:${implementations++}`)
        head = revision(`implemented-${implementations}`)
        return {
          status: "validated" as const,
          rounds: 1,
          blocked: null,
          result: { status: "validated" as const, changes: [], findings: [] }
        }
      }))
  }))
  const layer = Layer.mergeAll(
    requestRegistration,
    todoLayers(Evaluator.layerScripted(() => ({ route: { choice: "implement" } }))),
    prototypeRegistration,
    registration,
    PrepareStackBase.toLayer(({ base }) =>
      Effect.sync(() => {
        events.push(`base:${base.commitId.slice(0, 4)}`)
        return {
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
        }
      })
    ),
    CreateStackBase.toLayer(({ base }) =>
      Effect.sync(() => {
        head = { ...revision("working"), parentCommitIds: [base.commitId] }
        return head
      })
    ),
    AdmitSource.toLayer(({ plan }) =>
      Effect.gen(function*() {
        events.push("admit")
        if (stale) {
          return yield* Effect.fail(new CodingError({ code: "stale_revision", message: "fixture source moved" }))
        }
        if (plan.observedHead?.commitId !== head.commitId) {
          return yield* Effect.fail(
            new CodingError({ code: "stale_revision", message: "fixture POC changed original source" })
          )
        }
        return { ...plan, observedHead: head }
      })
    ),
    ReceiveFeedback.toLayer(({ boundary, revision }) =>
      Effect.sync(() => {
        events.push(`${boundary}:${revision}`)
        return { boundary: JSON.stringify([boundary, revision]), messages: arrivals(boundary, revision).map(message) }
      })
    )
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )
  return {
    host: ManagedRuntime.make(layer),
    events,
    feedback,
    counts: () => ({ plans, implementations, prototypes }),
    head: () => head
  }
}

test("a stack request stands on the tip before it plans", { timeout: 60_000 }, async (t) => {
  const f = fixture(() => [])
  t.after(() => f.host.dispose())
  const tip = "a".repeat(40)
  const base = { commitId: tip, ref: `refs/smithers/workspaces/11111111-1111-4111-a111-111111111111/sources/${tip}` }
  const result = await f.host.runPromise(Request.execute({ ...input, base }, { executionId: "request-stack" }))
  assert.equal(result.outcome.status, "validated")
  assert.deepEqual(f.events.slice(0, 2), ["base:aaaa", "plan:0"])
})

test(
  "a real fix plans once, retains the original constraints and never requires a POC",
  { timeout: 60_000 },
  async (t) => {
    const f = fixture(() => [])
    t.after(() => f.host.dispose())
    const result = await f.host.runPromise(Request.execute(input, { executionId: "request-one" }))
    assert.deepEqual(f.counts(), { plans: 1, implementations: 1, prototypes: 0 })
    assert.equal(f.feedback[0], input.feedback)
    assert.equal(result.outcome.status, "validated")
    assert.deepEqual(f.events, [
      "plan:0",
      "admit",
      "before-implementation:0",
      "admit",
      "implement:0",
      "after-correction:0"
    ])
    // Completed replay must not repeat a drain, plan or mutation.
    const before = [...f.events]
    assert.deepEqual(await f.host.runPromise(Request.execute(input, { executionId: "request-one" })), result)
    assert.deepEqual(f.events, before)
  }
)

test("feedback received while planning replans before mutation and feedback during correction uses the new source", {
  timeout: 60_000
}, async (t) => {
  const f = fixture((boundary, revision) =>
    boundary === "before-implementation" && revision === 0 ?
      ["Keep keyboard navigation"]
      : boundary === "after-correction" && revision === 1
      ? ["Now improve the labels"]
      : []
  )
  t.after(() => f.host.dispose())
  const result = await f.host.runPromise(Request.execute(input, { executionId: "request-steered" }))
  assert.deepEqual(f.counts(), { plans: 3, implementations: 2, prototypes: 0 })
  assert(f.events.indexOf("plan:1") < f.events.indexOf("implement:0"))
  assert(f.events.indexOf("after-correction:1") < f.events.indexOf("plan:2"))
  for (const text of [input.feedback, "Keep keyboard navigation", "Now improve the labels"]) {
    assert(f.feedback[2]!.includes(text))
  }
  assert.equal(result.plan.observedHead!.commitId, "commit-implemented-1")
  assert.equal(f.head().commitId, "commit-implemented-2")
})

test("continually arriving feedback stops at a recorded bounded refusal without implementing a stale plan", {
  timeout: 60_000
}, async (t) => {
  const f = fixture((boundary, revision) => boundary === "before-implementation" ? [`revision-${revision}`] : [])
  t.after(() => f.host.dispose())
  await assert.rejects(
    f.host.runPromise(Request.execute(input, { executionId: "request-bound" })),
    /reached 8 planning passes.*revision-7/
  )
  assert.deepEqual(f.counts(), { plans: 8, implementations: 0, prototypes: 0 })
  assert.equal(f.events.at(-1), "before-implementation:7")
})

test("a changed prepared source refuses before implementation", { timeout: 60_000 }, async (t) => {
  const f = fixture(() => [], true)
  t.after(() => f.host.dispose())
  await assert.rejects(
    f.host.runPromise(Request.execute(input, { executionId: "request-stale" })),
    /fixture source moved/
  )
  assert.deepEqual(f.counts(), { plans: 1, implementations: 0, prototypes: 0 })
})

test(
  "a separately requested POC retains its experiment without starting real implementation",
  { timeout: 60_000 },
  async (t) => {
    const f = fixture(() => [])
    t.after(() => f.host.dispose())
    const result = await f.host.runPromise(Prototype.execute(input, { executionId: "explicit-prototype" }))
    assert.equal(result.status, "drafted-unvalidated")
    assert.deepEqual(f.counts(), { plans: 1, implementations: 0, prototypes: 1 })
    assert.deepEqual(f.events, ["plan:0", "admit", "poc", "admit"])
  }
)

test("the post-POC source check runs after the prototype and prevents replanning over its unexpected mutation", {
  timeout: 60_000
}, async (t) => {
  const f = fixture(() => [], false, true)
  t.after(() => f.host.dispose())
  await assert.rejects(
    f.host.runPromise(Prototype.execute(input, { executionId: "request-poc-mutated" })),
    /fixture POC changed original source/
  )
  assert.deepEqual(f.counts(), { plans: 1, implementations: 0, prototypes: 1 })
  assert.deepEqual(f.events, ["plan:0", "admit", "poc", "admit"])
})
