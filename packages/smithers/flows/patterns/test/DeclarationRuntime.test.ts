import { Action, Flow as RuntimeFlow } from "@smthrs/flow"
import * as PlanNode from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Bounded from "../src/Bounded.ts"
import * as CheckSuite from "../src/CheckSuite.ts"
import * as Debate from "../src/Debate.ts"
import * as DelegationChain from "../src/DelegationChain.ts"
import * as DriftDetector from "../src/DriftDetector.ts"
import * as Escalation from "../src/Escalation.ts"
import * as Kanban from "../src/Kanban.ts"
import * as Loop from "../src/Loop.ts"
import * as MapReduce from "../src/MapReduce.ts"
import * as MergeQueue from "../src/MergeQueue.ts"
import * as ReviewLoop from "../src/ReviewLoop.ts"
import * as ScanFixVerify from "../src/ScanFixVerify.ts"
import * as Sidecar from "../src/Sidecar.ts"
import * as Supervisor from "../src/Supervisor.ts"
import * as Trellis from "../src/Trellis.ts"
import * as TryCatchFinally from "../src/TryCatchFinally.ts"
import { execute, member } from "./Execute.ts"

// Every field any pattern in this file hands a member, as the one struct a
// `@smthrs/flow` flow states. A member declares the payload it takes, so one
// shared struct covers every field any pattern in this file supplies.
const stageFields = {
  phase: Schema.optional(Schema.Unknown),
  input: Schema.optional(Schema.Unknown),
  iteration: Schema.optional(Schema.Unknown),
  issue: Schema.optional(Schema.Unknown),
  index: Schema.optional(Schema.Unknown),
  issues: Schema.optional(Schema.Unknown),
  fixes: Schema.optional(Schema.Unknown),
  task: Schema.optional(Schema.Unknown),
  round: Schema.optional(Schema.Unknown),
  rounds: Schema.optional(Schema.Unknown),
  plan: Schema.optional(Schema.Unknown),
  review: Schema.optional(Schema.Unknown),
  retriable: Schema.optional(Schema.Unknown),
  results: Schema.optional(Schema.Unknown),
  goal: Schema.optional(Schema.Unknown),
  seat: Schema.optional(Schema.Unknown),
  path: Schema.optional(Schema.Unknown),
  previous: Schema.optional(Schema.Unknown),
  value: Schema.optional(Schema.Unknown),
  baseline: Schema.optional(Schema.Unknown),
  snapshot: Schema.optional(Schema.Unknown),
  comparison: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  level: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  prompt: Schema.optional(Schema.Unknown),
  leaves: Schema.optional(Schema.Unknown),
  stage: Schema.optional(Schema.Unknown),
  leaf: Schema.optional(Schema.Unknown),
  tier: Schema.optional(Schema.Unknown),
  budget: Schema.optional(Schema.Unknown),
  deriskExhausted: Schema.optional(Schema.Unknown)
}

const stage = (tag: string, answer: (payload: any) => unknown) => member(tag, answer, stageFields)

// A review whose verdict changes between rounds is a RUN-time fact, so it is
// an action rather than a flow body: a body builds once, while the graph is
// planned.
const scriptedReview = Action.make("declaration/review", {
  payload: Schema.Struct({ round: Schema.Number }),
  success: Schema.Unknown,
  error: Schema.Never,
  tier: "irreversible"
})

