/**
 * Token and latency budgets across a run's model calls.
 *
 * The sandbox bounds one cell and `maxFrames` bounds one loop, but nothing
 * accumulated what a run had spent across its steps, so an approved envelope
 * that says "this plan may spend a million tokens" bound nothing at all. These
 * cases cover the accumulator and the three things a composition can ask for
 * when a budget runs out: fail the step, warn and continue, or stop making
 * model calls at all.
 *
 * Two things carry the accumulator across a restart, and neither is a replay
 * of the step body. The engine resumes a run from its recorded NODE results
 * and never re-enters a settled step, so the budget writes what each call cost
 * on the journal's durable channel and PROJECTS that ledger back the first
 * time a run asks it anything. Keying by the model step's own content key is
 * what makes the projection safe: a recovered record and the live call it
 * describes are one key, so a call is never counted twice.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, DurableClock, Flow, FlowRuntime, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Journal, JournalEvent, Redaction } from "@smthrs/journal"
import * as Jj from "@smthrs/kernel/Jj"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import { Cause, Clock, Effect, Exit, Fiber, Latch, Layer, Option, Schedule, Schema, Stream } from "effect"
import type * as Crypto from "effect/Crypto"
import * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentAction from "../src/AgentAction.ts"
import * as Budget from "../src/Budget.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as QuotaPolicy from "../src/QuotaPolicy.ts"
import { layer as scriptedCompletionJudge } from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

const answering = (output: string): string => `ctx.done(${JSON.stringify(output)})`

/** A cell that spends a frame without finishing, so the run makes a second call. */
const thinking = `console.log("still reading")`

/**
 * A model that reports the same usage on every call and answers with one
 * scripted cell per call.
 */
const spending = (
  tokensPerCall: number,
  cells: ReadonlyArray<string>,
  calls: Array<string>
): Model.Model => {
  let index = 0
  return Model.make({
    stream: () =>
      Stream.suspend(() => {
        calls.push("call")
        const source = cells[index] ?? cells.at(-1)!
        index++
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: `cell-${index}` }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: `cell-${index}`,
            text: "```cell\n" + source + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: `cell-${index}` }),
          ModelEvent.ModelEvent.Usage({ totalTokens: tokensPerCall }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })
}

const emptyRegistry: Registry.Registry = Registry.makeNoop({
  list: () => Effect.succeed([]),
  visible: () => Effect.succeed([]),
  getOption: () => Effect.succeed(Option.none())
})

const host: AgentAction.Host = {
  registry: emptyRegistry,
  limits: { calls: 8 },
  capabilityEnvelope: [],
  maxFrames: 4,
  modelRetryPolicy: Schedule.recurs(0)
}

const seats = (model: Model.Model): Layer.Layer<SeatResolver.SeatResolver> =>
  SeatResolver.layer({
    resolve: (id) =>
      Effect.succeed(Seat.make({ id, modelId: Seat.modelIdOf(id), model, route, contextWindowTokens: 200_000 }))
  })

const Review = Schema.Struct({ approved: Schema.Boolean })

const First = AgentAction.make("agent/test/budget/First", {
  payload: { diff: Schema.String },
  output: Review,
  seat: "anthropic:test-model",
  prompt: ({ diff }) => `Review this diff:\n${diff}`
})

const Second = AgentAction.make("agent/test/budget/Second", {
  payload: { diff: Schema.String },
  output: Review,
  seat: "anthropic:test-model",
  prompt: ({ diff }) => `Review this diff again, differently:\n${diff}`
})

const OneStep = Flow.make("agent/test/budget/OneStep", {
  payload: { diff: Schema.String },
  success: Review,
  error: AgentAction.AgentFailure,
  body: ({ diff }) => First.call({ diff })
})

/**
 * Two model-backed steps with a DURABLE park between them.
 *
 * The park is the point of the flow. A budget's numbers are the same on both
 * sides of a restart, so a run that reaches a refusing check before the kill
 * would have refused before the kill too, and no such case can show that the
 * projection is what refused. This one stops the run in the one window where
 * the projection is the only thing that carries the spend across: after the
 * first step's node settled — the engine never re-enters it — and before the
 * second step has asked the budget anything.
 */
const Pause = Action.make("agent/test/budget/Pause", {
  payload: { id: Schema.String },
  success: Schema.String,
  error: AgentAction.AgentFailure
})

const pausing = Pause.toLayer(() =>
  Action.make({
    name: "agent/test/budget/Pause/durable",
    success: Schema.String,
    error: AgentAction.AgentFailure,
    execute: DurableClock.sleep({
      name: "budget/boundary",
      duration: "2 seconds",
      // Below the default threshold a sleep is an in-memory action, which
      // parks nothing and cannot be killed between the steps.
      inMemoryThreshold: 1
    }).pipe(Effect.as("parked"))
  })
)

const ParkedSteps = Flow.make("agent/test/budget/ParkedSteps", {
  payload: { diff: Schema.String },
  success: Review,
  error: AgentAction.AgentFailure,
  // A frame now records its catalog before asking the budget. That extra
  // boundary can reach the default 1.5x polling ladder's fractional delays;
  // TestClock exposes those as fractional wall times, which the journal
  // correctly refuses. Keep this budget fixture's polling on whole millis.
  suspendedRetryPolicy: RetryPolicy.make({ initialMs: 200, factor: 1, maxMs: 200 }),
  body: ({ diff }) =>
    First.call({ diff }).pipe(
      Node.bindPlanned(() => Pause.call({ id: "boundary" })),
      Node.bindPlanned(() => Second.call({ diff }))
    )
})

const TwoSteps = Flow.make("agent/test/budget/TwoSteps", {
  payload: { diff: Schema.String },
  success: Review,
  error: AgentAction.AgentFailure,
  body: ({ diff }) => First.call({ diff }).pipe(Node.bindPlanned(() => Second.call({ diff })))
})

const memory = <ROut, RIn>(
  steps: Layer.Layer<ROut, never, RIn>,
  model: Model.Model,
  budget: Layer.Layer<Budget.Budget, Budget.ConfigurationError>
) =>
  steps.pipe(
    Layer.provideMerge(AgentAction.layerHost(host)),
    Layer.provideMerge(seats(model)),
    Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
    Layer.provideMerge(budget),
    Layer.provideMerge(QuotaPolicy.layerUnclassified()),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

describe("the accumulator", () => {
  it("counts one model step once, however often it is replayed", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const budget = yield* Budget.make({ tokens: { max: 10_000 } })
        yield* budget.record("step-a", { totalTokens: 600 })
        yield* budget.record("step-a", { totalTokens: 600 })
        yield* budget.record("step-b", { inputTokens: 100, outputTokens: 40 })
        return { usage: yield* budget.usage, loose: yield* budget.usageOf(Budget.looseRunId) }
      })
    )

    expect(observed.usage).toEqual({ tokens: 740, calls: 2, largestCall: 600 })
    // Recorded outside any run, so the loose id names the same tally.
    expect(observed.loose).toEqual(observed.usage)
  })

  it("adds the parts when the provider reported no total", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const budget = yield* Budget.make({})
        yield* budget.record("step-a", { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 })
        return yield* budget.usage
      })
    )

    expect(observed.tokens).toBe(17)
  })

  it("counts what a provider left out as nothing, not as a missing number", () => {
    expect(Budget.tokensOf({})).toBe(0)
    expect(Budget.tokensOf({ inputTokens: 3 })).toBe(3)
    // A published total wins over the parts, because a provider that publishes
    // one has already decided what counts.
    expect(Budget.tokensOf({ totalTokens: 10, inputTokens: 3, outputTokens: 4 })).toBe(10)
  })

  it("prices weighted usage from its parts and refuses parts it cannot price", () => {
    const weights = { input: 1, cachedInput: 0.5, output: 3 }
    expect(Budget.tokensOf({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 }, weights)).toBe(14)
    expect(Budget.tokensOf({ inputTokens: 10, outputTokens: 2 }, weights)).toBe(16)
    expect(Budget.tokensOf({ inputTokens: 10 }, weights)).toBeNaN()
    expect(Budget.tokensOf({ inputTokens: 3, cachedInputTokens: 4, outputTokens: 2 }, weights)).toBeNaN()
  })

  it("keeps the durable usage payload wire-compatible", () => {
    const encoded = Schema.encodeSync(Budget.UsageRecord)({ stepKey: "step-a", spent: 640 })

    // Changing this literal is a durable wire-format change to record in
    // CHANGELOG.md, because resumed runs read payloads written by older hosts.
    expect(encoded).toEqual({ stepKey: "step-a", spent: 640 })
  })

  it("survives the journal's own redactor", () => {
    const redact = Redaction.make()
    const encoded = Schema.encodeSync(Budget.UsageRecord)({ stepKey: "step-a", spent: 640 })

    // The cost field is `spent` because the journal's redactor once read a
    // numeric `tokens` as a credential and persisted `"[REDACTED]"` where the
    // number was. It now keeps a numeric `tokens` count, which the envelope's
    // token ceiling needs, and still redacts a textual one.
    expect(redact(encoded)).toEqual(encoded)
    expect(redact({ stepKey: "step-a", tokens: 640 })).toEqual({ stepKey: "step-a", tokens: 640 })
    expect(redact({ stepKey: "step-a", tokens: "640" })).toEqual({
      stepKey: "step-a",
      tokens: Redaction.placeholder
    })
    // The latency zero travels the same channel and is checked with it.
    expect(redact(Schema.encodeSync(Budget.BudgetStartedRecord)({ startedAt: 1_700 }))).toEqual({
      startedAt: 1_700
    })
  })
})

