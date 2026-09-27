/**
 * Resume a model-backed action after a rate limit and an invalid structured
 * answer.
 *
 * The scripted provider first returns HTTP 429 with a retry delay, then an
 * answer outside the schema, then valid JSON after correction. A second engine
 * continues from the parked state in the same SQLite file.
 *
 * The summary checks provider call counts, the recorded park decision, and the
 * structured-output rejection. No provider credentials are needed.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Journal, type JournalEvent } from "@smthrs/journal"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import * as Registry from "@smthrs/registry/Registry"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { durableEngine } from "./durable-layer.ts"

/** The declared answer shape. Nothing downstream parses model text. */
const Review = Schema.Struct({
  approved: Schema.Boolean,
  issues: Schema.Array(Schema.String)
})

/**
 * The step. `corrections: 1` says one re-prompt, and the re-prompt repeats the
 * task verbatim with the validation issues appended.
 */
export const Reviewer = AgentAction.make("examples/PolicyReviewer", {
  payload: { diff: Schema.String },
  output: Review,
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You review diffs and report whether they are approvable."],
  prompt: ({ diff }) => `Review this diff:\n${diff}`,
  corrections: 1
})

/** The flow: one step, so the policies are the only thing on show. */
export const ReviewFlow = Flow.make("examples/PolicyReviewFlow", {
  payload: { diff: Schema.String },
  success: Review,
  error: AgentAction.AgentFailure,
  body: ({ diff }) => Reviewer.call({ diff })
})

const prepared: Route.PreparedRequest = {
  routeId: "examples",
  protocolId: "examples",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

/** A cell that finishes the turn with one literal answer. */
const answering = (output: string): string => `ctx.done(${JSON.stringify(output)})`

/**
 * The refusal a real provider sends when a window is closed: HTTP 429 with the
 * seconds until it reopens. `retryAfterMillis` is what the classifier turns
 * into the wake time.
 */
const refusal = new ModelError({
  code: "rate_limited",
  message: "Too many requests",
  retryAfterMillis: 1_000,
  httpStatus: 429
})

/**
 * The scripted provider. `calls` counts what actually reached it, which is how
 * a replayed step is told apart from a re-issued one.
 */
const scripted = (calls: Array<string>): Model.Model =>
  Model.make({
    stream: () =>
      Stream.suspend(() => {
        calls.push("call")
        if (calls.length === 1) return Stream.fail(refusal)
        const cell = calls.length === 2
          ? answering("Looks fine to me.")
          : answering(`{"approved":true,"issues":[]}`)
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: "cell",
            text: "```cell\n" + cell + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.ModelEvent.Usage({ totalTokens: 400 }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })

/**
 * The composition half. `Host` carries what every model-backed action in this
 * composition shares. The default classifier is the behavior this example is
 * demonstrating, and the written token ceiling is the one the example chose.
 * A host opting out would say `layerUnclassified()` and `layerUnbounded()`.
 */
const policies = (calls: Array<string>) =>
  Layer.mergeAll(
    AgentAction.layerHost({
      registry: Registry.makeNoop({
        list: () => Effect.succeed([]),
        visible: () => Effect.succeed([]),
        getOption: () => Effect.succeed(Option.none())
      }),
      limits: { calls: 8 },
      capabilityEnvelope: [],
      maxFrames: 4,
      // A quota refusal is not a transport hiccup, so the transport ladder is
      // off: the park is the only thing that waits.
      modelRetryPolicy: Schedule.recurs(0)
    }),
    SeatResolver.layer({
      resolve: (id) =>
        Effect.succeed(
          Seat.make({
            id,
            modelId: Seat.modelIdOf(id),
            model: scripted(calls),
            route: { prepare: () => Effect.succeed(prepared) },
            contextWindowTokens: 200_000
          })
        )
    }),
    Agent.layer
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        QuotaPolicy.layerDefault(),
        // A ceiling in `warn`: the run reports what it spends without being
        // stopped, which is how a budget is introduced to a live workflow.
        // Under `fail` the same ceiling would end the step instead.
        Budget.layer({ tokens: { max: 500, onExceeded: "warn" } })
      )
    ),
    // The completion brake judges every claim, and never falls back to the
    // model. This example scripts the judge the way it scripts the seat, so it
    // still needs no key. A host with a resolved seat binds
    // `Evaluator.layerFromSeat(judgeSeat)` instead.
    Layer.provideMerge(
      ScriptedJudge.layer
    )
  )

const engine = (filename: string, hostId: string, calls: Array<string>) =>
  Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)).pipe(
    Layer.provideMerge(policies(calls)),
    Layer.provideMerge(Agent.layerDefaults),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(durableEngine(filename, hostId)),
    Layer.provideMerge(NodeCrypto.layer)
  )

/** Waits for the parked run to appear in the operator's own view of waits. */
const waitForPark = (state: DurableEngineState.Service) =>
  Effect.gen(function*() {
    for (let poll = 0; poll < 400; poll++) {
      const rows = yield* state.waitingRuns({ reason: "quota" })
      if (rows.length > 0) return rows
      yield* Effect.sleep("10 millis")
    }
    return yield* state.waitingRuns({ reason: "quota" })
  })

/** What the run left behind, read back from its own durable trail. */
export interface Summary {
  readonly review: typeof Review.Type
  readonly providerCalls: number
  readonly callsBeforeTheRestart: number
  readonly wakeAt: number
  readonly parks: number
  readonly corrections: number
  readonly budgetWarnings: number
}

const executionId = "policy-review-1"

export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    const calls: Array<string> = []

    // Phase one: the provider refuses, the run parks under the quota reason,
    // and the engine is then killed while the run is still waiting.
    const waiting = yield* Effect.scoped(
      Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        const running = yield* ReviewFlow.execute({ diff: "-  old\n+  new" }, { executionId }).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const rows = yield* waitForPark(state)
        yield* Fiber.interrupt(running)
        return rows
      }).pipe(Effect.provide(engine(filename, "worker-a", calls)))
    )
    const callsBeforeTheRestart = calls.length

    // Phase two: a second engine over the same file waits out the deadline the
    // first one recorded, spends the correction, and finishes the run.
    const finished = yield* Effect.scoped(
      Effect.gen(function*() {
        const review = yield* ReviewFlow.execute({ diff: "-  old\n+  new" }, { executionId })
        const journal = yield* Journal.Journal
        yield* journal.flush
        const page = yield* journal.entries({ runId: executionId as JournalEvent.RunId, limit: 500 })
        const count = (eventType: string) => page.entries.filter((entry) => entry.eventType === eventType).length
        return {
          review,
          parks: count(QuotaPolicy.quotaParkedEvent),
          corrections: count(AgentAction.structuredOutputRejectedEvent),
          budgetWarnings: count(Budget.budgetWarningEvent)
        }
      }).pipe(Effect.provide(engine(filename, "worker-b", calls)))
    )

    return {
      ...finished,
      providerCalls: calls.length,
      callsBeforeTheRestart,
      wakeAt: waiting[0]?.wakeAt ?? 0
    }
  }).pipe(Effect.orDie)
