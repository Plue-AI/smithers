/**
 * A seat-backed completion judge spends inside the run's budget (#2681).
 *
 * `Evaluator.layerFromSeat` streams its seat's model directly, outside the
 * sealed model steps that consult and charge the budget. Its reading is
 * recorded on the completion-judgement boundary with the usage the provider
 * reported, and the run's engine accounts that usage under the boundary's
 * key. So the next primary call is admitted against the judge's spend, and a
 * replayed judgement is charged once. The judge is itself admitted: once the
 * ceiling is spent it is refused under the run's policy (#3010).
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Capability from "@smthrs/capability/Capability"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import { Context, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentAction from "../src/AgentAction.ts"
import * as Budget from "../src/Budget.ts"
import * as QuotaPolicy from "../src/QuotaPolicy.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"
import * as StandardFlows from "../src/StandardFlows.ts"

const Result = Schema.Struct({ summary: Schema.String, keyPoints: Schema.Array(Schema.String) })

const Research = AgentAction.make("judge-budget/Research", {
  payload: { topic: Schema.String },
  output: Result,
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You are a research assistant. Provide concise, accurate summaries."],
  prompt: ({ topic }) => `Research the topic "${topic}" and report what matters about it.`
})

/** Two paid primary calls in sequence, each followed by its completion judge. */
const Twice = Flow.make("judge-budget/Twice", {
  payload: { topic: Schema.String },
  success: Result,
  error: AgentAction.AgentFailure,
  body: ({ topic }) => Node.andThen(Research.call({ topic }), Research.call({ topic }))
})

const prepared: Route.PreparedRequest = {
  routeId: "judge-budget",
  protocolId: "judge-budget",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const answer = { summary: "Durable workflows journal every step.", keyPoints: ["steps are journaled"] }

/** Each primary call answers in one cell and reports five tokens. */
const primary = (calls: { primary: number }): Model.Model =>
  Model.make({
    stream: () => {
      calls.primary++
      return Stream.fromIterable([
        ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
        ModelEvent.ModelEvent.TextDelta({
          type: "text-delta",
          id: "cell",
          text: "```cell\nctx.done(" + JSON.stringify(answer) + ")\n```"
        }),
        ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
        ModelEvent.ModelEvent.Usage({ inputTokens: 3, outputTokens: 2, totalTokens: 5 }),
        ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
      ])
    }
  })

/**
 * The judge reads every claim as done, and reports `tokens` of usage; a
 * `garbled` judge is metered the same and then answers nothing it can decode.
 */
const judge = (calls: { judge: number }, tokens: number, garbled = false): Model.Model =>
  Model.make({
    stream: () => {
      calls.judge++
      return Stream.fromIterable([
        ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "judge" }),
        ModelEvent.ModelEvent.TextDelta({
          type: "text-delta",
          id: "judge",
          text: garbled ? "not a judgment" : JSON.stringify({
            answers: {
              complete: { type: "boolean", probability: 0.99 },
              overclaims: { type: "boolean", probability: 0.01 },
              invented: { type: "boolean", probability: 0 }
            }
          })
        }),
        ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "judge" }),
        ModelEvent.ModelEvent.Usage({
          inputTokens: tokens * 0.9,
          outputTokens: tokens * 0.1,
          totalTokens: tokens
        }),
        ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
      ])
    }
  })

const drive = async (judgeTokens: number, maxTokens: number, garbled = false) => {
  const calls = { primary: 0, judge: 0 }
  const seats = SeatResolver.layer({
    resolve: (id) =>
      Effect.succeed(
        Seat.make({
          id,
          modelId: "test-model",
          model: primary(calls),
          route: { prepare: () => Effect.succeed(prepared) },
          contextWindowTokens: 200_000
        })
      )
  })
  const host = AgentAction.layerHost({
    registry: Registry.makeNoop({
      list: () => Effect.succeed([]),
      visible: () => Effect.succeed([]),
      getOption: () => Effect.succeed(Option.none())
    }),
    limits: { calls: 8 },
    capabilityEnvelope: [],
    maxFrames: 4
  })
  const layer = Layer.mergeAll(Research.layer, Interpreter.layer(Twice)).pipe(
    Layer.provideMerge(Layer.mergeAll(host, seats, Agent.layer)),
    Layer.provideMerge(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layer({ tokens: { max: maxTokens } }))),
    Layer.provideMerge(Agent.layerDefaults),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )
  return Effect.runPromise(
    Effect.gen(function*() {
      const exit = yield* Effect.exit(Twice.execute({ topic: "durable workflows" }, { executionId: "judge-budget-1" }))
      const budget = yield* Budget.Budget
      const ledger = yield* budget.usageOf("judge-budget-1")
      return { exit, ledger, calls: { ...calls } }
    }).pipe(
      Effect.provide(layer),
      Effect.provide(Evaluator.layerFromSeat({ modelId: "judge-model", model: judge(calls, judgeTokens, garbled) })),
      Effect.orDie
    )
  )
}