describe("a token budget", () => {
  it("proceeds while the projected next call still fits, and refuses when it does not", async () => {
    const verdicts = await Effect.runPromise(
      Effect.gen(function*() {
        const budget = yield* Budget.make({ tokens: { max: 1_000 } })
        // This advisory check does not reserve. Actual dispatch uses reserve,
        // which holds capacity for the unmeasured first call.
        const first = yield* budget.check(undefined)
        yield* budget.record("step-a", { totalTokens: 600 })
        const second = yield* budget.check(undefined)
        return { first, second }
      })
    )

    expect(verdicts.first._tag).toBe("proceed")
    expect(verdicts.second).toMatchObject({
      _tag: "refuse",
      exceeded: { scope: "tokens", onExceeded: "fail", used: 600, max: 1_000, next: 600 }
    })
  })

  it("lets a step the ledger already counted proceed to its own replay", async () => {
    const verdicts = await Effect.runPromise(
      Effect.gen(function*() {
        const budget = yield* Budget.make({ tokens: { max: 1_000 } })
        yield* budget.record("step-a", { totalTokens: 600 })
        // The step whose spend is already in the ledger. A run killed after its
        // last model call resumes into this exact question, and the honest
        // answer is that the call costs nothing: its result is recorded, the
        // replay pays a provider nothing, and the projection that refuses it is
        // adding an estimate for a call the ledger is already holding.
        const counted = yield* budget.check("step-a")
        // Any other step is refused on the same numbers, which is what makes
        // the verdict attributable at all.
        const next = yield* budget.check("step-b")
        const unnamed = yield* budget.check(undefined)
        return { counted, next, unnamed }
      })
    )

    expect(verdicts.counted._tag).toBe("proceed")
    expect(verdicts.next).toMatchObject({ _tag: "refuse", exceeded: { used: 600, next: 600 } })
    // A caller that names no step gets the projection, because an unnamed call
    // is one the ledger cannot recognize.
    expect(verdicts.unnamed._tag).toBe("refuse")
  })

  it("lets a counted step through a latch that stops every step after it", async () => {
    const verdicts = await Effect.runPromise(
      Effect.gen(function*() {
        const budget = yield* Budget.make({ tokens: { max: 1_000, onExceeded: "skip-remaining" } })
        yield* budget.record("step-a", { totalTokens: 600 })
        const latched = yield* budget.check("step-b")
        return { latched, counted: yield* budget.check("step-a"), next: yield* budget.check("step-c") }
      })
    )

    expect(verdicts.latched).toMatchObject({ _tag: "refuse", exceeded: { onExceeded: "skip-remaining" } })
    // The latch is permanent for every call the run has not already made, and
    // it is not a reason to refuse a call the run already paid for: replaying
    // that step asks no provider anything.
    expect(verdicts.counted._tag).toBe("proceed")
    expect(verdicts.next._tag).toBe("refuse")
  })

  it("warns and keeps going when the composition asked it to", async () => {
    const verdicts = await Effect.runPromise(
      Effect.gen(function*() {
        const budget = yield* Budget.make({ tokens: { max: 1_000, onExceeded: "warn" } })
        yield* budget.record("step-a", { totalTokens: 600 })
        const second = yield* budget.check(undefined)
        yield* budget.record("step-b", { totalTokens: 600 })
        const third = yield* budget.check(undefined)
        return { second, third }
      })
    )

    expect(verdicts.second._tag).toBe("warn")
    // A warning never latches: the run keeps asking and keeps being warned.
    expect(verdicts.third._tag).toBe("warn")
  })

  it("stops every later call once skip-remaining has fired", async () => {
    const verdicts = await Effect.runPromise(
      Effect.gen(function*() {
        const budget = yield* Budget.make({ tokens: { max: 1_000, onExceeded: "skip-remaining" } })
        yield* budget.record("step-a", { totalTokens: 600 })
        const second = yield* budget.check(undefined)
        const third = yield* budget.check(undefined)
        return { second, third }
      })
    )

    expect(verdicts.second).toMatchObject({ _tag: "refuse", exceeded: { onExceeded: "skip-remaining" } })
    // Latched: the third check refuses without any new usage at all.
    expect(verdicts.third).toMatchObject({ _tag: "refuse", exceeded: { onExceeded: "skip-remaining" } })
  })

  it("keeps the first token refusal's numbers on every latched verdict", async () => {
    const verdicts = await Effect.runPromise(
      Effect.gen(function*() {
        const budget = yield* Budget.make({ tokens: { max: 100, onExceeded: "skip-remaining" } })
        yield* budget.record("step-a", { totalTokens: 60 })
        const first = yield* budget.check("step-b")
        const second = yield* budget.check("step-c")
        const third = yield* budget.check("step-d")
        return { first, second, third }
      })
    )

    expect(verdicts.first).toMatchObject({
      _tag: "refuse",
      exceeded: { scope: "tokens", onExceeded: "skip-remaining", used: 60, max: 100, next: 60 }
    })
    const firstExceeded = (verdicts.first as { readonly exceeded: Budget.BudgetExceeded }).exceeded
    expect((verdicts.second as { readonly exceeded: Budget.BudgetExceeded }).exceeded).toEqual(firstExceeded)
    expect((verdicts.third as { readonly exceeded: Budget.BudgetExceeded }).exceeded).toEqual(firstExceeded)
  })
})

describe("a latency budget", () => {
  it("refuses a call that starts after the run's wall-clock ceiling", async () => {
    const verdicts = await Effect.runPromise(
      Effect.gen(function*() {
        const budget = yield* Budget.make({ latency: { maxMillis: 5_000 } })
        const early = yield* budget.check(undefined)
        yield* TestClock.adjust("6 seconds")
        const late = yield* budget.check(undefined)
        return { early, late }
      }).pipe(Effect.provide(TestClock.layer()))
    )

    expect(verdicts.early._tag).toBe("proceed")
    expect(verdicts.late).toMatchObject({
      _tag: "refuse",
      exceeded: { scope: "latency", max: 5_000 }
    })
  })
})

describe("a budget under a model-backed step", () => {
  it("fails the step with the typed budget failure when the next call would exceed it", async () => {
    const calls: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        OneStep.execute({ diff: "-  old\n+  new" }, { executionId: "budget-fail" }).pipe(
          Effect.provide(
            memory(
              Layer.mergeAll(First.layer, Interpreter.layer(OneStep)),
              spending(600, [thinking, answering(`{"approved":true}`)], calls),
              Budget.layer({ tokens: { max: 1_000 } })
            )
          )
        )
      )
    )

    expect(failureOf(exit)).toMatchObject({
      _tag: "flows/agent/BudgetExceeded",
      scope: "tokens",
      used: 600,
      max: 1_000,
      next: 600
    })
    // One call was made and the second was refused before it was issued.
    expect(calls).toHaveLength(1)
  }, 30_000)

  it("lets the run finish under warn", async () => {
    const calls: Array<string> = []
    const result = await Effect.runPromise(
      OneStep.execute({ diff: "-  old\n+  new" }, { executionId: "budget-warn" }).pipe(
        Effect.provide(
          memory(
            Layer.mergeAll(First.layer, Interpreter.layer(OneStep)),
            spending(600, [thinking, answering(`{"approved":true}`)], calls),
            Budget.layer({ tokens: { max: 1_000, onExceeded: "warn" } })
          )
        )
      )
    )

    expect(result).toEqual({ approved: true })
    expect(calls).toHaveLength(2)
  }, 30_000)

  it("skips every later step's model calls under skip-remaining", async () => {
    const calls: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        TwoSteps.execute({ diff: "-  old\n+  new" }, { executionId: "budget-skip" }).pipe(
          Effect.provide(
            memory(
              Layer.mergeAll(First.layer, Second.layer, Interpreter.layer(TwoSteps)),
              spending(600, [answering(`{"approved":true}`)], calls),
              Budget.layer({ tokens: { max: 1_000, onExceeded: "skip-remaining" } })
            )
          )
        )
      )
    )

    // The skipped step reports `Skipped`, not the `BudgetExceeded` the step
    // that broke the budget reports: an operator has to be able to tell the
    // overspend from what the overspend stopped, and no retry of a skipped
    // step can change its answer.
    expect(failureOf(exit)).toMatchObject({
      _tag: "flows/agent/Skipped",
      budget: { _tag: "flows/agent/BudgetExceeded", onExceeded: "skip-remaining" }
    })
    // The first step answered in one call; the second never reached a provider.
    expect(calls).toHaveLength(1)
  }, 30_000)
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "budget-snapshot" as never, changeId: "budget-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const stores = Layer.mergeAll(
  Layer.sync(DurableEngineState.DurableEngineState)(DurableEngineState.makeMemory),
  StepBoundary.layerTest(),
  Layer.succeed(Jj.Jj)(jj),
  TestStores.layer()
)

const durable = <A, E>(body: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(body, NodeCrypto.layer)).pipe(Effect.orDie))

const warnings = (entries: ReadonlyArray<{ readonly eventType: string; readonly payload: unknown }>) =>
  entries.filter((entry) => entry.eventType === Budget.budgetWarningEvent).map((entry) => entry.payload)

describe("a budget on the durable engine", () => {
  it("journals one warning per call it let through, naming what was spent", async () => {
    const calls: Array<string> = []
    const observed = await durable(
      Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: "budget" },
          journalSource: "budget-test",
          isAlive: () => Effect.succeed(false)
        })
        const wiring = Layer.mergeAll(First.layer, Interpreter.layer(OneStep)).pipe(
          Layer.provideMerge(AgentAction.layerHost(host)),
          Layer.provideMerge(seats(spending(600, [thinking, answering(`{"approved":true}`)], calls))),
          Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
          Layer.provideMerge(Budget.layer({ tokens: { max: 1_000, onExceeded: "warn" } })),
          Layer.provideMerge(QuotaPolicy.layerUnclassified()),
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
        )
        const value = yield* OneStep.execute({ diff: "-  old\n+  new" }, {
          executionId: "budget-journal"
        }).pipe(Effect.provide(wiring))
        const journal = yield* Journal.Journal
        yield* journal.flush
        const page = yield* journal.entries({ runId: "budget-journal" as never, limit: 200 })
        return { value, records: warnings(page.entries) }
      }).pipe(Effect.provide(stores))
    )

    expect(observed.value).toEqual({ approved: true })
    expect(calls).toHaveLength(2)
    expect(observed.records).toHaveLength(1)
    expect(observed.records[0]).toMatchObject({ scope: "tokens", used: 600, max: 1_000, next: 600 })
  }, 60_000)

  it("reports a skipped step as the typed skip, through the action's own encoder", async () => {
    // The memory engine hands a caller the failure instance; the durable
    // engine hands it the ENCODED exit, so a member of `AgentFailure` that
    // cannot be encoded reaches the caller as a union issue naming every
    // member instead of the failure. `Skipped` nests a `BudgetExceeded`, so
    // this is the case that proves the nesting survives.
    const calls: Array<string> = []
    const exit = await durable(
      Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: "budget-skip" },
          journalSource: "budget-skip",
          isAlive: () => Effect.succeed(false)
        })
        const wiring = Layer.mergeAll(First.layer, Second.layer, Interpreter.layer(TwoSteps)).pipe(
          Layer.provideMerge(AgentAction.layerHost(host)),
          Layer.provideMerge(seats(spending(600, [answering(`{"approved":true}`)], calls))),
          Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
          Layer.provideMerge(Budget.layer({ tokens: { max: 1_000, onExceeded: "skip-remaining" } })),
          Layer.provideMerge(QuotaPolicy.layerUnclassified()),
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
        )
        return yield* Effect.exit(
          TwoSteps.execute({ diff: "-  old\n+  new" }, { executionId: "budget-durable-skip" }).pipe(
            Effect.provide(wiring)
          )
        )
      }).pipe(Effect.provide(stores))
    )

    expect(failureOf(exit)).toMatchObject({
      _tag: "flows/agent/Skipped",
      budget: {
        _tag: "flows/agent/BudgetExceeded",
        scope: "tokens",
        onExceeded: "skip-remaining",
        used: 600,
        max: 1_000
      }
    })
    // The first step answered in one call; the second never reached a provider.
    expect(calls).toHaveLength(1)
  }, 60_000)
})