// The ported patterns execute through `@smthrs/flow`'s interpreter over the
// in-memory engine. The observable results are the ones the core evaluator
// produced; what changed is which runtime produced them.
describe("ported pattern declaration execution", () => {
  it("merges every bounded batch into one record in declaration order", async () => {
    const batched = RuntimeFlow.make("bounded/host", {
      payload: { input: Schema.Unknown },
      success: Schema.Unknown,
      error: Schema.Unknown,
      body: () =>
        Bounded.all({
          a: PlanNode.succeed("a"),
          b: PlanNode.succeed("b"),
          c: PlanNode.succeed("c")
        }, { concurrency: 1 })
    })

    expect(await execute(batched, { input: undefined }, "bounded-batches")).toEqual({ a: "a", b: "b", c: "c" })
  })

  it("hands each debate round the transcript the rounds before it produced", async () => {
    const roles = { input: Schema.Unknown, transcript: Schema.Unknown, proponent: Schema.Unknown }
    const proponent = RuntimeFlow.make("proponent", {
      payload: roles,
      success: Schema.Unknown,
      error: Schema.Unknown,
      body: ({ transcript }) => PlanNode.succeed(`p${(transcript as ReadonlyArray<unknown>).length}`)
    })
    // The proponent's answer is a planned reference while the graph builds, so
    // the opponent computes on it at RUN time through `Node.map` instead.
    const opponent = RuntimeFlow.make("opponent", {
      payload: roles,
      success: Schema.Unknown,
      error: Schema.Unknown,
      body: ({ proponent }) => PlanNode.map(PlanNode.succeed(proponent), (value) => `o:${String(value)}`)
    })
    const judge = RuntimeFlow.make("judge", {
      payload: roles,
      success: Schema.Unknown,
      error: Schema.Unknown,
      body: ({ transcript }) => PlanNode.succeed(transcript)
    })

    expect(await execute(Debate.make({ proponent, opponent, judge, rounds: 2 }), { input: "topic" }, "debate")).toEqual(
      [
        { proponent: "p0", opponent: "o:p0" },
        { proponent: "p1", opponent: "o:p1" }
      ]
    )
  })

  it("reduces every check row to one verdict in declaration order", async () => {
    const check = member("check", (payload: { readonly check: string }) => ({ ok: payload.check !== "typecheck" }), {
      check: Schema.Unknown,
      input: Schema.Unknown
    })

    expect(
      await execute(
        CheckSuite.make({
          checks: { lint: check, typecheck: check, test: check },
          strategy: "all-pass",
          concurrency: 1,
          continueOnFail: false
        }),
        { input: "head" },
        "checksuite-verdict"
      )
    ).toEqual({
      passed: ["lint", "test"],
      failed: ["typecheck"],
      errors: {},
      strategy: "all-pass",
      verdict: false
    })
  })

  it("keys a board by item id in declaration order", async () => {
    const card = member("card", (payload: { readonly item: { readonly id: string } }) => payload.item.id, {
      column: Schema.Unknown,
      item: Schema.Unknown,
      previous: Schema.Unknown
    })
    const board = await execute(
      Kanban.make({
        columns: [{ name: "build", flow: card }],
        items: [{ id: "a" }, { id: "b" }, { id: "c" }],
        concurrency: 1
      }),
      { input: "sprint" },
      "kanban-board-keys"
    ) as Record<string, unknown>

    expect(Object.keys(board.board as object)).toEqual(["a", "b", "c"])
    expect(board.completed).toEqual(["a", "b", "c"])
  })

  it("hands a successful body back after the finalizer ran", async () => {
    const attempt = member("attempt", () => "value", { input: Schema.Unknown, error: Schema.optional(Schema.Unknown) })
    const finalizer = member("finalizer", () => "cleaned", {
      input: Schema.Unknown,
      error: Schema.optional(Schema.Unknown)
    })

    expect(
      await execute(
        TryCatchFinally.make({ try: attempt, finally: finalizer }),
        { input: "input" },
        "trycatchfinally-success"
      )
    ).toBe("value")
  })

  it("scores a sidecar's pair and reports the measured delta", async () => {
    const fields = {
      input: Schema.Unknown,
      primary: Schema.optional(Schema.Unknown),
      shadow: Schema.optional(Schema.Unknown)
    }
    const primary = member("primary", () => "expensive", fields)
    const shadow = member("shadow", () => "cheap", fields)
    const score = member("score", () => ({ primary: 0.8, shadow: 0.5 }), fields)

    expect(await execute(Sidecar.make({ primary, shadow, score }), { input: "prompt" }, "sidecar-delta")).toEqual({
      primary: "expensive",
      shadow: { quarantined: false, value: "cheap" },
      delta: { primary: 0.8, shadow: 0.5, difference: 0.3, cheaperWins: false }
    })
  })

  it("keys a batched merge queue's landings by member id", async () => {
    const land = member("land", (payload: { readonly id: string }) => payload.id, {
      id: Schema.Unknown,
      position: Schema.Unknown,
      input: Schema.Unknown
    })

    expect(
      await execute(
        MergeQueue.make({
          members: [
            { id: "a", flow: land },
            { id: "b", flow: land },
            { id: "c", flow: land }
          ],
          concurrency: 2,
          failurePolicy: "quarantine"
        }),
        { input: "main" },
        "mergequeue-batched"
      )
    ).toEqual({
      landed: [{ id: "a", output: "a" }, { id: "b", output: "b" }, { id: "c", output: "c" }],
      quarantined: [],
      order: ["a", "b", "c"]
    })
  })

  it("hands the reducer every mapped value in ordinal shard order", async () => {
    const map = member("map", (payload: { readonly index: number }) => payload.index, {
      shard: Schema.Unknown,
      index: Schema.Unknown,
      input: Schema.Unknown
    })
    const reduce = member("reduce", (payload: { readonly mapped: unknown }) => payload.mapped, {
      input: Schema.Unknown,
      mapped: Schema.Unknown
    })

    expect(
      await execute(
        MapReduce.make({ map, reduce, concurrency: 2, onEmpty: "reduce" }),
        { shards: ["c", "a", "b"] },
        "mapreduce-small"
      )
    ).toEqual([0, 1, 2])

    // Cross the lexical "shard-10"/"shard-2" boundary both within one batch
    // and across batches; the reducer always receives ordinal shard order.
    const many = Array.from({ length: 15 }, (_, index) => index)
    for (const concurrency of [4, 15]) {
      expect(
        await execute(
          MapReduce.make({ map, reduce, concurrency, onEmpty: "reduce" }),
          { shards: many },
          `mapreduce-${concurrency}`
        )
      ).toEqual(many)
    }
  })

  it("settles a bounded loop with its value, iteration count, and exhaustion", async () => {
    const step = member("loop-body", (payload: { readonly iteration: number }) => `round-${payload.iteration}`, {
      input: Schema.Unknown,
      previous: Schema.optional(Schema.Unknown),
      iteration: Schema.Unknown
    })
    const never = member("loop-until", () => false, { value: Schema.Unknown, iteration: Schema.Unknown })

    expect(await execute(Loop.make({ body: step, until: never, maxIterations: 2 }), { input: "seed" }, "loop-bound"))
      .toEqual({ value: "round-2", iterations: 2, exhausted: true })
  })

  it("reports the last scan's issues, verdict, and verification when the retry bound is reached", async () => {
    const scan = member("scan", () => ["a", "b", "c"], stageFields)
    const fix = member("fix", (payload: { readonly index: number }) => payload.index, stageFields)
    const verify = member("verify", () => "checked", stageFields)

    expect(
      await execute(
        ScanFixVerify.make({ scan, fix, verify, maxRetries: 1, maxIssues: 3, concurrency: 2 }),
        { input: "tree" },
        "scanfixverify-bound"
      )
    ).toEqual({
      iterations: 1,
      remaining: ["a", "b", "c"],
      resolved: false,
      verifications: ["checked"]
    })
  })

  it("keys a supervision's outcomes by task id across its concurrency batches", async () => {
    const plan = member("plan", () => "plan", stageFields)
    const worker = member("worker", (payload: { readonly task: { readonly id: string } }) => payload.task.id, {
      ...stageFields,
      task: Schema.Unknown
    })
    const review = member("review", () => true, stageFields)
    const finalize = member("finalize", (payload: { readonly results: unknown }) => payload.results, stageFields)

    expect(
      await execute(
        Supervisor.make({
          plan,
          workers: { coder: worker },
          review,
          finalize,
          maxRounds: 1,
          maxTasks: 16,
          concurrency: 2
        }),
        {
          input: {
            tasks: [
              { id: "a", workerType: "coder" },
              { id: "b", workerType: "coder" },
              { id: "c", workerType: "coder" }
            ]
          }
        },
        "supervisor-outcomes"
      )
    ).toEqual({
      exhausted: false,
      rounds: 1,
      final: ["a", "b", "c"].map((id) => ({ _tag: "Done", id, workerType: "coder", round: 1, output: id }))
    })
  })

  it("takes the supervision's second round when the first review is not done", async () => {
    const plan = member("plan", () => "plan", stageFields)
    const worker = member("worker", (payload: { readonly task: { readonly id: string } }) => payload.task.id, {
      ...stageFields,
      task: Schema.Unknown
    })
    // The member's body IS the action call: `member` wraps its answer in
    // `Node.succeed`, and a node is not a value a plan can carry.
    const review = RuntimeFlow.make("scripted-review", {
      payload: stageFields,
      success: Schema.Unknown,
      error: Schema.Unknown,
      body: (payload: { readonly round?: unknown }) => scriptedReview.call({ round: payload.round as number })
    })
    const finalize = member("finalize", (payload: { readonly results: unknown }) => payload.results, stageFields)
    const rounds: Array<number> = []
    const reviewLayer = scriptedReview.toLayer(({ round }) =>
      Effect.sync(() => {
        rounds.push(round)
        return round === 1 ? { retriable: ["a"] } : true
      })
    )

    const settled = await execute(
      Supervisor.make({
        plan,
        workers: { coder: worker },
        review,
        finalize,
        maxRounds: 2,
        maxTasks: 16,
        concurrency: 1
      }),
      { input: { tasks: [{ id: "a", workerType: "coder" }] } },
      "supervisor-second-round",
      reviewLayer
    )

    expect(rounds).toEqual([1, 2])
    expect(settled).toEqual({
      exhausted: false,
      rounds: 2,
      final: [{ _tag: "Done", id: "a", workerType: "coder", round: 2, output: "a" }]
    })
  })

  it("compiles a plan's parallel members in plan order and its sequence in sequence order", async () => {
    const leaf = member("leaf", (payload: Trellis.Leaf) => payload.goal, stageFields)
    const compiled = (plan: Trellis.Plan, tag: string) =>
      RuntimeFlow.make(tag, {
        payload: { input: Schema.Unknown },
        success: Schema.Unknown,
        error: Schema.Unknown,
        body: () => Trellis.compile(plan, { leaf })
      })

    expect(
      await execute(
        compiled(
          { parallel: [{ agent: { goal: "zero" } }, { agent: { goal: "one" } }, { agent: { goal: "two" } }] },
          "trellis/parallel"
        ),
        { input: undefined },
        "trellis-parallel"
      )
    ).toEqual(["zero", "one", "two"])
    expect(
      await execute(
        compiled({ sequence: [{ agent: { goal: "first" } }, { agent: { goal: "second" } }] }, "trellis/sequence"),
        { input: undefined },
        "trellis-sequence"
      )
    ).toEqual(["first", "second"])
  })

  it("executes transcript, alert, scoring, and finalizer maps", async () => {
    const capture = stage("capture", () => "snapshot")
    const compare = stage("compare", () => ({ drifted: true }))
    const alert = stage("alert", () => "paged")

    expect(
      await execute(
        DriftDetector.make({ capture, compare, alert, baseline: "before" }),
        { input: "target" },
        "drift"
      )
    ).toEqual({
      snapshot: "snapshot",
      comparison: { drifted: true },
      drifted: true,
      alert: "paged"
    })
  })

  it("takes runtime-only declaration branches from real resolved decisions", async () => {
    const first = stage("first", () => "first")
    const second = stage("second", () => "second")
    const doNotEscalate = stage("do-not-escalate", () => false)
    expect(
      await execute(
        Escalation.make({ rungs: [{ flow: first, escalateIf: doNotEscalate }, second] }),
        { input: "input" },
        "escalation-rung"
      )
    ).toEqual({ level: 0, result: "first", exhausted: false })

    const accept = stage("accept", () => true)
    expect(
      await execute(Escalation.make({ rungs: [first, second], accept }), { input: "input" }, "escalation-accept")
    ).toEqual({
      level: 0,
      result: "first",
      exhausted: false
    })

    const produce = stage("produce", () => "draft")
    const approve = stage("approve", () => ({ approved: true }))
    const revise = stage("revise", () => "revised")
    expect(
      await execute(
        ReviewLoop.make({ produce, review: approve, revise, maxRounds: 2 }),
        { input: "input" },
        "reviewloop"
      )
    ).toEqual({
      _tag: "Approved",
      output: "draft"
    })

    const refine = stage("refine", () => "goal")
    const author = stage("author", () => ({ agent: { goal: "leaf" } }))
    const derisk = stage("derisk", () => ({ approved: true }))
    const chainExecute = stage("execute", () => "output")
    const delegationReview = stage("delegation-review", () => ({ approved: true }))
    const settle = stage("settle", (payload: { readonly leaves: unknown }) => payload.leaves)
    expect(
      await execute(
        DelegationChain.make({
          refine,
          plan: author,
          derisk,
          execute: { weak: chainExecute },
          review: delegationReview,
          settle,
          tierOrder: ["weak"],
          maxDepth: 1,
          maxDeriskRounds: 1,
          maxAttempts: 1
        }),
        { input: "prompt" },
        "delegationchain"
      )
    ).toBe("output")
  })
})
