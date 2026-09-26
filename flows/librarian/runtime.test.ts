import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Latch, Layer, Schedule, Schema, Scope, Stream } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import { agentRuntime, bounded, BudgetExceeded, hostLimits, LibrarianFailure, ProviderUnavailable } from "./runtime.ts"
import { roleResolver, roles } from "./seats.ts"

const Answer = AgentAction.make("librarian/test-answer", {
  payload: { question: Schema.String },
  output: Schema.String,
  seat: roles[0],
  prompt: ({ question }) => question
})
const Once = Flow.make("librarian/test-once", {
  payload: { question: Schema.String },
  success: Schema.String,
  error: LibrarianFailure,
  body: (input) => Answer.call(input)
})
const Twice = Flow.make("librarian/test-twice", {
  payload: {},
  success: Schema.String,
  error: LibrarianFailure,
  body: () => Answer.call({ question: "first" }).pipe(Node.andThen(Answer.call({ question: "second" })))
})
const model = (dispatch: () => void) =>
  Model.make({
    stream: () => {
      dispatch()
      return Stream.fromIterable(
        [
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", text: "```cell\nctx.done(JSON.stringify(\"answer\"))\n```" },
          { type: "text-end", id: "answer" },
          { type: "usage", totalTokens: 10 },
          { type: "settle", stopReason: "stop" }
        ] as const
      )
    }
  })
const layers = (live: Model.Model, policy: Budget.Policy) =>
  agentRuntime(
    Layer.mergeAll(Answer.layer, Interpreter.layer(Once), Interpreter.layer(Twice)),
    policy
  ).pipe(
    Layer.provideMerge(
      AgentAction.layerHost({ registry: Registry.makeNoop(), ...hostLimits, modelRetryPolicy: Schedule.recurs(0) })
    ),
    Layer.provideMerge(SeatResolver.layer(roleResolver({
      resolve: (id) =>
        Effect.succeed({
          id,
          modelId: "test",
          model: live,
          contextWindowTokens: 200_000,
          route: {
            prepare: () =>
              Effect.succeed({
                routeId: "test",
                protocolId: "test",
                method: "POST",
                url: "http://127.0.0.1",
                publicHeaders: {},
                body: new Uint8Array(),
                bodyText: ""
              })
          }
        })
    }, "anthropic:test"))),
    Layer.provideMerge(Layer.merge(Agent.layer, Agent.layerDefaults)),
    Layer.provideMerge(ScriptedJudge.layer),
    Layer.provideMerge(Layer.merge(Budget.layerUnbounded(), QuotaPolicy.layerUnclassified())),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )

test("real AgentAction surfaces typed token budget failure before a second provider call", async () => {
  let calls = 0
  const failure = await Effect.runPromise(
    Twice.execute({}, { executionId: "budget-test" }).pipe(
      Effect.flip,
      Effect.provide(layers(model(() => calls++), { tokens: { max: 5, onExceeded: "fail" } }))
    )
  )
  assert(Schema.is(BudgetExceeded)(failure), JSON.stringify(failure))
  assert.equal(failure.scope, "tokens")
  assert.equal(calls, 1)
  assert(
    Schema.is(LibrarianFailure)(
      Schema.decodeUnknownSync(LibrarianFailure)(Schema.encodeSync(LibrarianFailure)(failure))
    )
  )
})

test("real AgentAction provider outages survive the enclosing flow error codec", async () => {
  const live = Model.make({
    stream: () =>
      Stream.fail(new ModelError({ code: "provider_internal", message: "Provider temporarily unavailable" }))
  })
  const failure = await Effect.runPromise(
    Once.execute({ question: "explain" }, { executionId: "outage-test" }).pipe(
      Effect.flip,
      Effect.provide(layers(live, { tokens: { max: 100, onExceeded: "fail" } }))
    )
  )
  assert(Schema.is(ProviderUnavailable)(failure), JSON.stringify(failure))
  assert.equal(failure.code, "provider_internal")
  assert.equal(failure.message, "Provider temporarily unavailable")
})

test("latency ceiling refuses the next call after time spent in the provider", async () => {
  let calls = 0
  const failure = await Effect.runPromise(
    Twice.execute({}, { executionId: "latency-test" }).pipe(
      Effect.flip,
      Effect.provide(layers(
        Model.make({
          stream: (request) =>
            Stream.unwrap(Effect.sleep("10 millis").pipe(Effect.as(model(() => calls++).stream(request))))
        }),
        { latency: { maxMillis: 0, onExceeded: "fail" } }
      ))
    )
  )
  assert(Schema.is(BudgetExceeded)(failure), JSON.stringify(failure))
  assert.equal(failure.scope, "latency")
  assert.equal(calls, 1)
})

test("descendants share a root allowance; independent runs and tighter native budgets stay isolated", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const budget = yield* Budget.make({ tokens: { max: 10, onExceeded: "fail" } })
    const child = <A, E, R>(work: Effect.Effect<A, E, R>, rootId: string, executionId: string) =>
      bounded(work, budget).pipe(
        Effect.provideService(ModuleOwner, { rootId, flowId: "librarian/history" }),
        Effect.provideService(FlowRuntime.FlowInstance, {
          executionId,
          lineageId: executionId,
          flow: Once,
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
            keylessInFlight: new Set<string>()
          }
        })
      )
    yield* child(
      Effect.flatMap(Budget.Budget, (service) => service.record("call", { totalTokens: 10 })),
      "run-a",
      "child-a"
    )
    assert.equal(
      (yield* child(Effect.flatMap(Budget.Budget, (service) => service.check("next")), "run-a", "child-b"))._tag,
      "refuse"
    )
    assert.equal(
      (yield* child(Effect.flatMap(Budget.Budget, (service) => service.check("next")), "run-b", "child-c"))._tag,
      "proceed"
    )
    const tighter = yield* Budget.make({ tokens: { max: 0, onExceeded: "fail" } })
    assert.equal(
      (yield* child(Effect.flatMap(Budget.Budget, (service) => service.check("next")), "run-c", "child-d").pipe(
        Effect.provideService(Budget.Budget, tighter)
      ))._tag,
      "refuse"
    )
  }))
})