/**
 * A provider that answers, then refuses the second step's first ask with a
 * quota refusal, then answers again. The refusal is what suspends the run so
 * it can be resumed on another engine.
 */
const parkingBetweenSteps = (tokensPerCall: number, calls: Array<string>): Model.Model =>
  Model.make({
    stream: () =>
      Stream.suspend(() => {
        calls.push("call")
        if (calls.length === 2) {
          return Stream.fail(
            new ModelError({
              code: "rate_limited",
              message: "Too many requests",
              retryAfterMillis: 1_000,
              httpStatus: 429
            })
          )
        }
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: "cell",
            text: "```cell\n" + answering(`{"approved":true}`) + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.ModelEvent.Usage({ totalTokens: tokensPerCall }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })

/** Waits for the run to show up in the engine's own view of quota waits. */
const waitForPark = (state: DurableEngineState.Service) =>
  Effect.gen(function*() {
    for (let poll = 0; poll < 400; poll++) {
      const rows = yield* state.waitingRuns({ reason: "quota" })
      if (rows.length > 0) return rows
      yield* Effect.sleep("10 millis")
    }
    return yield* state.waitingRuns({ reason: "quota" })
  })

describe("a budget across an engine boundary", () => {
  it("counts what the run spent before the restart, folded back from the replay", async () => {
    const calls: Array<string> = []
    // The second engine builds a brand-new Budget, and the resumed run never
    // re-enters the settled first step. What makes the pre-restart spend count
    // is the projection: every accounted call left a durable `usage.v1`
    // record, and the new accumulator folds this run's records back before its
    // first decision, deduped by the same content key a live call is folded
    // under.
    const incarnation = (hostId: string) =>
      Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId },
          journalSource: `budget-${hostId}`,
          isAlive: () => Effect.succeed(false)
        })
        return Layer.mergeAll(First.layer, Second.layer, Interpreter.layer(TwoSteps)).pipe(
          Layer.provideMerge(AgentAction.layerHost(host)),
          Layer.provideMerge(seats(parkingBetweenSteps(300, calls))),
          Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
          // A ceiling no part of this run reaches: the assertion is the tally,
          // not a refusal.
          Layer.provideMerge(Budget.layer({ tokens: { max: 5_000 } })),
          Layer.provideMerge(QuotaPolicy.layerDefault()),
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
        )
      })

    const observed = await durable(
      Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        yield* Effect.scoped(
          Effect.gen(function*() {
            const wiring = yield* incarnation("budget-before")
            const running = yield* TwoSteps.execute({ diff: "-  old\n+  new" }, {
              executionId: "budget-boundary"
            }).pipe(Effect.provide(wiring), Effect.forkChild({ startImmediately: true }))
            yield* waitForPark(state)
            yield* Fiber.interrupt(running)
          })
        )
        const callsBefore = calls.length
        return yield* Effect.scoped(
          Effect.gen(function*() {
            const wiring = yield* incarnation("budget-after")
            return yield* Effect.gen(function*() {
              const value = yield* TwoSteps.execute({ diff: "-  old\n+  new" }, {
                executionId: "budget-boundary"
              })
              const budget = yield* Budget.Budget
              // Asked by run id: the tally belongs to the run, not to the
              // service, and the run has finished by the time this reads it.
              return { value, callsBefore, usage: yield* budget.usageOf("budget-boundary") }
            }).pipe(Effect.provide(wiring))
          })
        )
      }).pipe(Effect.provide(stores))
    )

    expect(observed.value).toEqual({ approved: true })
    // Before the restart: the first step answered and the second was refused.
    expect(observed.callsBefore).toBe(2)
    // The second engine's own accumulator holds BOTH steps. Without the fold
    // it would hold only the call it issued itself.
    expect(observed.usage).toEqual({ tokens: 600, calls: 2, largestCall: 300 })
  }, 60_000)
})

/**
 * Runs one body against the shared stores and a TEST clock.
 *
 * The clock is the test's so the durable park between the two steps costs the
 * suite no wall-clock time, and so the resumed run's wake is something the
 * case performs rather than waits for.
 */
const onTestClock = <A, E>(body: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(body, Layer.merge(NodeCrypto.layer, TestClock.layer()))).pipe(Effect.orDie)
  )

/** Advances the test clock until one forked run settles, then joins it. */
const settle = <A, E>(fiber: Fiber.Fiber<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function*() {
    for (let step = 0; step < 60 && fiber.pollUnsafe() === undefined; step++) {
      yield* TestClock.adjust("1 second")
    }
    return yield* Fiber.join(fiber)
  })

/**
 * The timer waits, once the run has parked between its two steps.
 *
 * Yields rather than sleeps: parking costs the run fiber turns, not time, and
 * advancing the clock here would wake the run this case means to kill.
 */
const waitForTimer = (state: DurableEngineState.Service) =>
  Effect.gen(function*() {
    for (let attempt = 0; attempt < 400; attempt++) {
      const rows = yield* state.waitingRuns({ reason: "timer" })
      if (rows.length > 0) return rows
      yield* Effect.yieldNow
    }
    return yield* state.waitingRuns({ reason: "timer" })
  })

/**
 * One question the budget was asked, and the answer it gave.
 *
 * The step key is the whole point. Without it a case can see THAT a resumed run
 * was refused and never WHICH step was refused, and the two candidates report
 * identical numbers: a run of two 600-token steps against a 1,000-token ceiling
 * reports `used: 600, next: 600` whether the refusal landed on the step already
 * in the ledger — which replays for free and must proceed — or on the step that
 * has not been made yet. That is the difference between a budget that stops
 * overspending and one that kills every run resumed after its last model call.
 */
interface Verdict {
  readonly stepKey: string | undefined
  readonly verdict: string
}

/** Wraps a budget so a case can see which step each verdict was about. */
const attributed = (
  policy: Budget.Policy,
  asked: Array<Verdict>,
  counted: Set<string>
): Layer.Layer<Budget.Budget, Budget.ConfigurationError> =>
  Layer.effect(Budget.Budget)(
    Effect.map(Budget.make(policy), (budget) =>
      Budget.Budget.of({
        ...budget,
        reserve: (stepKey) =>
          Effect.tap(
            budget.reserve(stepKey),
            (verdict) => Effect.sync(() => asked.push({ stepKey, verdict: verdict._tag }))
          ),
        record: (stepKey, usage) =>
          Effect.tap(budget.record(stepKey, usage), () => Effect.sync(() => counted.add(stepKey)))
      }))
  )

describe("a budget refusing a resumed run", () => {
  it(
    "refuses the next call from the spend it projected across the boundary, before any provider is asked",
    async () => {
      const calls: Array<string> = []
      // Shared across both incarnations on purpose: what the first one recorded
      // is exactly the ledger the second one recovers, so this is the set of
      // steps the resumed run has already paid for.
      const counted = new Set<string>()
      const before: Array<Verdict> = []
      const after: Array<Verdict> = []
      const incarnation = (hostId: string, asked: Array<Verdict>) =>
        Effect.gen(function*() {
          const engine = yield* EngineStore.make({
            owner: { hostId },
            journalSource: `budget-${hostId}`,
            isAlive: () => Effect.succeed(false)
          })
          return Layer.mergeAll(First.layer, Second.layer, pausing, Interpreter.layer(ParkedSteps)).pipe(
            Layer.provideMerge(AgentAction.layerHost(host)),
            Layer.provideMerge(seats(spending(600, [answering(`{"approved":true}`)], calls))),
            Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
            // 600 spent and 600 projected is 1,200 against a 1,000 ceiling, so
            // the step after the boundary cannot be made — but ONLY if the 600
            // the first incarnation spent is still known.
            Layer.provideMerge(attributed({ tokens: { max: 1_000 } }, asked, counted)),
            Layer.provideMerge(QuotaPolicy.layerUnclassified()),
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
          )
        })

      const observed = await onTestClock(
        Effect.gen(function*() {
          const state = yield* DurableEngineState.DurableEngineState
          yield* Effect.scoped(
            Effect.gen(function*() {
              const wiring = yield* incarnation("refuse-before", before)
              const running = yield* ParkedSteps.execute({ diff: "-  old\n+  new" }, {
                executionId: "budget-refusal"
              }).pipe(Effect.provide(wiring), Effect.forkChild({ startImmediately: true }))
              yield* waitForTimer(state)
              // Killed while parked: the first step's node is settled and the
              // second step has never asked the budget anything.
              yield* Fiber.interrupt(running)
            })
          )
          const callsBefore = calls.length
          const exit = yield* Effect.scoped(
            Effect.gen(function*() {
              const wiring = yield* incarnation("refuse-after", after)
              const resuming = yield* Effect.exit(
                ParkedSteps.execute({ diff: "-  old\n+  new" }, { executionId: "budget-refusal" }).pipe(
                  Effect.provide(wiring)
                )
              ).pipe(Effect.forkChild({ startImmediately: true }))
              return yield* settle(resuming)
            })
          )
          return { callsBefore, exit }
        }).pipe(Effect.provide(stores))
      )

      // One provider call before the kill, costing 600 of the run's 1,000.
      expect(observed.callsBefore).toBe(1)
      // The second engine's budget never saw that call. It refuses on the
      // strength of the ledger alone, and it refuses with the numbers the first
      // incarnation spent.
      expect(failureOf(observed.exit)).toMatchObject({
        _tag: "flows/agent/BudgetExceeded",
        scope: "tokens",
        used: 600,
        max: 1_000,
        next: 600
      })
      // Zero provider calls after the boundary: the refusal happened before the
      // ask, which is the difference between a budget and a report.
      expect(calls).toHaveLength(1)
      // And the refusal is attributable, which is what makes the numbers above
      // mean anything: the resumed run was refused for a step it has never
      // made, and no step whose spend is already in the recovered ledger was
      // refused. Without the key both readings produce `used: 600, next: 600`.
      const refused = after.filter((asked) => asked.verdict === "refuse")
      expect(refused).toHaveLength(1)
      expect(refused[0]?.stepKey).toBeTypeOf("string")
      expect(counted.has(refused[0]!.stepKey!)).toBe(false)
      expect(after.filter((asked) => asked.stepKey !== undefined && counted.has(asked.stepKey)))
        .toEqual(after.filter((asked) => asked.verdict === "proceed" && counted.has(asked.stepKey!)))
    },
    60_000
  )
})

