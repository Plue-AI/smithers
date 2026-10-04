import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Journal, StepFact } from "@smthrs/journal"
import type { JournalEvent } from "@smthrs/journal"
import * as Jj from "@smthrs/kernel/Jj"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import * as Crypto from "effect/Crypto"
import * as Agent from "../../src/Agent.ts"
import * as AgentAction from "../../src/AgentAction.ts"
import * as Budget from "../../src/Budget.ts"
import * as EventSink from "../../src/EventSink.ts"
import * as QuotaPolicy from "../../src/QuotaPolicy.ts"
import * as ScriptedJudge from "../../src/ScriptedJudge.ts"
import * as Seat from "../../src/Seat.ts"
import * as SeatResolver from "../../src/SeatResolver.ts"

export const Step = AgentAction.make("agent/test/trace/Step", {
  payload: { input: Schema.String },
  output: Schema.String,
  seat: "test:model",
  prompt: ({ input }) => input
})
export const Single = Flow.make("agent/test/trace/Single", {
  payload: { input: Schema.String },
  success: Schema.String,
  error: AgentAction.AgentFailure,
  body: ({ input }) => Step.call({ input })
})
export const Twice = Flow.make("agent/test/trace/Twice", {
  payload: { input: Schema.String },
  success: Schema.String,
  error: AgentAction.AgentFailure,
  body: ({ input }) => Step.call({ input }).pipe(Node.bindPlanned(() => Step.call({ input })))
})
export const Parallel = Flow.make("agent/test/trace/Parallel", {
  payload: {},
  success: Schema.Struct({ left: Schema.String, right: Schema.String }),
  error: AgentAction.AgentFailure,
  body: () => Node.all({ left: Step.call({ input: "left" }), right: Step.call({ input: "right" }) })
})
export const cell = (source: string) =>
  Stream.fromIterable([
    ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
    ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + source + "\n```" }),
    ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
    ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
  ])
export const answer = () => cell("ctx.done(\"done\")")
export const records = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const rows = []
    let after: JournalEvent.Seq | undefined = undefined
    for (;;) {
      const page: Journal.EntriesPage = yield* journal.entries({
        runId: runId as never,
        limit: 500,
        ...(after === undefined ? {} : { after })
      })
      rows.push(...page.entries)
      if (page.entries.length < 500) return rows
      after = page.entries.at(-1)!.seq
    }
  })
export const facts = (runId: string) =>
  records(runId).pipe(Effect.map((rows) =>
    rows
      .filter((row) => row.eventType === StepFact.eventType).map((row) => ({
        ...row,
        payload: Schema.decodeUnknownSync(StepFact.Fact)(row.payload)
      }))
  ))
export const stores = (filename: string) =>
  Layer.mergeAll(
    TestStores.layerAt(filename),
    StepBoundary.layerTest(),
    NodeCrypto.layer,
    Layer.succeed(
      Jj.Jj,
      Jj.make({
        snapshot: () => Effect.succeed({ commitId: "trace-snapshot" as never, changeId: "trace-snapshot" as never }),
        restore: () => Effect.void,
        diff: () => Effect.succeed(""),
        workspaceAdd: () => Effect.void,
        workspaceForget: () => Effect.void,
        status: () => Effect.succeed("")
      })
    )
  )
export const incarnation = (
  model: Model.Model,
  options: {
    trace?: boolean
    quota?: boolean
    parkAfter?: boolean
    host?: Partial<AgentAction.Host>
  } = {}
) =>
  Effect.gen(function*() {
    const engine = yield* EngineStore.make({
      owner: { hostId: "step-trace" },
      journalSource: "step-trace",
      isAlive: () => Effect.succeed(false)
    })
    const journal = yield* Journal.Journal
    const crypto = yield* Crypto.Crypto
    const runtime = FlowRuntime.FlowRuntime.of({
      ...engine,
      register: (flow, handler) =>
        engine.register(flow, (payload, executionId) =>
          options.trace === false ? handler(payload, executionId) : Effect.gen(function*() {
            const instance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
            if (Option.isNone(instance)) {
              return yield* Effect.die(new Error("Missing handler instance"))
            }
            const sink = yield* EventSink.durable(journal).pipe(
              Effect.provideService(FlowRuntime.FlowInstance, instance.value),
              Effect.provideService(FlowRuntime.FlowRuntime, engine),
              Effect.provideService(Crypto.Crypto, crypto)
            )
            return yield* handler(payload, executionId).pipe(
              Effect.tap(() =>
                options.parkAfter ?
                  DurableDeferred.await(DurableDeferred.make("trace-after-agent", { success: Schema.String })).pipe(
                    Effect.provideService(FlowRuntime.FlowInstance, instance.value),
                    Effect.provideService(FlowRuntime.FlowRuntime, engine)
                  ) :
                  Effect.void
              ),
              Effect.provideService(EventSink.EventSink, sink)
            )
          }))
    })
    return Layer.mergeAll(Step.layer, Interpreter.layer(Single), Interpreter.layer(Twice), Interpreter.layer(Parallel))
      .pipe(
        Layer.provideMerge(AgentAction.layerHost({
          registry: Registry.makeNoop({
            list: () =>
              Effect.succeed([]),
            visible: () =>
              Effect.succeed([]),
            getOption: () => Effect.succeedNone
          }),
          capabilityEnvelope: [],
          limits: { calls: 8 },
          maxFrames: 3,
          modelRetryPolicy: Schedule.recurs(0),
          ...options.host
        })),
        Layer.provideMerge(SeatResolver.layer({
          resolve: (id) =>
            Effect.succeed(
              Seat.make({
                id,
                modelId: Seat.modelIdOf(id),
                model,
                contextWindowTokens: 200_000,
                route: {
                  prepare: () =>
                    Effect.succeed({
                      routeId: "trace",
                      protocolId: "trace",
                      method: "POST",
                      url: "https://example.invalid",
                      publicHeaders: {},
                      body: new TextEncoder().encode("{}"),
                      bodyText: "{}"
                    })
                }
              })
            )
        })),
        Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, ScriptedJudge.layer)),
        Layer.provideMerge(options.quota ? QuotaPolicy.layerDefault() : QuotaPolicy.layerUnclassified()),
        Layer.provideMerge(Budget.layerUnbounded()),
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, runtime))
      )
  })