describe("a seat-backed completion judge under a run budget", () => {
  it("charges the judge's reading, so the next primary call is refused once the ceiling is spent", async () => {
    const { calls, exit, ledger } = await drive(100, 25)
    // The first action's primary call (5) and its judge (100) both land in
    // the ledger; the second primary call is not admitted against 105 > 25.
    expect(calls).toEqual({ primary: 1, judge: 1 })
    expect(ledger.tokens).toBe(105)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("BudgetExceeded")
  })

  it("charges a judge that reported nothing as nothing, and admits every call under the ceiling", async () => {
    const { calls, exit, ledger } = await drive(0, 25)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(calls).toEqual({ primary: 2, judge: 2 })
    expect(ledger.tokens).toBe(10)
  })

  it("does not judge a completion whose primary call spent the whole ceiling (#3010)", async () => {
    const { calls, exit, ledger } = await drive(100, 4)
    // The first primary call is admitted before any cost is known and spends
    // 5 of 4 tokens; its judge is refused before it is asked, under `fail`.
    expect(calls).toEqual({ primary: 1, judge: 0 })
    expect(ledger.tokens).toBe(5)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("BudgetExceeded")
  })

  it("charges a judge that was metered and then answered nothing it could decode (#3010)", async () => {
    const { calls, exit, ledger } = await drive(100, 1_000, true)
    // The completion goes unjudged and ends the run, but its reading was paid.
    expect(calls).toEqual({ primary: 1, judge: 1 })
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(
      "A completion no evaluator could judge (invalid_answer)"
    )
    expect(ledger.tokens).toBe(105)
  })

  it("charges every judge once when the ceiling allows the whole run", async () => {
    const { calls, exit, ledger } = await drive(100, 1_000)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(calls).toEqual({ primary: 2, judge: 2 })
    expect(ledger.tokens).toBe(210)
  })
})

/** A primary model that answers each call with the next cell, reporting five tokens per call. */
const cells = (calls: { primary: number }, bodies: ReadonlyArray<string>): Model.Model =>
  Model.make({
    stream: () => {
      const body = bodies[Math.min(calls.primary, bodies.length - 1)]!
      calls.primary++
      return Stream.fromIterable([
        ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
        ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + body + "\n```" }),
        ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
        ModelEvent.ModelEvent.Usage({ inputTokens: 3, outputTokens: 2, totalTokens: 5 }),
        ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
      ])
    }
  })

const OneAction = Flow.make("judge-budget/OneAction", {
  payload: { topic: Schema.String },
  success: Result,
  error: AgentAction.AgentFailure,
  body: ({ topic }) => Research.call({ topic })
})

/**
 * A run whose cell asks the `jev` flow one question, then answers. The flow's
 * judge reports 100 tokens on `jev-model` per reading; the completion judge
 * reports nothing.
 */
const driveJev = async (maxTokens: number) => {
  const calls = { primary: 0, judge: 0, jev: 0 }
  const jev = Context.make(
    Evaluator.Evaluator,
    Evaluator.Evaluator.of({
      evaluate: () =>
        Effect.sync(() => {
          calls.jev++
          return {
            answers: { q: { type: "boolean" as const, probability: 0.9 } },
            latencyMs: 0,
            usage: { inputTokens: 90, outputTokens: 10, modelId: "jev-model" }
          }
        })
    })
  )
  const seats = SeatResolver.layer({
    resolve: (id) =>
      Effect.succeed(
        Seat.make({
          id,
          modelId: "test-model",
          model: cells(calls, [
            "const judged = await ctx.call(\"jev\", { state: { a: 1 }, questions: { q: { type: \"boolean\", instructions: \"Is a set?\" } } })\nconsole.log(JSON.stringify(judged))",
            "ctx.done(" + JSON.stringify(answer) + ")"
          ]),
          route: { prepare: () => Effect.succeed(prepared) },
          contextWindowTokens: 200_000
        })
      )
  })
  const host = AgentAction.layerHost({
    registry: Registry.makeNoop({
      list: () => Effect.succeed([]),
      visible: () => Effect.succeed([]),
      getOption: () => Effect.succeed(Option.none())
    }),
    limits: { calls: 8 },
    capabilityEnvelope: [new Capability.CapabilityPattern({ action: "model:call", resource: Evaluator.defaultModel })],
    maxFrames: 4,
    flows: [StandardFlows.jev(jev)]
  })
  const layer = Layer.mergeAll(Research.layer, Interpreter.layer(OneAction)).pipe(
    Layer.provideMerge(Layer.mergeAll(host, seats, Agent.layer)),
    Layer.provideMerge(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layer({ tokens: { max: maxTokens } }))),
    Layer.provideMerge(Agent.layerDefaults),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )
  return Effect.runPromise(
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        OneAction.execute({ topic: "durable workflows" }, { executionId: "jev-budget-1" })
      )
      const ledger = yield* (yield* Budget.Budget).usageOf("jev-budget-1")
      return { exit, ledger, calls: { ...calls } }
    }).pipe(
      Effect.provide(layer),
      Effect.provide(Evaluator.layerFromSeat({ modelId: "judge-model", model: judge(calls, 0) })),
      Effect.orDie
    )
  )
}

describe("a cell's own jev reading under a run budget (#3010)", () => {
  it("charges the flow's reading to the run, once", async () => {
    const { calls, exit, ledger } = await driveJev(1_000)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(calls).toMatchObject({ primary: 2, jev: 1 })
    // Two primary calls at 5 and the jev reading at 100; the harness's own
    // readings reported nothing.
    expect(ledger.tokens).toBe(110)
  })

  it("takes no reading once the ceiling is spent, and the run stops at its next primary call", async () => {
    const { calls, exit, ledger } = await driveJev(5)
    expect(calls.jev).toBe(0)
    expect(calls.primary).toBe(1)
    expect(ledger.tokens).toBe(5)
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("BudgetExceeded")
  })
})