/**
 * The per-execution state a budget reads its run id from.
 *
 * The recovery only needs `executionId`, but the port's contract is one whole
 * instance, so the fixture builds one rather than narrowing the service.
 */
const instanceFor = (executionId: string): FlowRuntime.FlowInstance["Service"] =>
  FlowRuntime.FlowInstance.of({
    executionId,
    lineageId: `${executionId}/root`,
    flow: OneStep,
    scope: Scope.makeUnsafe(),
    suspended: false,
    interrupted: false,
    waiting: undefined,
    handoff: undefined,
    cause: undefined,
    actionState: {
      count: 0,
      latch: Latch.makeUnsafe(),
      nextOrdinal: () => 1,
      snapshots: new Map(),
      keylessInFlight: new Set()
    }
  })

/** One budget record as the journal hands it back. */
const budgetEntry = (
  seq: number,
  eventType: string,
  payload: unknown,
  sourceId = "/agent/budget"
): JournalEvent.Entry =>
  new JournalEvent.Entry({
    runId: JournalEvent.RunId.make("usage-pages"),
    seq: JournalEvent.Seq.make(seq),
    eventId: `event-${seq}`,
    sourceId: JournalEvent.SourceId.make(sourceId),
    sourceSeq: JournalEvent.SourceSeq.make(seq),
    emittedAtMs: 0,
    eventType,
    payload,
    meta: {}
  })

/** One usage record as the journal hands it back. */
const usageEntry = (seq: number, payload: unknown): JournalEvent.Entry => budgetEntry(seq, Budget.usageEvent, payload)

/** A journal that hands back the given pages, one read at a time. */
const pagedJournal = (
  pages: ReadonlyArray<ReadonlyArray<JournalEvent.Entry>>,
  writable = true
) =>
  Journal.layerNoop({
    flush: Effect.void,
    entries: (options) =>
      Effect.sync(() => {
        const index = options.after === undefined
          ? 0
          : pages.findIndex((page) => page.at(-1)?.seq === options.after) + 1
        return { entries: pages[index] ?? [], hasMore: index + 1 < pages.length }
      }),
    ...(writable
      ? {
        emitDurableUnfenced: () =>
          Effect.succeed({
            _tag: "Accepted" as const,
            seq: JournalEvent.Seq.make(1),
            sourceSeq: JournalEvent.SourceSeq.make(1)
          })
      }
      : {})
  })

/** A writable journal whose committed rows can be shared by budget instances. */
const budgetLedger = () => {
  const recorded: Array<JournalEvent.Entry> = []
  const journal = Journal.makeNoop({
    flush: Effect.void,
    entries: ({ runId, after, limit }) =>
      Effect.sync(() => {
        const runEntries = recorded.filter((entry) => entry.runId === runId)
        const start = after === undefined
          ? 0
          : runEntries.findIndex((entry) => entry.seq === after) + 1
        const entries = runEntries.slice(start, start + limit)
        return { entries, hasMore: start + entries.length < runEntries.length }
      }),
    emitDurableUnfenced: (input) =>
      Effect.sync(() => {
        const seq = JournalEvent.Seq.make(recorded.length + 1)
        const sourceSeq = input.sourceSeq ?? JournalEvent.SourceSeq.make(recorded.length + 1)
        recorded.push(
          new JournalEvent.Entry({
            runId: input.runId,
            seq,
            eventId: JournalEvent.makeEventId(input.runId, input.sourceId, sourceSeq),
            sourceId: input.sourceId,
            sourceSeq,
            emittedAtMs: 0,
            eventType: input.eventType,
            payload: input.payload,
            meta: input.meta ?? {}
          })
        )
        return { _tag: "Accepted" as const, seq, sourceSeq }
      })
  })
  return { journal, recorded }
}

describe("admission while usage is being committed", () => {
  it.each(["available", "exhausted", "write-failed"] as const)(
    "waits for a concurrent usage write before deciding: %s",
    async (mode) => {
      const { journal } = budgetLedger()
      const writing = Latch.makeUnsafe(), release = Latch.makeUnsafe()
      const delayed = Journal.make({
        ...journal,
        emitDurableUnfenced: (input) =>
          input.eventType !== Budget.usageEvent
            ? journal.emitDurableUnfenced(input)
            : writing.open.pipe(
              Effect.andThen(release.await),
              Effect.andThen(
                mode === "write-failed"
                  ? Effect.fail(new Journal.JournalError({ code: "journal_closed", message: "usage write failed" }))
                  : journal.emitDurableUnfenced(input)
              )
            )
      })
      await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const budget = yield* Budget.make({ tokens: { max: mode === "exhausted" ? 100 : 1000 } })
          const record = yield* Effect.forkChild(Effect.exit(budget.record("paid", { totalTokens: 60 })))
          yield* writing.await
          const next = yield* Effect.forkChild(Effect.exit(budget.reserve("next")), { startImmediately: true })
          yield* Effect.yieldNow
          const waiting = next.pollUnsafe() === undefined
          yield* release.open
          expect(waiting).toBe(true)
          const recorded = yield* Fiber.join(record)
          const admitted = yield* Fiber.join(next)
          if (mode === "write-failed") {
            expect(failureOf(recorded)).toMatchObject({
              _tag: "flows/agent/BudgetAccountingUnavailable",
              phase: "record"
            })
            expect(failureOf(admitted)).toMatchObject({
              _tag: "flows/agent/BudgetAccountingUnavailable",
              phase: "record"
            })
            expect(failureOf(yield* Effect.exit(budget.check("later")))).toMatchObject({
              _tag: "flows/agent/BudgetAccountingUnavailable"
            })
          } else {
            expect(recorded._tag).toBe("Success")
            expect(admitted).toMatchObject({
              _tag: "Success",
              value: { _tag: mode === "exhausted" ? "refuse" : "proceed" }
            })
            expect(yield* budget.usage).toEqual({ tokens: 60, calls: 1, largestCall: 60 })
          }
        })).pipe(
          Effect.provideService(Journal.Journal, delayed),
          Effect.provideService(FlowRuntime.FlowInstance, instanceFor("concurrent-usage"))
        )
      )
    }
  )

  it("cancels a queued paid record without forgetting its unrecorded spend", async () => {
    const { journal } = budgetLedger()
    const writing = Latch.makeUnsafe(), release = Latch.makeUnsafe()
    const delayed = Journal.make({
      ...journal,
      emitDurableUnfenced: (input) =>
        input.eventType !== Budget.usageEvent
          ? journal.emitDurableUnfenced(input)
          : writing.open.pipe(Effect.andThen(release.await), Effect.andThen(journal.emitDurableUnfenced(input)))
    })
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const budget = yield* Budget.make({ tokens: { max: 1000 } })
        const first = yield* Effect.forkChild(budget.record("first", { totalTokens: 60 }), { startImmediately: true })
        yield* writing.await
        const second = yield* Effect.forkChild(budget.record("second", { totalTokens: 25 }), { startImmediately: true })
        const cancelling = yield* Effect.forkChild(Fiber.interrupt(second), { startImmediately: true })
        yield* Effect.yieldNow
        const stoppedBeforeWriteFinished = cancelling.pollUnsafe() !== undefined
        // Always release the fixture before asserting, including on the old bug.
        yield* release.open
        yield* Fiber.join(first)
        yield* Fiber.join(cancelling)
        expect(stoppedBeforeWriteFinished).toBe(true)
        expect(failureOf(yield* Effect.exit(budget.check("next")))).toMatchObject({
          _tag: "flows/agent/BudgetAccountingUnavailable",
          phase: "record"
        })
        expect(yield* budget.usage).toEqual({ tokens: 85, calls: 2, largestCall: 60 })
        yield* budget.record("second", { totalTokens: 25 })
        expect(yield* budget.usage).toEqual({ tokens: 85, calls: 2, largestCall: 60 })
        expect((yield* budget.check("next"))._tag).toBe("proceed")
      })).pipe(
        Effect.provideService(Journal.Journal, delayed),
        Effect.provideService(FlowRuntime.FlowInstance, instanceFor("cancel-queued-usage"))
      )
    )
  })

  it("records inside a held transaction while an outside writer waits for its commit", async () => {
    const { journal } = budgetLedger()
    const writing = Latch.makeUnsafe(), committed = Latch.makeUnsafe()
    const callbacks: Array<Effect.Effect<void>> = []
    const outside = Journal.make({
      ...journal,
      emitDurableUnfenced: (input) =>
        input.eventType !== Budget.usageEvent
          ? journal.emitDurableUnfenced(input)
          : writing.open.pipe(Effect.andThen(committed.await), Effect.andThen(journal.emitDurableUnfenced(input)))
    })
    const transaction = Journal.make({
      ...journal,
      whenCommitted: (callback) =>
        Effect.sync(() => {
          callbacks.push(callback)
          return true
        })
    })
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const budget = yield* Budget.make({ tokens: { max: 1000 } })
        yield* budget.usage // Recovery precedes the transaction, as at the model boundary.
        const waitingWriter = yield* Effect.forkChild(budget.record("outside", { totalTokens: 60 }), {
          startImmediately: true
        })
        yield* writing.await
        const inside = yield* Effect.forkChild(
          budget.record("inside", { totalTokens: 25 }).pipe(Effect.provideService(Journal.Journal, transaction)),
          { startImmediately: true }
        )
        yield* Effect.yieldNow
        const recordedBeforeCommit = inside.pollUnsafe() !== undefined
        // Release a broken implementation too, so failure cannot wedge cleanup.
        yield* committed.open
        yield* Fiber.join(waitingWriter)
        yield* Fiber.join(inside)
        expect(recordedBeforeCommit).toBe(true)
        expect(failureOf(yield* Effect.exit(budget.check("before-commit-callback")))).toMatchObject({
          _tag: "flows/agent/BudgetAccountingUnavailable",
          phase: "record"
        })
        yield* Effect.forEach(callbacks, (callback) => callback, { discard: true })
        expect(yield* budget.usage).toEqual({ tokens: 85, calls: 2, largestCall: 60 })
        expect((yield* budget.check("after-commit"))._tag).toBe("proceed")
      })).pipe(
        Effect.provideService(Journal.Journal, outside),
        Effect.provideService(FlowRuntime.FlowInstance, instanceFor("transaction-usage-contention"))
      )
    )
  })
})

describe("recovering a run's skip-remaining latch", () => {
  it.each(["restart", "eviction"] as const)("keeps a reservation-only refusal after %s", async (recovery) => {
    const { journal, recorded } = budgetLedger()
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const policy: Budget.Policy = { tokens: { max: 100, onExceeded: "skip-remaining" } }
        const budget = yield* Budget.make(policy, { maxRuns: 1 })
        const refusal = yield* Effect.scoped(Effect.gen(function*() {
          expect((yield* budget.reserve("peer"))._tag).toBe("proceed")
          const verdict = yield* budget.reserve("refused")
          expect(recorded.filter((entry) => entry.eventType === Budget.budgetLatchedEvent)).toHaveLength(1)
          return verdict
        }))
        expect(refusal).toMatchObject({
          _tag: "refuse",
          exceeded: { used: 0, reserved: 100, next: 100, onExceeded: "skip-remaining" }
        })
        expect(yield* budget.check("same-instance")).toEqual(refusal)
        if (recovery === "eviction") {
          yield* budget.check("other").pipe(
            Effect.provideService(FlowRuntime.FlowInstance, instanceFor("other-run"))
          )
        }
        const recovered = recovery === "restart" ? yield* Budget.make(policy) : budget
        return {
          refusal,
          usage: yield* recovered.usage,
          next: yield* Effect.scoped(recovered.reserve("next"))
        }
      }).pipe(
        Effect.provideService(Journal.Journal, journal),
        Effect.provideService(FlowRuntime.FlowInstance, instanceFor("latched-run"))
      )
    )

    expect(observed.usage).toEqual({ tokens: 0, calls: 0, largestCall: 0 })
    expect(observed.next).toEqual(observed.refusal)
  })
})

describe("the durable skip-remaining decision", () => {
  it("fails closed if the latch write fails, then retries the write", async () => {
    const { journal, recorded } = budgetLedger()
    const unwritable = Journal.make({
      ...journal,
      emitDurableUnfenced: (input) =>
        input.eventType === Budget.budgetLatchedEvent
          ? Effect.fail(new Journal.JournalError({ code: "journal_closed", message: "latch write refused" }))
          : journal.emitDurableUnfenced(input)
    })
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const budget = yield* Budget.make({ tokens: { max: 100, onExceeded: "skip-remaining" } })
        yield* budget.reserve("peer")
        const exit = yield* Effect.exit(
          budget.reserve("refused").pipe(
            Effect.provideService(Journal.Journal, unwritable)
          )
        )
        expect(failureOf(exit)).toMatchObject({
          _tag: "flows/agent/BudgetAccountingUnavailable",
          phase: "record",
          runId: "latched-run"
        })
        expect(recorded.filter((entry) => entry.eventType === Budget.budgetLatchedEvent)).toHaveLength(0)
        expect((yield* budget.reserve("retry"))._tag).toBe("refuse")
        expect(recorded.filter((entry) => entry.eventType === Budget.budgetLatchedEvent)).toHaveLength(1)
      })).pipe(
        Effect.provideService(Journal.Journal, journal),
        Effect.provideService(FlowRuntime.FlowInstance, instanceFor("latched-run"))
      )
    )
  })

  it("refuses a speculative latch inside a transaction after initial recovery", async () => {
    const { journal, recorded } = budgetLedger()
    const transaction = Journal.make({ ...journal, whenCommitted: () => Effect.succeed(true) })
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const budget = yield* Budget.make({ tokens: { max: 100, onExceeded: "skip-remaining" } })
        yield* budget.reserve("peer")
        const exit = yield* Effect.exit(
          budget.reserve("refused").pipe(
            Effect.provideService(Journal.Journal, transaction)
          )
        )
        expect(failureOf(exit)).toMatchObject({
          _tag: "flows/agent/BudgetAccountingUnavailable",
          phase: "record",
          message: expect.stringContaining("outside a journal transaction")
        })
        expect(recorded.filter((entry) => entry.eventType === Budget.budgetLatchedEvent)).toHaveLength(0)
      })).pipe(
        Effect.provideService(Journal.Journal, journal),
        Effect.provideService(FlowRuntime.FlowInstance, instanceFor("latched-run"))
      )
    )
  })

  it.each(["malformed", "not-skip"])("fails closed on a %s latch record", async (kind) => {
    const payload = kind === "malformed" ? { private: "unreadable" } : {
      _tag: "flows/agent/BudgetExceeded",
      scope: "tokens",
      onExceeded: "warn",
      used: 0,
      max: 100,
      next: 100,
      message: "not a latch"
    }
    const exit = await Effect.runPromise(Effect.exit(
      Effect.gen(function*() {
        const budget = yield* Budget.make({})
        return yield* budget.check("next")
      }).pipe(
        Effect.provide(pagedJournal([[budgetEntry(1, Budget.budgetLatchedEvent, payload)]])),
        Effect.provideService(FlowRuntime.FlowInstance, instanceFor("usage-pages"))
      )
    ))
    expect(failureOf(exit)).toMatchObject({
      _tag: "flows/agent/BudgetAccountingUnavailable",
      phase: "recover",
      message: expect.stringContaining("budget-latched record at seq 1")
    })
  })

  it("keeps the first durable decision and permits counted replays", async () => {
    const failure = new Budget.BudgetExceeded({
      scope: "latency",
      onExceeded: "skip-remaining",
      used: 2_000,
      max: 1_000,
      next: 0,
      message: "original latency refusal"
    })
    const payload = Redaction.make()(Schema.encodeSync(Budget.BudgetExceeded)(failure))
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const budget = yield* Budget.make({})
        return { next: yield* budget.check("next"), replay: yield* budget.check("counted") }
      }).pipe(
        Effect.provide(pagedJournal([[
          budgetEntry(1, Budget.budgetLatchedEvent, payload),
          usageEntry(2, { stepKey: "counted", spent: 10 }),
          budgetEntry(3, Budget.budgetLatchedEvent, {
            ...Schema.encodeSync(Budget.BudgetExceeded)(failure),
            used: 3_000
          })
        ]])),
        Effect.provideService(FlowRuntime.FlowInstance, instanceFor("usage-pages"))
      )
    )
    expect(observed.next).toMatchObject({ _tag: "refuse", exceeded: failure, failure: { _tag: Budget.skippedTag } })
    expect(observed.replay._tag).toBe("proceed")
  })
})

describe("recovering a run's earlier spend", () => {
  it("reads every page of the run's journal, not just the first", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const budget = yield* Budget.make({ tokens: { max: 10_000 } })
        return yield* budget.usage
      }).pipe(
        Effect.provide(
          Layer.merge(
            pagedJournal([
              [usageEntry(1, { stepKey: "step-a", spent: 300 })],
              [usageEntry(2, { stepKey: "step-b", spent: 250 })]
            ]),
            Layer.succeed(FlowRuntime.FlowInstance)(instanceFor("usage-pages"))
          )
        )
      )
    )

    // Both pages folded, and each step counted once.
    expect(observed).toEqual({ tokens: 550, calls: 2, largestCall: 300 })
  })

  it("fails closed on a current usage record it cannot decode", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function*() {
          const budget = yield* Budget.make({})
          return yield* budget.usage
        }).pipe(
          Effect.provide(
            Layer.merge(
              pagedJournal([[
                usageEntry(1, { stepKey: "step-a", spent: 300 }),
                usageEntry(2, {
                  stepKey: "private-model-step",
                  spent: "private malformed payload"
                })
              ]]),
              Layer.succeed(FlowRuntime.FlowInstance)(instanceFor("usage-pages"))
            )
          )
        )
      )
    )

    const failure = failureOf(exit) as Budget.AccountingUnavailable
    expect(failure).toMatchObject({
      _tag: "flows/agent/BudgetAccountingUnavailable",
      phase: "recover",
      runId: "usage-pages"
    })
    expect(failure.message).toContain("seq 2")
    expect(failure.message).toContain("/agent/budget")
    expect(failure.message).not.toContain("private-model-step")
    expect(failure.message).not.toContain("private malformed payload")
  })

  it("fails closed when the journal cannot be read, rather than starting the run at zero", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function*() {
          const budget = yield* Budget.make({})
          yield* budget.record("step-a", { totalTokens: 40 })
          return yield* budget.usage
        }).pipe(
          Effect.provide(
            Layer.merge(
              // The closed stub fails every call, which is the composition whose
              // journal is unavailable rather than absent.
              Journal.layerNoop(),
              Layer.succeed(FlowRuntime.FlowInstance)(instanceFor("usage-pages"))
            )
          )
        )
      )
    )

    // An unreadable ledger is an UNKNOWN spend, not a zero one, and the
    // difference is the whole guarantee: recovering nothing here would hand a
    // resumed run its whole allowance back and report it as a healthy budget.
    expect(failureOf(exit)).toMatchObject({
      _tag: "flows/agent/BudgetAccountingUnavailable",
      phase: "recover",
      runId: "usage-pages"
    })
  })

  it("fails closed rather than truncating a ledger longer than one recovery reads", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function*() {
          // One entry is all this budget will read, and the journal below has
          // two pages, so the read reaches its bound with the run's spend only
          // partly folded.
          const budget = yield* Budget.make({ tokens: { max: 10_000 } }, { recoveryEntries: 1 })
          return yield* budget.usage
        }).pipe(
          Effect.provide(
            Layer.merge(
              pagedJournal([
                [usageEntry(1, { stepKey: "step-a", spent: 300 })],
                [usageEntry(2, { stepKey: "step-b", spent: 250 })]
              ]),
              Layer.succeed(FlowRuntime.FlowInstance)(instanceFor("usage-pages"))
            )
          )
        )
      )
    )

    // A partial ledger is indistinguishable from a complete one, so a bound
    // that stopped reading and answered 300 would be a budget that quietly
    // forgot 250 tokens on every resume of a long run.
    expect(failureOf(exit)).toMatchObject({
      _tag: "flows/agent/BudgetAccountingUnavailable",
      phase: "recover"
    })
    expect(String((failureOf(exit) as { readonly message: string }).message)).toContain(
      "more than the 1 entries"
    )
  })

  it("fails closed when a counted call's durable record cannot be written", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function*() {
          const budget = yield* Budget.make({})
          yield* budget.record("step-a", { totalTokens: 40 })
        }).pipe(
          Effect.provide(
            Layer.merge(
              // Readable, writable on nothing: `pagedJournal` answers reads and
              // leaves every emit at the closed stub's failure.
              pagedJournal([], false),
              Layer.succeed(FlowRuntime.FlowInstance)(instanceFor("usage-write"))
            )
          )
        )
      )
    )

    // The call happened and this process counted it; no successor of this run
    // ever will. Swallowing the write is what hands the resumed run a second
    // allowance, so the step that made the call fails instead.
    expect(failureOf(exit)).toMatchObject({
      _tag: "flows/agent/BudgetAccountingUnavailable",
      phase: "record",
      runId: "usage-write"
    })
  })

  it("preserves a tagged durable-write cause on the accounting failure", async () => {
    const ledger = budgetLedger()
    const cause = new Journal.JournalError({
      code: "sink_failed",
      message: "the usage sink refused this record",
      cause: { storageCode: "ELEDGER" }
    })
    const journal = Journal.make({
      ...ledger.journal,
      emitDurableUnfenced: (input) =>
        input.eventType === Budget.usageEvent
          ? Effect.fail(cause)
          : ledger.journal.emitDurableUnfenced(input)
    })
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function*() {
          const budget = yield* Budget.make({})
          yield* budget.record("step-a", { totalTokens: 40 })
        }).pipe(
          Effect.provideService(Journal.Journal, journal),
          Effect.provideService(FlowRuntime.FlowInstance, instanceFor("usage-write-cause"))
        )
      )
    )

    expect(failureOf(exit)).toMatchObject({
      _tag: "flows/agent/BudgetAccountingUnavailable",
      phase: "record",
      runId: "usage-write-cause",
      cause: {
        _tag: "@smthrs/journal/JournalError",
        code: "sink_failed",
        cause: { storageCode: "ELEDGER" }
      }
    })
  })

  it("keeps a native Error nested in a durable-write cause legible", async () => {
    const ledger = budgetLedger()
    // `Error.message` is an own property but a NON-ENUMERABLE one, so the bare
    // JSON round trip this encoder used to run dropped it and the accounting
    // failure carried `{}` where the storage refusal was. The session
    // settlement already preserved it, which is the divergence a single shared
    // serializer removes.
    const cause = new Journal.JournalError({
      code: "sink_failed",
      message: "the usage sink refused this record",
      cause: { nested: new Error("storage unavailable") }
    })
    const journal = Journal.make({
      ...ledger.journal,
      emitDurableUnfenced: (input) =>
        input.eventType === Budget.usageEvent
          ? Effect.fail(cause)
          : ledger.journal.emitDurableUnfenced(input)
    })
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function*() {
          const budget = yield* Budget.make({})
          yield* budget.record("step-a", { totalTokens: 40 })
        }).pipe(
          Effect.provideService(Journal.Journal, journal),
          Effect.provideService(FlowRuntime.FlowInstance, instanceFor("usage-write-nested-error"))
        )
      )
    )

    expect(failureOf(exit)).toMatchObject({
      _tag: "flows/agent/BudgetAccountingUnavailable",
      phase: "record",
      cause: {
        _tag: "@smthrs/journal/JournalError",
        code: "sink_failed",
        cause: { nested: { message: "storage unavailable" } }
      }
    })
  })

  it("keeps a text approximation of a write cause JSON cannot render", async () => {
    const ledger = budgetLedger()
    // A `BigInt` field is the shape `JSON.stringify` refuses outright, and a
    // sink that reports a 64-bit offset is the realistic way one arrives. The
    // rendering must not throw out of the accounting failure: an operator who
    // is told "the error could not be printed" has lost the report that the
    // ledger write failed at all.
    class LedgerOverflow extends Error {
      readonly offset = 2n ** 63n
    }
    const cause = new LedgerOverflow("the ledger offset exceeded its column")
    const journal = Journal.make({
      ...ledger.journal,
      emitDurableUnfenced: (input) =>
        input.eventType === Budget.usageEvent
          ? Effect.fail(cause as unknown as Journal.JournalError)
          : ledger.journal.emitDurableUnfenced(input)
    })
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function*() {
          const budget = yield* Budget.make({})
          yield* budget.record("step-a", { totalTokens: 40 })
        }).pipe(
          Effect.provideService(Journal.Journal, journal),
          Effect.provideService(FlowRuntime.FlowInstance, instanceFor("usage-write-bigint"))
        )
      )
    )

    const failure = failureOf(exit) as Budget.AccountingUnavailable
    expect(failure._tag).toBe("flows/agent/BudgetAccountingUnavailable")
    expect(failure.phase).toBe("record")
    expect(typeof failure.cause).toBe("string")
    expect(failure.cause).toContain("the ledger offset exceeded its column")
  })

  it("fails closed when a counted call's cost has no durable form", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function*() {
          const budget = yield* Budget.make({})
          // `UsageRecord.spent` is `Schema.Finite`, so a provider total this
          // far out has no wire form at all. Encoding is the same boundary as
          // writing: the accumulator already took the call, and a cost no
          // successor of this run can read back is the allowance handed out a
          // second time.
          yield* budget.record("step-a", { totalTokens: Number.POSITIVE_INFINITY })
        }).pipe(
          Effect.provide(
            Layer.merge(
              pagedJournal([]),
              Layer.succeed(FlowRuntime.FlowInstance)(instanceFor("usage-encode"))
            )
          )
        )
      )
    )

    const failure = failureOf(exit) as Budget.AccountingUnavailable
    expect(failure).toMatchObject({
      _tag: "flows/agent/BudgetAccountingUnavailable",
      phase: "record",
      runId: "usage-encode"
    })
    expect(failure.message).toContain("its usage record does not encode")
    expect(failure.cause).toBeDefined()
  })
})

describe("a durable latency clock", () => {
  it("keeps its original zero across budget instances for the same run", async () => {
    const ledger = budgetLedger()
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* Budget.make({ latency: { maxMillis: 5_000 } })
        const initial = yield* first.check("step-a")
        yield* TestClock.adjust("6 seconds")
        const second = yield* Budget.make({ latency: { maxMillis: 5_000 } })
        const resumed = yield* second.check("step-b")
        return { initial, resumed }
      }).pipe(
        Effect.provideService(Journal.Journal, ledger.journal),
        Effect.provideService(FlowRuntime.FlowInstance, instanceFor("latency-resume")),
        Effect.provide(TestClock.layer())
      )
    )

    expect(observed.initial._tag).toBe("proceed")
    expect(observed.resumed).toMatchObject({
      _tag: "refuse",
      exceeded: { scope: "latency", used: 6_000, max: 5_000, next: 0 }
    })
  })

  it("charges active time only, and a fresh instance recovers the suspended spans", async () => {
    const ledger = budgetLedger()
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* Budget.make({ latency: { maxMillis: 5_000 } })
        yield* first.check("step-a")
        yield* TestClock.adjust("3 seconds")
        yield* first.suspend
        // A redundant suspend keeps the earlier start.
        yield* TestClock.adjust("10 seconds")
        yield* first.suspend
        yield* TestClock.adjust("10 seconds")
        yield* first.resume()
        yield* TestClock.adjust("1 second")
        // 4 s active of 24 s wall.
        const live = yield* first.check("step-b")
        yield* first.suspend
        yield* TestClock.adjust("30 seconds")
        // A restart finds the second span still open; admission closes it.
        const second = yield* Budget.make({ latency: { maxMillis: 5_000 } })
        const resumed = yield* second.check("step-c")
        yield* TestClock.adjust("1500 millis")
        const overrun = yield* second.check("step-d")
        return { live, resumed, overrun }
      }).pipe(
        Effect.provideService(Journal.Journal, ledger.journal),
        Effect.provideService(FlowRuntime.FlowInstance, instanceFor("latency-suspended")),
        Effect.provide(TestClock.layer())
      )
    )

    expect(observed.live._tag).toBe("proceed")
    expect(observed.resumed._tag).toBe("proceed")
    expect(observed.overrun).toMatchObject({
      _tag: "refuse",
      exceeded: { scope: "latency", used: 5_500, max: 5_000 }
    })
    const transitions = ledger.recorded
      .filter((entry) =>
        entry.eventType === Budget.budgetSuspendedEvent || entry.eventType === Budget.budgetResumedEvent
      )
      .map((entry) => [entry.eventType === Budget.budgetSuspendedEvent ? "suspend" : "resume", entry.payload])
    expect(transitions).toEqual([
      ["suspend", { at: 3_000 }],
      ["resume", { at: 23_000 }],
      ["suspend", { at: 24_000 }],
      ["resume", { at: 54_000 }]
    ])
  })

  it("fails recovery closed on an undecodable suspension record", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const budget = yield* Budget.make({ latency: { maxMillis: 1_000 } })
        return yield* budget.check("step-a")
      }).pipe(
        Effect.provide(
          Layer.merge(
            pagedJournal([[budgetEntry(1, Budget.budgetSuspendedEvent, { at: "soon" })]]),
            TestClock.layer()
          )
        ),
        Effect.provideService(FlowRuntime.FlowInstance, instanceFor("latency-bad-suspension")),
        Effect.exit
      )
    )

    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain(Budget.budgetSuspendedEvent)
  })

  it("writes its durable zero at most once per run", async () => {
    const ledger = budgetLedger()
    await Effect.runPromise(
      Effect.gen(function*() {
        const budget = yield* Budget.make({ latency: { maxMillis: 5_000 } })
        yield* budget.check("step-a")
        yield* budget.check("step-b")
      }).pipe(
        Effect.provideService(Journal.Journal, ledger.journal),
        Effect.provideService(FlowRuntime.FlowInstance, instanceFor("latency-once")),
        Effect.provide(TestClock.layer())
      )
    )

    expect(ledger.recorded.filter((entry) => entry.eventType === Budget.budgetStartedEvent))
      .toHaveLength(1)
  })

  it("recovers the earliest durable zero when duplicate records exist", async () => {
    const verdict = await Effect.runPromise(
      Effect.gen(function*() {
        yield* TestClock.adjust("3 seconds")
        const budget = yield* Budget.make({ latency: { maxMillis: 1_000 } })
        return yield* budget.check("step-a")
      }).pipe(
        Effect.provide(
          Layer.merge(
            pagedJournal([[
              budgetEntry(1, Budget.budgetStartedEvent, { startedAt: 2_000 }),
              budgetEntry(2, Budget.budgetStartedEvent, { startedAt: 500 })
            ]]),
            Layer.succeed(FlowRuntime.FlowInstance)(instanceFor("usage-pages"))
          )
        ),
        Effect.provide(TestClock.layer())
      )
    )

    expect(verdict).toMatchObject({
      _tag: "refuse",
      exceeded: { scope: "latency", used: 2_500, max: 1_000 }
    })
  })

  it("fails closed on a durable zero it cannot decode", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function*() {
          const budget = yield* Budget.make({ latency: { maxMillis: 1_000 } })
          return yield* budget.check("step-a")
        }).pipe(
          Effect.provide(
            Layer.merge(
              pagedJournal([[
                budgetEntry(
                  7,
                  Budget.budgetStartedEvent,
                  { startedAt: "private malformed clock origin" },
                  "/agent/private-budget"
                )
              ]]),
              Layer.succeed(FlowRuntime.FlowInstance)(instanceFor("usage-pages"))
            )
          )
        )
      )
    )

    const failure = failureOf(exit) as Budget.AccountingUnavailable
    expect(failure).toMatchObject({
      _tag: "flows/agent/BudgetAccountingUnavailable",
      phase: "recover",
      runId: "usage-pages"
    })
    expect(failure.message).toContain("seq 7")
    expect(failure.message).toContain("/agent/private-budget")
    expect(failure.message).not.toContain("private malformed clock origin")
  })

  it("fails closed when the host clock's reading has no durable form", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function*() {
          const clock = yield* Clock.Clock
          // A host whose wall clock answers past the finite range. The zero
          // would be written, read back by the next incarnation, and used as
          // the subtrahend of every later latency check, so a reading the
          // record cannot carry is not a reading this budget may keep to
          // itself: an unwritten zero re-arms the whole allowance on resume.
          const unwritable: Clock.Clock = {
            ...clock,
            currentTimeMillisUnsafe: () => Number.POSITIVE_INFINITY,
            currentTimeMillis: Effect.succeed(Number.POSITIVE_INFINITY)
          }
          const budget = yield* Budget.make({ latency: { maxMillis: 1_000 } }).pipe(
            Effect.provideService(Clock.Clock, unwritable)
          )
          return yield* budget.check("step-a").pipe(Effect.provideService(Clock.Clock, unwritable))
        }).pipe(
          Effect.provide(
            Layer.merge(
              pagedJournal([]),
              Layer.succeed(FlowRuntime.FlowInstance)(instanceFor("clock-zero-encode"))
            )
          )
        )
      )
    )

    const failure = failureOf(exit) as Budget.AccountingUnavailable
    expect(failure).toMatchObject({
      _tag: "flows/agent/BudgetAccountingUnavailable",
      phase: "record",
      runId: "clock-zero-encode"
    })
    expect(failure.message).toContain("its latency clock zero does not encode")
    expect(failure.cause).toBeDefined()
  })
})

describe("the envelope", () => {
  it("becomes a policy a composition can enforce", () => {
    expect(
      Budget.policyFromEnvelope({
        capabilities: [],
        flows: [],
        budget: { tokens: 5_000, milliseconds: 60_000 }
      })
    ).toEqual({
      tokens: { max: 5_000, onExceeded: "fail" },
      latency: { maxMillis: 60_000, onExceeded: "fail" }
    })
    expect(
      Budget.policyFromEnvelope({ capabilities: [], flows: [], budget: {} }, { onExceeded: "warn" })
    ).toEqual({})
    const weights = { "test-model": { input: 1, cachedInput: 0.1, output: 4 } }
    expect(
      Budget.policyFromEnvelope({ capabilities: [], flows: [], budget: { tokens: 10 } }, { weights })
    ).toEqual({ weights, tokens: { max: 10, onExceeded: "fail" } })
  })
})

describe("a park budget", () => {
  it("refuses without latching, so a raised ceiling admits the call", async () => {
    const verdicts = await Effect.runPromise(
      Effect.gen(function*() {
        const tight = yield* Budget.make({ tokens: { max: 1_000, onExceeded: "park" } })
        yield* tight.record("step-a", { totalTokens: 600 })
        const parked = yield* tight.check("step-b")
        const again = yield* tight.check("step-b")
        return { parked, again }
      })
    )

    // The refusal is the BudgetExceeded itself, not a Skipped latch: a park is
    // lifted by a raise, and a latch would refuse the raised run too.
    expect(verdicts.parked).toMatchObject({
      _tag: "refuse",
      exceeded: { scope: "tokens", onExceeded: "park", used: 600, max: 1_000, next: 600 }
    })
    expect(verdicts.parked._tag === "refuse" && verdicts.parked.failure).toBeInstanceOf(Budget.BudgetExceeded)
    expect(verdicts.again).toMatchObject({ _tag: "refuse", exceeded: { onExceeded: "park" } })
    expect(Schema.decodeUnknownSync(Budget.OnExceeded)("park")).toBe("park")
  })

  it("proposes a ceiling covering the spend, the refused call, and one more allowance", () => {
    const exceeded = new Budget.BudgetExceeded({
      scope: "tokens",
      onExceeded: "park",
      used: 600,
      reserved: 100,
      max: 1_000,
      next: 600,
      message: "over"
    })
    expect(Budget.raise({ tokens: 1_000, milliseconds: 5_000, onExceeded: "park" }, exceeded))
      .toEqual({ tokens: 2_300, milliseconds: 5_000, onExceeded: "park" })
    const late = new Budget.BudgetExceeded({
      scope: "latency",
      onExceeded: "park",
      used: 5_000.5,
      max: 5_000,
      next: 0,
      message: "late"
    })
    expect(Budget.raise({ milliseconds: 5_000 }, late)).toEqual({ milliseconds: 10_001 })
  })

  it("applies every approved raise as the largest ceiling, never lowering or adding one", () => {
    const envelope = { capabilities: ["read"], flows: [], budget: { tokens: 1_000, onExceeded: "park" as const } }
    expect(Budget.raisedBy(envelope, [])).toEqual(envelope)
    expect(Budget.raisedBy(envelope, [{ tokens: 2_300 }, { tokens: 1_500 }, { milliseconds: 9 }])).toEqual({
      capabilities: ["read"],
      flows: [],
      budget: { tokens: 2_300, onExceeded: "park" }
    })
    expect(Budget.raisedBy(envelope, [{ tokens: 10 }]).budget.tokens).toBe(1_000)
  })

  it("takes the approved envelope's choice over the composition's default", () => {
    expect(
      Budget.policyFromEnvelope(
        { capabilities: [], flows: [], budget: { tokens: 10, milliseconds: 1_000, onExceeded: "park" } },
        { onExceeded: "fail" }
      )
    ).toEqual({ tokens: { max: 10, onExceeded: "park" }, latency: { maxMillis: 1_000, onExceeded: "park" } })
  })
})

describe("an explicitly unbounded composition", () => {
  it("accounts nothing and refuses nothing", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const budget = yield* Budget.current
        yield* budget.record("step-a", { totalTokens: 10_000 })
        return {
          verdict: yield* budget.check(undefined),
          usage: yield* budget.usage,
          run: yield* budget.usageOf("any-run")
        }
      }).pipe(Effect.provide(Budget.layerUnbounded()))
    )

    expect(observed.verdict._tag).toBe("proceed")
    expect(observed.usage).toEqual({ tokens: 0, calls: 0, largestCall: 0 })
    expect(observed.run).toEqual({ tokens: 0, calls: 0, largestCall: 0 })
  })

  it("builds one straight from an approved envelope", async () => {
    const verdicts = await Effect.runPromise(
      Effect.gen(function*() {
        const budget = yield* Budget.Budget
        const first = yield* budget.check(undefined)
        yield* budget.record("step-a", { totalTokens: 900 })
        return { first, second: yield* budget.check(undefined) }
      }).pipe(
        Effect.provide(
          Budget.layerFromEnvelope({
            capabilities: [],
            flows: [],
            budget: { tokens: 1_000 }
          })
        )
      )
    )

    expect(verdicts.first._tag).toBe("proceed")
    expect(verdicts.second).toMatchObject({ _tag: "refuse", exceeded: { max: 1_000, used: 900 } })
  })

  it("keeps latching after a latency budget stopped the run", async () => {
    const verdicts = await Effect.runPromise(
      Effect.gen(function*() {
        const budget = yield* Budget.make({
          latency: { maxMillis: 1_000, onExceeded: "skip-remaining" }
        })
        yield* TestClock.adjust("2 seconds")
        const first = yield* budget.check(undefined)
        const second = yield* budget.check(undefined)
        return { first, second }
      }).pipe(Effect.provide(TestClock.layer()))
    )

    expect(verdicts.first).toMatchObject({
      _tag: "refuse",
      exceeded: { scope: "latency", onExceeded: "skip-remaining", used: 2_000, max: 1_000, next: 0 }
    })
    // The latch carries the original refusal, so later skipped calls report
    // the same ceiling and numbers rather than fabricating a token verdict.
    expect(verdicts.second).toMatchObject({
      _tag: "refuse",
      exceeded: { scope: "latency", onExceeded: "skip-remaining", used: 2_000, max: 1_000, next: 0 }
    })
    const firstExceeded = (verdicts.first as { readonly exceeded: Budget.BudgetExceeded }).exceeded
    expect((verdicts.second as { readonly exceeded: Budget.BudgetExceeded }).exceeded).toEqual(firstExceeded)
  })
})

/**
 * The same journal with its LOSSY channel closed.
 *
 * The lossy channel is documented as droppable telemetry, so a composition
 * whose queue overflowed or whose journal was compacted loses everything
 * written there. A budget that survived a restart only because a lossy record
 * happened to still be present would not survive one.
 */
const withoutLossyRecords = Effect.map(
  Journal.Journal,
  (real) => Journal.make({ ...real, emitLossy: Journal.makeNoop().emitLossy })
)

describe("a budget whose journal keeps nothing lossy", () => {
  it("still counts what the run spent before the restart", async () => {
    const calls: Array<string> = []
    const incarnation = (hostId: string) =>
      Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId },
          journalSource: `budget-${hostId}`,
          isAlive: () => Effect.succeed(false)
        })
        return Layer.mergeAll(First.layer, Second.layer, Interpreter.layer(TwoSteps)).pipe(
          Layer.provideMerge(AgentAction.layerHost(host)),
          Layer.provideMerge(seats(parkingBetweenSteps(300, calls))),
          Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
          Layer.provideMerge(Budget.layer({ tokens: { max: 5_000 } })),
          Layer.provideMerge(QuotaPolicy.layerDefault()),
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
        )
      })

    const observed = await durable(
      Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        const lossless = yield* withoutLossyRecords
        return yield* Effect.gen(function*() {
          yield* Effect.scoped(
            Effect.gen(function*() {
              const wiring = yield* incarnation("lossy-before")
              const running = yield* TwoSteps.execute({ diff: "-  old\n+  new" }, {
                executionId: "budget-lossy"
              }).pipe(Effect.provide(wiring), Effect.forkChild({ startImmediately: true }))
              yield* waitForPark(state)
              yield* Fiber.interrupt(running)
            })
          )
          return yield* Effect.scoped(
            Effect.gen(function*() {
              const wiring = yield* incarnation("lossy-after")
              return yield* Effect.gen(function*() {
                const value = yield* TwoSteps.execute({ diff: "-  old\n+  new" }, {
                  executionId: "budget-lossy"
                })
                const budget = yield* Budget.Budget
                // A budget that drove none of this run reads the same numbers:
                // the records, not the accumulator, are what survived.
                const supervisor = yield* Budget.make({})
                return {
                  value,
                  usage: yield* budget.usageOf("budget-lossy"),
                  supervised: yield* supervisor.usageOf("budget-lossy")
                }
              }).pipe(Effect.provide(wiring))
            })
          )
        }).pipe(Effect.provideService(Journal.Journal, lossless))
      }).pipe(Effect.provide(stores))
    )

    expect(observed.value).toEqual({ approved: true })
    // The tally is projected from the DURABLE usage records, so closing the
    // lossy channel changes nothing about it.
    expect(observed.usage).toEqual({ tokens: 600, calls: 2, largestCall: 300 })
    expect(observed.supervised).toEqual({ tokens: 600, calls: 2, largestCall: 300 })
  }, 60_000)
})

/**
 * The same journal, with the budget's own durable records refused.
 *
 * Only the budget's records: the engine writes its lifecycle on the same
 * channel, and closing that would fail the run for a reason that has nothing
 * to do with accounting.
 */
const withoutUsageRecords = Effect.map(
  Journal.Journal,
  (real) =>
    Journal.make({
      ...real,
      emitDurableUnfenced: (input) =>
        input.eventType === Budget.usageEvent
          ? Effect.fail(
            new Journal.JournalError({ code: "journal_closed", message: "the ledger is closed" })
          )
          : real.emitDurableUnfenced(input)
    })
)

describe("a budget whose ledger cannot be written", () => {
  it("fails the step that made the call instead of spending on unrecorded credit", async () => {
    const calls: Array<string> = []
    const exit = await durable(
      Effect.gen(function*() {
        // The engine is built INSIDE the override, because it captures the
        // context its node bodies run under: an engine made before the swap
        // would hand the budget the journal that still accepts records.
        const unwritable = yield* withoutUsageRecords
        return yield* Effect.gen(function*() {
          const engine = yield* EngineStore.make({
            owner: { hostId: "budget-unwritable" },
            journalSource: "budget-unwritable",
            isAlive: () => Effect.succeed(false)
          })
          const wiring = Layer.mergeAll(First.layer, Interpreter.layer(OneStep)).pipe(
            Layer.provideMerge(AgentAction.layerHost(host)),
            Layer.provideMerge(seats(spending(600, [answering(`{"approved":true}`)], calls))),
            Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
            Layer.provideMerge(Budget.layer({ tokens: { max: 10_000 } })),
            Layer.provideMerge(QuotaPolicy.layerUnclassified()),
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
          )
          return yield* Effect.exit(
            OneStep.execute({ diff: "-  old\n+  new" }, { executionId: "budget-unwritable" }).pipe(
              Effect.provide(wiring)
            )
          )
        }).pipe(Effect.provideService(Journal.Journal, unwritable))
      }).pipe(Effect.provide(stores))
    )

    // The ceiling is nowhere near reached: what fails the step is that the
    // spend cannot be written down, which is the state a resumed run would
    // read as "nothing spent yet".
    expect(JSON.stringify(failureOf(exit))).toContain("engine_failed")
    expect(JSON.stringify(failureOf(exit))).toContain("could not durably record")
    expect(calls).toHaveLength(1)
  }, 60_000)
})

describe("a budget shared by every run of one composition", () => {
  /**
   * The composition a control plane actually writes: the layer is built ONCE,
   * above the engine, and every run the engine drives is served by that one
   * `Budget` instance. A single accumulator behind it would spend run a's
   * tokens out of run b's allowance.
   */
  const shared = (budget: Layer.Layer<Budget.Budget, Budget.ConfigurationError>, model: Model.Model) =>
    Layer.mergeAll(First.layer, Interpreter.layer(OneStep)).pipe(
      Layer.provideMerge(AgentAction.layerHost(host)),
      Layer.provideMerge(seats(model)),
      Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
      Layer.provideMerge(budget),
      Layer.provideMerge(QuotaPolicy.layerUnclassified()),
      Layer.provideMerge(Action.layerImplementations)
    )

  it("gives a second run its own allowance and its own tally", async () => {
    const calls: Array<string> = []
    const observed = await durable(
      Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: "budget-shared" },
          journalSource: "budget-shared",
          isAlive: () => Effect.succeed(false)
        })
        // `Layer.build` rather than two `Effect.provide` calls: memoization is
        // per provide, so providing the same layer twice would build two
        // budgets and prove nothing.
        const context = yield* Layer.build(
          shared(
            // 600 spent and 600 projected exceeds this ceiling, so a shared
            // accumulator refuses run b's FIRST call.
            Budget.layer({ tokens: { max: 1_000 } }),
            spending(600, [answering(`{"approved":true}`)], calls)
          ).pipe(Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime)(engine)))
        )
        const first = yield* OneStep.execute({ diff: "-  a\n+  b" }, {
          executionId: "budget-shared-a"
        }).pipe(Effect.provide(context))
        const second = yield* OneStep.execute({ diff: "-  c\n+  d" }, {
          executionId: "budget-shared-b"
        }).pipe(Effect.provide(context))
        const budget = yield* Budget.Budget.pipe(Effect.provide(context))
        return {
          first,
          second,
          a: yield* budget.usageOf("budget-shared-a"),
          b: yield* budget.usageOf("budget-shared-b")
        }
      }).pipe(Effect.provide(stores))
    )

    expect(observed.first).toEqual({ approved: true })
    // The second run was not refused on its first call, and the provider
    // answered it.
    expect(observed.second).toEqual({ approved: true })
    expect(calls).toHaveLength(2)
    // Each run reports what it spent, not what the composition spent.
    expect(observed.a).toEqual({ tokens: 600, calls: 1, largestCall: 600 })
    expect(observed.b).toEqual({ tokens: 600, calls: 1, largestCall: 600 })
  }, 60_000)

  it("refuses a new memory-only run when no tally can be safely evicted", async () => {
    const calls: Array<string> = []
    // No journal means no way to recover an evicted allowance. Keep the bound
    // and refuse admission instead of silently erasing the first run's spend.
    const observed = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const context = yield* Layer.build(
          shared(
            Budget.layer({ tokens: { max: 10_000 } }, { maxRuns: 1 }),
            spending(600, [answering(`{"approved":true}`)], calls)
          ).pipe(
            Layer.provideMerge(FlowEngine.layerMemory),
            Layer.provideMerge(NodeCrypto.layer)
          )
        )
        yield* OneStep.execute({ diff: "-  a\n+  b" }, { executionId: "budget-lru-a" }).pipe(
          Effect.provide(context)
        )
        const budget = yield* Budget.Budget.pipe(Effect.provide(context))
        const beforeEviction = yield* budget.usageOf("budget-lru-a")
        const second = yield* OneStep.execute({ diff: "-  c\n+  d" }, { executionId: "budget-lru-b" }).pipe(
          Effect.provide(context),
          Effect.exit
        )
        return {
          beforeEviction,
          afterEviction: yield* budget.usageOf("budget-lru-a"),
          second
        }
      }))
    )

    expect(observed.beforeEviction).toEqual({ tokens: 600, calls: 1, largestCall: 600 })
    expect(observed.afterEviction).toEqual(observed.beforeEviction)
    expect(observed.second._tag).toBe("Failure")
    expect(JSON.stringify(failureOf(observed.second))).toContain("none can be evicted safely")
    expect(calls).toHaveLength(1)
  }, 60_000)
})

describe("a skipped step", () => {
  const skipped = new Budget.Skipped({
    budget: new Budget.BudgetExceeded({
      scope: "tokens",
      onExceeded: "skip-remaining",
      used: 600,
      max: 1_000,
      next: 600,
      message: "the run spent 600 of its 1000 approved tokens"
    }),
    message: "the run stopped making model calls"
  })

  /** Dispatches one action that always fails `Skipped`, under one policy. */
  const dispatch = (tag: string, policy: RetryPolicy.RetryPolicy) => {
    let attempts = 0
    const action = Action.make({
      name: `agent/test/budget/${tag}`,
      success: Schema.Number,
      error: Budget.Skipped,
      retryPolicy: policy,
      execute: Effect.suspend(() => {
        attempts++
        return Effect.fail(skipped)
      })
    })
    const declaration = Action.make(`agent/test/budget/${tag}/declared`, {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Budget.Skipped
    })
    const flow = Flow.make(`agent/test/budget/${tag}/flow`, {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Budget.Skipped,
      body: (payload) => declaration.call(payload)
    })
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: tag }, { executionId: `budget-${tag}` }).pipe(Effect.exit)
      return { attempts, exit }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(declaration.toLayer(() => action), Interpreter.layer(flow)).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  }

  const ladder = RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 3 })

  it("is dispatched once under a policy built through neverRetrySkipped", async () => {
    const observed = await Effect.runPromise(dispatch("skip-guarded", Budget.neverRetrySkipped(ladder)))

    // One dispatch, and the caller sees the verdict itself rather than a
    // retry defect that buried it.
    expect(observed.attempts).toBe(1)
    expect(failureOf(observed.exit)).toMatchObject({ _tag: "flows/agent/Skipped" })
  })

  it("is re-dispatched by a retry ladder that does not name it, which is what the guard is for", async () => {
    const observed = await Effect.runPromise(dispatch("skip-unguarded", ladder))

    expect(observed.attempts).toBe(3)
  })

  it("is classified non-retryable at the engine's own decision point", () => {
    expect(
      RetryPolicy.decide(Budget.neverRetrySkipped(ladder), { attempt: 1, error: skipped })
    ).toMatchObject({ _tag: "GiveUp", reason: "nonRetryable" })
    // Idempotent: a policy that already names the tag is unchanged.
    expect(Budget.neverRetrySkipped(Budget.neverRetrySkipped(ladder)).nonRetryable)
      .toEqual([Budget.skippedTag])
  })
})
