/**
 * A model-backed step declared the way a workflow author declares one, run as
 * a step inside an ordinary flow.
 *
 * Everything under the declaration is production: the real durable engine, the
 * real QuickJS sandbox, the real cell controller, the real registry-backed call
 * bridge. Only the provider is scripted, which is what makes the test
 * deterministic and CI-safe — there is no API key anywhere in it.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Jj from "@smthrs/kernel/Jj"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import * as ObservabilityMetric from "@smthrs/observability/Metric"
import { Node } from "@smthrs/plan"
import { make as makePlugin } from "@smthrs/plugin"
import type { FlowsHooks } from "@smthrs/plugin"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Metric,
  Option,
  Schedule,
  Schema,
  SchemaGetter,
  Stream
} from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentAction from "../src/AgentAction.ts"
import * as Budget from "../src/Budget.ts"
import * as EventSink from "../src/EventSink.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as QuotaPolicy from "../src/QuotaPolicy.ts"
import { layer as scriptedCompletionJudge } from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"
import * as SeatRouter from "../src/SeatRouter.ts"
import * as StandardFlows from "../src/StandardFlows.ts"
import * as Safety from "./Safety.ts"

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

/**
 * A model that answers with one scripted cell per call and records the prompt
 * it was given, so the test can assert what the schema teaching contained.
 */
const scripted = (cells: ReadonlyArray<string>, requests: Array<string>): Model.Model => {
  let index = 0
  return Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        requests.push(
          request.system.map((part) => part.text).join("\n") + "\n" +
            request.messages.flatMap((message) =>
              message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
            ).join("\n")
        )
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
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })
}

/** A cell that completes immediately with a literal answer. */
const answering = (output: string): string => `ctx.done(${JSON.stringify(output)})`

const emptyRegistry: Registry.Registry = Registry.makeNoop({
  list: () => Effect.succeed([]),
  visible: () => Effect.succeed([]),
  getOption: () => Effect.succeed(Option.none())
})

const host: AgentAction.Host = {
  registry: emptyRegistry,
  limits: { calls: 8 },
  capabilityEnvelope: [],
  maxFrames: 3
}

/** The other half of the seam: a scripted model behind the host's resolver. */
const seats = (model: Model.Model): Layer.Layer<SeatResolver.SeatResolver> =>
  SeatResolver.layer({
    resolve: (id) =>
      Effect.succeed(Seat.make({ id, modelId: Seat.modelIdOf(id), model, route, contextWindowTokens: 200_000 }))
  })

const Review = Schema.Struct({
  approved: Schema.Boolean,
  issues: Schema.Array(Schema.String)
})

const Reviewer = AgentAction.make("agent/test/Reviewer", {
  payload: { diff: Schema.String },
  output: Review,
  seat: "anthropic:test-model",
  system: ["You review diffs."],
  prompt: ({ diff }) => `Review this diff:\n${diff}`
})

const ReviewFlow = Flow.make("agent/test/ReviewFlow", {
  payload: { diff: Schema.String },
  success: Review,
  error: AgentAction.AgentFailure,
  body: ({ diff }) => Reviewer.call({ diff })
})

/** A step whose frame budget runs out before the cell ever completes. */
const Staller = AgentAction.make("agent/test/Staller", {
  payload: { diff: Schema.String },
  output: Review,
  seat: "anthropic:test-model",
  prompt: ({ diff }) => `Review this diff:\n${diff}`,
  maxFrames: 1
})

const Stalling = Flow.make("agent/test/Stalling", {
  payload: { diff: Schema.String },
  success: Review,
  error: AgentAction.AgentFailure,
  body: ({ diff }) => Staller.call({ diff })
})

const run = (
  cells: ReadonlyArray<string>,
  requests: Array<string>,
  executionId: string
) =>
  ReviewFlow.execute({ diff: "-  old\n+  new" }, { executionId }).pipe(
    Effect.provide(
      Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)).pipe(
        Layer.provideMerge(AgentAction.layerHost(host)),
        Layer.provideMerge(seats(scripted(cells, requests))),
        Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
        Layer.provideMerge(Safety.layer),
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(NodeCrypto.layer)
      )
    )
  )

describe("AgentAction.make", () => {
  it("runs a discovered markdown child through the host prompt runner", async () => {
    const rendered: Array<string> = []
    const descriptor = new Descriptor.FlowDescriptor({
      name: "review",
      description: "Review a diff.",
      body: new Descriptor.BodyRefMarkdown({ path: "/flows/review/flow.md", baseDirectory: "/flows/review" }),
      input: new Descriptor.SchemaRefNone(),
      output: new Descriptor.SchemaRefNone(),
      model: Option.some("anthropic:test-model"),
      flows: [],
      capabilities: [],
      effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
      placement: Option.none(),
      modelInvocable: true,
      path: "/flows/review",
      frontmatter: {},
      provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
    })
    const result = await Effect.runPromise(
      ReviewFlow.execute({ diff: "diff" }, { executionId: "markdown-child" }).pipe(
        Effect.provide(stack(Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)), {
          ...host,
          registry: Registry.makeNoop({
            visible: () => Effect.succeed([descriptor]),
            getOption: () => Effect.succeed(Option.some(descriptor)),
            runPrompt: (_name, input) => Effect.succeed(`Review ${input.args}`)
          }),
          promptRunner: ({ text }) =>
            Effect.sync(() => {
              rendered.push(text)
              return new Cell.CallResult({ outcome: "success", value: JSON.stringify({ approved: true, issues: [] }) })
            })
        }, scripted([`const answer = await ctx.call("review", { args: "diff" }); ctx.done(String(answer))`], [])))
      )
    )
    expect(rendered).toEqual(["Review diff"])
    expect(result).toEqual({ approved: true, issues: [] })
  })

  it("runs the cell loop as one step and yields the schema-typed answer", async () => {
    const requests: Array<string> = []
    const result = await Effect.runPromise(
      run([answering(`{"approved":true,"issues":[]}`)], requests, "review-1")
    )

    expect(result).toEqual({ approved: true, issues: [] })

    // The declaration's own teaching and the rendered output schema both
    // reached the provider, and so did the prompt built from the payload.
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain("You review diffs.")
    expect(requests[0]).toContain("Required output shape")
    expect(requests[0]).toContain("\"approved\"")
    expect(requests[0]).toContain("Review this diff:")
  })

  it("extracts the answer from prose around it rather than demanding a bare document", async () => {
    const requests: Array<string> = []
    const result = await Effect.runPromise(
      run(
        [answering(`Here is my review:\n\n{"approved":false,"issues":["missing test"]}\n\nHope that helps.`)],
        requests,
        "review-2"
      )
    )

    expect(result).toEqual({ approved: false, issues: ["missing test"] })
    expect(requests).toHaveLength(1)
  })

  it("spends one correction slot re-prompting a decode miss, then succeeds", async () => {
    const requests: Array<string> = []
    const result = await Effect.runPromise(
      run(
        [
          answering("Looks fine to me."),
          answering(`{"approved":true,"issues":[]}`)
        ],
        requests,
        "review-3"
      )
    )

    expect(result).toEqual({ approved: true, issues: [] })
    expect(requests).toHaveLength(2)
    // The correction restates the task and adds the diagnostics; it never
    // reinterprets the step.
    expect(requests[1]).toContain("Review this diff:")
    expect(requests[1]).toContain("did not validate")
  })

  it("corrects a schema miss in the same session, keeping its realm and repeating no call", async () => {
    const calls: Array<string> = []
    const requests: Array<string> = []
    const events: Array<AgentEvent.AgentEvent> = []
    const descriptor = new Descriptor.FlowDescriptor({
      name: "inspect",
      description: "Inspect a diff.",
      body: new Descriptor.BodyRefMarkdown({ path: "/flows/inspect/flow.md", baseDirectory: "/flows/inspect" }),
      input: new Descriptor.SchemaRefNone(),
      output: new Descriptor.SchemaRefNone(),
      model: Option.some("anthropic:test-model"),
      flows: [],
      capabilities: [],
      effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
      placement: Option.none(),
      modelInvocable: true,
      path: "/flows/inspect",
      frontmatter: {},
      provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
    })
    const counters = Effect.all([
      Metric.value(ObservabilityMetric.structuredOutputRejections),
      Metric.value(ObservabilityMetric.structuredOutputExhausted)
    ])
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const before = yield* counters
        const result = yield* ReviewFlow.execute({ diff: "diff" }, { executionId: "same-session" })
        const after = yield* counters
        return { result, before, after }
      }).pipe(
        Effect.provide(stack(
          Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)),
          {
            ...host,
            registry: Registry.makeNoop({
              visible: () => Effect.succeed([descriptor]),
              getOption: () => Effect.succeed(Option.some(descriptor)),
              runPrompt: (_name, input) => Effect.succeed(`Inspect ${input.args}`)
            }),
            promptRunner: ({ text }) =>
              Effect.sync(() => {
                calls.push(text)
                return new Cell.CallResult({ outcome: "success", value: "expensive-tool-output-7f3a" })
              })
          },
          scripted([
            [
              `const inspected = await ctx.call("inspect", { args: "diff" })`,
              `console.log(inspected)`,
              `ctx.done("Looks fine to me.")`
            ].join("\n"),
            `ctx.done({ approved: inspected.endsWith("7f3a"), issues: [] })`
          ], requests)
        )),
        Effect.provideService(
          EventSink.EventSink,
          EventSink.make({ emit: (event) => Effect.sync(() => void events.push(event)) })
        )
      )
    )

    expect(observed.result).toEqual({ approved: true, issues: [] })
    // The expensive call ran once, and the correction read its printed result
    // and its binding instead of asking for it again.
    expect(calls).toEqual(["Inspect diff"])
    expect(requests).toHaveLength(2)
    expect(requests[1]).toContain("expensive-tool-output-7f3a")
    expect(requests[1]).toContain("did not validate")
    expect(requests[1]).toContain("- inspected (string")
    expect(events.filter((event) => event._tag === "output-demanded")).toHaveLength(1)
    expect(observed.after[0].count - observed.before[0].count).toBe(1)
    expect(observed.after[1].count - observed.before[1].count).toBe(0)
  })

  it("falls back to a fresh session when the run has no frame left to correct in", async () => {
    const OneFrame = AgentAction.make("agent/test/OneFrame", {
      payload: { diff: Schema.String },
      output: Review,
      seat: "anthropic:test-model",
      prompt: ({ diff }) => `Review this diff:\n${diff}`,
      maxFrames: 1
    })
    const OneFrameFlow = Flow.make("agent/test/OneFrameFlow", {
      payload: { diff: Schema.String },
      success: Review,
      error: AgentAction.AgentFailure,
      body: ({ diff }) => OneFrame.call({ diff })
    })
    const requests: Array<string> = []
    const events: Array<AgentEvent.AgentEvent> = []
    const result = await Effect.runPromise(
      OneFrameFlow.execute({ diff: "diff" }, { executionId: "fresh-fallback" }).pipe(
        Effect.provide(stack(
          Layer.mergeAll(OneFrame.layer, Interpreter.layer(OneFrameFlow)),
          host,
          scripted([
            `console.log("first-session-7f3a"); ctx.done("Looks fine to me.")`,
            answering(`{"approved":true,"issues":[]}`)
          ], requests)
        )),
        Effect.provideService(
          EventSink.EventSink,
          EventSink.make({ emit: (event) => Effect.sync(() => void events.push(event)) })
        )
      )
    )

    expect(result).toEqual({ approved: true, issues: [] })
    expect(requests).toHaveLength(2)
    // A new session: the task restated with the diagnostics, and nothing the
    // first session printed.
    expect(requests[1]).toContain("Review this diff:")
    expect(requests[1]).toContain("did not validate")
    expect(requests[1]).not.toContain("first-session-7f3a")
    expect(events.filter((event) => event._tag === "output-demanded")).toHaveLength(0)
  })

  it("fails typed when the run ends without a completed answer", async () => {
    const requests: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        Stalling.execute({ diff: "-  old\n+  new" }, { executionId: "review-5" }).pipe(
          Effect.provide(
            Layer.mergeAll(Staller.layer, Interpreter.layer(Stalling)).pipe(
              Layer.provideMerge(AgentAction.layerHost(host)),
              Layer.provideMerge(
                seats(scripted([""], requests))
              ),
              Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
              Layer.provideMerge(Safety.layer),
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(FlowEngine.layerMemory),
              Layer.provideMerge(NodeCrypto.layer)
            )
          )
        )
      )
    )

    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("FramesExhausted")
    expect(JSON.stringify(exit._tag === "Failure" ? exit.cause : undefined)).toContain(
      "ended without a completed answer"
    )
  })

  it("stops an idle run at its read-only cap before the frame budget", async () => {
    const Idler = AgentAction.make("agent/test/Idler", {
      payload: { diff: Schema.String },
      output: Review,
      seat: "anthropic:test-model",
      prompt: ({ diff }) => `Edit for this diff:\n${diff}`,
      maxFrames: 20,
      readOnlyCap: 1
    })
    const Idling = Flow.make("agent/test/Idling", {
      payload: { diff: Schema.String },
      success: Review,
      error: AgentAction.AgentFailure,
      body: ({ diff }) => Idler.call({ diff })
    })
    const requests: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        Idling.execute({ diff: "-  old\n+  new" }, { executionId: "idle-1" }).pipe(
          Effect.provide(
            Layer.mergeAll(Idler.layer, Interpreter.layer(Idling)).pipe(
              Layer.provideMerge(AgentAction.layerHost(host)),
              Layer.provideMerge(seats(scripted(Array.from({ length: 20 }, () => ""), requests))),
              Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
              Layer.provideMerge(Safety.layer),
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(FlowEngine.layerMemory),
              Layer.provideMerge(NodeCrypto.layer)
            )
          )
        )
      )
    )

    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("read_only_cap")
    expect(requests.length).toBeLessThan(20)
  })

  it("fails typed when the correction budget is exhausted", async () => {
    const requests: Array<string> = []
    const exhausted = Metric.value(ObservabilityMetric.structuredOutputExhausted)
    const before = await Effect.runPromise(exhausted)
    const exit = await Effect.runPromise(
      Effect.exit(run([answering("Looks fine to me.")], requests, "review-4"))
    )
    expect((await Effect.runPromise(exhausted)).count - before.count).toBe(1)

    expect(exit._tag).toBe("Failure")
    const failure = exit._tag === "Failure" ? exit.cause : undefined
    const rendered = JSON.stringify(failure)
    expect(rendered).toContain("StructuredOutputFailure")
    // One first attempt plus one same-session correction, and no third call.
    expect(requests).toHaveLength(2)
    expect(requests[1]).toContain("did not validate")
  })
})

/**
 * Composes the host half beneath one declared step.
 *
 * The seam is the point: an action's own layer plus its flow's interpreter go
 * on top, and everything under them — the host composition, the seat resolver
 * and its scripted model, the agent, the engine — is what a case varies.
 */
const stack = <ROut, RIn>(
  step: Layer.Layer<ROut, never, RIn>,
  host: AgentAction.Host,
  model: Model.Model
) =>
  step.pipe(
    Layer.provideMerge(AgentAction.layerHost(host)),
    Layer.provideMerge(seats(model)),
    Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
    Layer.provideMerge(Safety.layer),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )

describe("AgentAction completion value types", () => {
  const Output = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])
  const Typed = AgentAction.make("agent/test/TypedCompletion", {
    payload: {},
    output: Output,
    seat: "anthropic:test-model",
    prompt: () => "Return the requested value.",
    corrections: 0
  })
  const TypedFlow = Flow.make("agent/test/TypedCompletionFlow", {
    payload: {},
    success: Output,
    error: AgentAction.AgentFailure,
    body: () => Typed.call({})
  })

  it.each(["12", "true", "null", "\"hello\"", "", " 12 ", 12, true, false, null])(
    "preserves the type and contents passed to ctx.done (%j)",
    async (value) => {
      const requests: Array<string> = []
      const result = await Effect.runPromise(
        TypedFlow.execute({}, { executionId: `typed-completion-${JSON.stringify(value)}` }).pipe(
          Effect.provide(stack(
            Layer.mergeAll(Typed.layer, Interpreter.layer(TypedFlow)),
            host,
            scripted([`ctx.done(${JSON.stringify(value)})`], requests)
          ))
        )
      )
      expect(result).toBe(value)
      expect(requests).toHaveLength(1)
    }
  )

  it.each(["", "12"])("reports the string refinement for ctx.done(%j)", async (value) => {
    const NonEmpty = AgentAction.make("agent/test/RefinedCompletion", {
      payload: {},
      output: Schema.String.check(Schema.isMinLength(3)),
      seat: "anthropic:test-model",
      prompt: () => "Return at least three characters.",
      corrections: 0
    })
    const RefinedFlow = Flow.make("agent/test/RefinedCompletionFlow", {
      payload: {},
      success: Schema.String,
      error: AgentAction.AgentFailure,
      body: () => NonEmpty.call({})
    })
    const result = await Effect.runPromise(Effect.result(
      RefinedFlow.execute({}, { executionId: `refined-completion-${JSON.stringify(value)}` }).pipe(
        Effect.provide(stack(
          Layer.mergeAll(NonEmpty.layer, Interpreter.layer(RefinedFlow)),
          host,
          scripted([answering(value)], [])
        ))
      )
    ))
    expect(result._tag).toBe("Failure")
    const failure = result._tag === "Failure" ? result.failure : undefined
    expect(failure).toMatchObject({
      _tag: "/harness/StructuredOutputFailure",
      issues: [{ code: "constraint", path: "", message: "Expected a value with a length of at least 3" }]
    })
  })
})

describe("AgentAction human approval channel", () => {
  it.each([undefined, false, true])("arms the host's declared approval channel (%s)", async (approvalChannel) => {
    const armed: Array<boolean> = []
    const requests: Array<string> = []
    const configured = { ...host, approvalChannel }
    const value = await Effect.runPromise(
      ReviewFlow.execute({ diff: "change" }, { executionId: `approval-${approvalChannel}` }).pipe(
        Effect.provide(Layer.merge(
          stack(
            Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)),
            configured,
            scripted([answering("{\"approved\":true,\"issues\":[]}")], requests)
          ),
          EventSink.layer({
            emit: (event) =>
              Effect.sync(() => {
                if (event._tag === "discipline-armed") armed.push(event.approvalChannel)
              })
          })
        ))
      )
    )
    expect(value).toEqual({ approved: true, issues: [] })
    expect(armed).toEqual([approvalChannel ?? false])
  })

  it("parks a real durable agent step when the host can answer", async () => {
    const requests: Array<string> = []
    const armed: Array<boolean> = []
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        yield* ReviewFlow.execute({ diff: "change" }, { executionId: "approval-park", discard: true })
        for (let attempt = 0; attempt < 2_000; attempt++) {
          const observed = yield* ReviewFlow.poll("approval-park")
          if (Option.isSome(observed) && observed.value._tag === "Suspended") return observed.value._tag
          yield* Effect.yieldNow
        }
        return "did not suspend"
      }).pipe(
        Effect.provide(Layer.merge(
          stack(
            Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)),
            { ...host, approvalChannel: true },
            scripted(["ctx.park(\"waiting-input\", \"Which branch?\")"], requests)
          ),
          EventSink.layer({
            emit: (event) =>
              Effect.sync(() => {
                if (event._tag === "discipline-armed") armed.push(event.approvalChannel)
              })
          })
        )),
        Effect.scoped
      )
    )
    expect(result).toBe("Suspended")
    expect(armed).toEqual([true])
    expect(requests).toHaveLength(1)
  })
})

/** A cell that continues forever, projecting a different window every frame. */
const stalling = `var seen = (typeof seen === "number" ? seen : 0) + 1
console.log("again " + seen)`

describe("AgentAction correction budgets", () => {
  it("rejects non-finite, fractional, and negative budgets at declaration time", () => {
    for (const corrections of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(() =>
        AgentAction.make("agent/test/InvalidBudget", {
          payload: { diff: Schema.String },
          output: Review,
          seat: "anthropic:test-model",
          prompt: ({ diff }) => diff,
          corrections
        })
      ).toThrow(AgentAction.InvalidCorrectionBudget)
    }
  })

  const Zero = AgentAction.make("agent/test/Zero", {
    payload: { diff: Schema.String },
    output: Review,
    seat: "anthropic:test-model",
    prompt: ({ diff }) => `Review this diff:\n${diff}`,
    corrections: 0
  })
  const ZeroFlow = Flow.make("agent/test/ZeroFlow", {
    payload: { diff: Schema.String },
    success: Review,
    error: AgentAction.AgentFailure,
    body: ({ diff }) => Zero.call({ diff })
  })

  const Three = AgentAction.make("agent/test/Three", {
    payload: { diff: Schema.String },
    output: Review,
    seat: "anthropic:test-model",
    prompt: ({ diff }) => `Review this diff:\n${diff}`,
    corrections: 3
  })
  const ThreeFlow = Flow.make("agent/test/ThreeFlow", {
    payload: { diff: Schema.String },
    success: Review,
    error: AgentAction.AgentFailure,
    body: ({ diff }) => Three.call({ diff })
  })

  it("makes the first miss terminal when no correction is budgeted", async () => {
    const requests: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        ZeroFlow.execute({ diff: "-  old\n+  new" }, { executionId: "corrections-0" }).pipe(
          Effect.provide(
            stack(
              Layer.mergeAll(Zero.layer, Interpreter.layer(ZeroFlow)),
              host,
              scripted([answering("Looks fine to me.")], requests)
            )
          )
        )
      )
    )

    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("StructuredOutputFailure")
    // Zero really is zero: the model was asked once and never re-prompted.
    expect(requests).toHaveLength(1)
  })

  it("spends every budgeted correction before it gives up", async () => {
    const requests: Array<string> = []
    // Each answer differs, so each correction re-prompt is a distinct request.
    // Repeating one answer would make the later re-prompts byte-identical and
    // the engine would replay a recorded provider call instead of making one,
    // which would count the step cache rather than the budget.
    const exit = await Effect.runPromise(
      Effect.exit(
        ThreeFlow.execute({ diff: "-  old\n+  new" }, { executionId: "corrections-3-exhausted" }).pipe(
          Effect.provide(
            stack(
              Layer.mergeAll(Three.layer, Interpreter.layer(ThreeFlow)),
              host,
              scripted(
                ["nope one", "nope two", "nope three", "nope four", "nope five"].map(answering),
                requests
              )
            )
          )
        )
      )
    )

    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("StructuredOutputFailure")
    // One first attempt plus three corrections, and no fifth call.
    expect(requests).toHaveLength(4)
  })

  it("stops re-prompting the moment a correction lands, short of the budget", async () => {
    const requests: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        ThreeFlow.execute({ diff: "-  old\n+  new" }, { executionId: "corrections-3-recovered" }).pipe(
          Effect.provide(stack(
            Layer.mergeAll(Three.layer, Interpreter.layer(ThreeFlow)),
            host,
            scripted(
              [answering("nope"), answering("still nope"), answering(`{"approved":true,"issues":[]}`)],
              requests
            )
          ))
        )
      )
    )

    expect(exit).toMatchObject({ _tag: "Success", value: { approved: true, issues: [] } })
    expect(requests).toHaveLength(3)
    // Every correction restates the task and adds the diagnostics.
    expect(requests[1]).toContain("did not validate")
    expect(requests[2]).toContain("did not validate")
  })
})

describe("AgentAction output schemas", () => {
  const Nested = Schema.Struct({
    verdict: Schema.Struct({ approved: Schema.Boolean, score: Schema.Number }),
    notes: Schema.Array(Schema.Struct({ file: Schema.String, line: Schema.Number }))
  })
  const NestedAction = AgentAction.make("agent/test/Nested", {
    payload: { diff: Schema.String },
    output: Nested,
    seat: "anthropic:test-model",
    prompt: () => "Review it."
  })
  const NestedFlow = Flow.make("agent/test/NestedFlow", {
    payload: { diff: Schema.String },
    success: Nested,
    error: AgentAction.AgentFailure,
    body: ({ diff }) => NestedAction.call({ diff })
  })

  const Empty = Schema.Struct({})
  const EmptyAction = AgentAction.make("agent/test/Empty", {
    payload: { diff: Schema.String },
    output: Empty,
    seat: "anthropic:test-model",
    prompt: () => "Review it."
  })
  const EmptyFlow = Flow.make("agent/test/EmptyFlow", {
    payload: { diff: Schema.String },
    success: Empty,
    error: AgentAction.AgentFailure,
    body: ({ diff }) => EmptyAction.call({ diff })
  })

  it("teaches and enforces a nested schema, and refuses an answer that misses one leaf", async () => {
    const requests: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        NestedFlow.execute({ diff: "-  old\n+  new" }, { executionId: "nested-1" }).pipe(
          Effect.provide(stack(
            Layer.mergeAll(NestedAction.layer, Interpreter.layer(NestedFlow)),
            host,
            scripted(
              [
                // The first answer omits `line` from one note: the miss is one level
                // down inside an array, which is exactly where a flat check passes
                // and a real decode does not.
                answering(`{"verdict":{"approved":true,"score":1},"notes":[{"file":"a.ts"}]}`),
                answering(`{"verdict":{"approved":true,"score":1},"notes":[{"file":"a.ts","line":4}]}`)
              ],
              requests
            )
          ))
        )
      )
    )

    expect(exit).toMatchObject({
      _tag: "Success",
      value: { verdict: { approved: true, score: 1 }, notes: [{ file: "a.ts", line: 4 }] }
    })
    expect(requests).toHaveLength(2)
    expect(requests[0]).toContain("verdict")
    expect(requests[0]).toContain("notes")
  })

  it("accepts an empty document for a schema that declares no fields", async () => {
    const requests: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        EmptyFlow.execute({ diff: "-  old\n+  new" }, { executionId: "empty-1" }).pipe(
          Effect.provide(
            stack(
              Layer.mergeAll(EmptyAction.layer, Interpreter.layer(EmptyFlow)),
              host,
              scripted([answering("{}")], requests)
            )
          )
        )
      )
    )

    expect(exit).toMatchObject({ _tag: "Success", value: {} })
    expect(requests).toHaveLength(1)
  })
})

describe("AgentAction frame budgets and system teaching", () => {
  const Inheriting = AgentAction.make("agent/test/Inheriting", {
    payload: { diff: Schema.String },
    output: Review,
    seat: "anthropic:test-model",
    system: ["The action's own teaching."],
    prompt: () => "Review it."
  })
  const InheritingFlow = Flow.make("agent/test/InheritingFlow", {
    payload: { diff: Schema.String },
    success: Review,
    error: AgentAction.AgentFailure,
    body: ({ diff }) => Inheriting.call({ diff })
  })

  const Overriding = AgentAction.make("agent/test/Overriding", {
    payload: { diff: Schema.String },
    output: Review,
    seat: "anthropic:test-model",
    prompt: () => "Review it.",
    maxFrames: 1
  })
  const OverridingFlow = Flow.make("agent/test/OverridingFlow", {
    payload: { diff: Schema.String },
    success: Review,
    error: AgentAction.AgentFailure,
    body: ({ diff }) => Overriding.call({ diff })
  })

  const hostFrames = (maxFrames: number): AgentAction.Host => ({ ...host, maxFrames })

  it("inherits the host's frame budget when the action declares none", async () => {
    const requests: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        InheritingFlow.execute({ diff: "-  old\n+  new" }, { executionId: "frames-inherit" }).pipe(
          Effect.provide(
            stack(
              Layer.mergeAll(Inheriting.layer, Interpreter.layer(InheritingFlow)),
              hostFrames(3),
              scripted([stalling], requests)
            )
          )
        )
      )
    )

    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("ended without a completed answer")
    expect(requests).toHaveLength(3)
  })

  it("overrides the host's frame budget with its own, in the narrowing direction", async () => {
    const requests: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        OverridingFlow.execute({ diff: "-  old\n+  new" }, { executionId: "frames-narrow" }).pipe(
          Effect.provide(
            stack(
              Layer.mergeAll(Overriding.layer, Interpreter.layer(OverridingFlow)),
              hostFrames(3),
              scripted([stalling], requests)
            )
          )
        )
      )
    )

    expect(exit._tag).toBe("Failure")
    expect(requests).toHaveLength(1)
  })

  it("overrides the host's frame budget with its own, in the widening direction", async () => {
    const requests: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        InheritingFlow.execute({ diff: "-  old\n+  new" }, { executionId: "frames-host-one" }).pipe(
          Effect.provide(
            stack(
              Layer.mergeAll(Inheriting.layer, Interpreter.layer(InheritingFlow)),
              hostFrames(1),
              scripted([stalling], requests)
            )
          )
        )
      )
    )

    expect(exit._tag).toBe("Failure")
    // The host's own budget applies, so the same declaration that got three
    // frames above gets one here: the two numbers are not merged.
    expect(requests).toHaveLength(1)
  })

  it("orders host teaching, then the action's, then the schema's, in one system context", async () => {
    const requests: Array<string> = []
    await Effect.runPromise(
      Effect.exit(
        InheritingFlow.execute({ diff: "-  old\n+  new" }, { executionId: "system-order" }).pipe(
          Effect.provide(
            stack(Layer.mergeAll(Inheriting.layer, Interpreter.layer(InheritingFlow)), {
              ...hostFrames(2),
              system: ["The host's shared teaching."]
            }, scripted([answering(`{"approved":true,"issues":[]}`)], requests))
          )
        )
      )
    )

    const rendered = requests[0]!
    const hostAt = rendered.indexOf("The host's shared teaching.")
    const actionAt = rendered.indexOf("The action's own teaching.")
    const schemaAt = rendered.indexOf("Required output shape")
    expect(hostAt).toBeGreaterThanOrEqual(0)
    expect(hostAt).toBeLessThan(actionAt)
    expect(actionAt).toBeLessThan(schemaAt)
  })
})

describe("AgentAction refusals that never reach the provider", () => {
  const Checked = AgentAction.make("agent/test/Checked", {
    payload: { diff: Schema.String.check(Schema.isMinLength(8)) },
    output: Review,
    seat: "anthropic:test-model",
    prompt: ({ diff }) => `Review this diff:\n${diff}`
  })
  const CheckedFlow = Flow.make("agent/test/CheckedFlow", {
    payload: { diff: Schema.String },
    success: Review,
    error: AgentAction.AgentFailure,
    body: ({ diff }) => Checked.call({ diff })
  })

  it("fails a payload that does not satisfy its own declared check, without calling the model", async () => {
    const requests: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        CheckedFlow.execute({ diff: "short" }, { executionId: "payload-check" }).pipe(
          Effect.provide(
            Layer.mergeAll(Checked.layer, Interpreter.layer(CheckedFlow)).pipe(
              Layer.provideMerge(AgentAction.layerHost(host)),
              Layer.provideMerge(seats(scripted([answering(`{"approved":true,"issues":[]}`)], requests))),
              Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
              Layer.provideMerge(Safety.layer),
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(FlowEngine.layerMemory),
              Layer.provideMerge(NodeCrypto.layer)
            )
          )
        )
      )
    )

    expect(exit._tag).toBe("Failure")
    expect(requests).toEqual([])
  })

  it("reports an unresolved seat as a typed failure, without calling the model", async () => {
    const requests: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        ReviewFlow.execute({ diff: "-  old" }, { executionId: "seat-unresolved" }).pipe(
          Effect.provide(
            Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)).pipe(
              Layer.provideMerge(AgentAction.layerHost(host)),
              Layer.provideMerge(
                SeatResolver.layer({
                  resolve: (id) => Effect.fail(new Seat.SeatUnresolved({ seat: id, message: "No API key" }))
                })
              ),
              Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
              Layer.provideMerge(Safety.layer),
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(FlowEngine.layerMemory),
              Layer.provideMerge(NodeCrypto.layer)
            )
          )
        )
      )
    )

    expect(exit._tag).toBe("Failure")
    const rendered = JSON.stringify(exit)
    expect(rendered).toContain("SeatUnresolved")
    expect(rendered).toContain("No API key")
    expect(requests).toEqual([])
  })

  it("keeps a text approximation of a request-plugin cause JSON cannot render", async () => {
    const requests: Array<string> = []
    // A request-audit plugin can report a database offset wider than JSON can
    // represent. Its failure must survive the action encoder so the operator
    // still learns which host extension stopped the model request.
    class RequestAuditOverflow extends Error {
      readonly offset = 2n ** 63n
    }
    const cause = new RequestAuditOverflow("the request audit offset exceeded its column")
    const failingHost: AgentAction.Host = {
      ...host,
      plugins: [makePlugin<FlowsHooks>({
        name: "request-audit",
        hooks: {
          cellModelRequest: () => Effect.fail(cause)
        }
      })]
    }
    const exit = await Effect.runPromise(
      Effect.exit(
        ReviewFlow.execute({ diff: "-  old" }, { executionId: "request-plugin-bigint" }).pipe(
          Effect.provide(stack(
            Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)),
            failingHost,
            scripted([answering(`{"approved":true,"issues":[]}`)], requests)
          ))
        )
      )
    )

    expect(exit._tag).toBe("Failure")
    const failure = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
    expect(failure).toBeInstanceOf(HarnessError)
    const harnessFailure = failure as HarnessError
    expect(harnessFailure.code).toBe("engine_failed")
    expect(harnessFailure.message).toBe("A cell model-request plugin failed")
    expect(typeof harnessFailure.cause).toBe("string")
    expect(harnessFailure.cause).toContain("hook \"cellModelRequest\" failed in plugin \"request-audit\"")
    expect(requests).toEqual([])
  })

  it("keeps a native Error nested in a request-plugin cause legible", async () => {
    const requests: Array<string> = []
    // `Error.message` is an own property but a NON-ENUMERABLE one, so the bare
    // JSON round trip this encoder used to run dropped it: a plugin failure
    // wrapping a real storage refusal reached the flow as `{}`, which records
    // that a host extension failed and nothing about why. The session
    // settlement already preserved the message, so the same refusal read one
    // way in the run row and another in the step's error.
    class RequestAuditFailed extends Error {
      readonly nested = new Error("storage unavailable")
    }
    const cause = new RequestAuditFailed("the request audit could not be written")
    const failingHost: AgentAction.Host = {
      ...host,
      plugins: [makePlugin<FlowsHooks>({
        name: "request-audit",
        hooks: {
          cellModelRequest: () => Effect.fail(cause)
        }
      })]
    }
    const exit = await Effect.runPromise(
      Effect.exit(
        ReviewFlow.execute({ diff: "-  old" }, { executionId: "request-plugin-nested-error" }).pipe(
          Effect.provide(stack(
            Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)),
            failingHost,
            scripted([answering(`{"approved":true,"issues":[]}`)], requests)
          ))
        )
      )
    )

    expect(exit._tag).toBe("Failure")
    const failure = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
    expect(failure).toBeInstanceOf(HarnessError)
    // The harness wraps the rendered cause in a plain `Error` naming the hook,
    // and a plain `Error` has no enumerable fields, so the rendering the action
    // boundary produced is read from both positions rather than from one.
    const encoded = (failure as HarnessError).cause as { readonly cause?: unknown } | undefined
    const rendered = JSON.stringify({ cause: encoded, wrapped: encoded?.cause })
    expect(rendered).toContain(`"nested":{"message":"storage unavailable"}`)
    expect(rendered).toContain("the request audit could not be written")
    expect(requests).toEqual([])
  })

  it("does not spend a correction on a provider that refuses", async () => {
    let attempts = 0
    const failing = Model.make({
      stream: () =>
        Stream.suspend(() => {
          attempts++
          return Stream.fail(new ModelError({ code: "authentication", message: "invalid credential" }))
        })
    })
    const exit = await Effect.runPromise(
      Effect.exit(
        ReviewFlow.execute({ diff: "-  old" }, { executionId: "model-refused" }).pipe(
          Effect.provide(stack(Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)), host, failing))
        )
      )
    )

    expect(exit._tag).toBe("Failure")
    // A provider refusal is not a decode miss, so the correction budget is
    // untouched: the run is asked once and the step fails.
    expect(attempts).toBe(1)
  })
})

/**
 * A foreign runtime may execute an action without a native dispatch identity.
 * Keep the real engine for every boundary, but reproduce that missing context
 * only inside the named action's implementation.
 */
const legacyRuntime = (name: string) =>
  Layer.effect(
    FlowRuntime.FlowRuntime,
    Effect.map(FlowRuntime.FlowRuntime, (runtime) => {
      const legacy: FlowRuntime.FlowRuntime["Service"] = {
        ...runtime,
        register: (flow, handler) =>
          runtime.register(
            flow,
            (payload, executionId) =>
              handler(payload, executionId).pipe(Effect.provideService(FlowRuntime.FlowRuntime, legacy))
          ),
        actionExecute: (action, attempt) =>
          runtime.actionExecute(
            action.name !== name ? action : {
              ...action,
              execute: action.execute.pipe(Effect.provideService(Action.CurrentInvocationKey, undefined)),
              executeEncoded: action.executeEncoded.pipe(
                Effect.provideService(Action.CurrentInvocationKey, undefined)
              )
            },
            attempt
          )
      }
      return legacy
    })
  )

describe("AgentAction event sink", () => {
  const decodes = answering(`{"approved":true,"issues":[]}`)

  it.each(["absent", "observer", "source"] as const)(
    "handles a legacy runtime without dispatch identity with a %s sink",
    async (kind) => {
      const requests: Array<string> = []
      const observed: Array<{ readonly event: string; readonly step: unknown }> = []
      const layers = stack(
        Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)).pipe(
          Layer.provideMerge(legacyRuntime(Reviewer.name))
        ),
        host,
        scripted([decodes], requests)
      )
      const sink = kind === "absent" ? Layer.empty : EventSink.layer({
        atSource: kind === "source",
        emit: (event, step) => Effect.sync(() => observed.push({ event: event._tag, step }))
      })
      const result = await Effect.runPromise(
        ReviewFlow.execute({ diff: "diff" }, {
          executionId: `legacy-sink-${kind}`
        }).pipe(Effect.provide(Layer.merge(layers, sink)), Effect.exit)
      )
      if (kind === "source") {
        expect(result._tag).toBe("Failure")
        const failure = result._tag === "Failure" ? Cause.squash(result.cause) : undefined
        expect(failure).toMatchObject({
          code: "engine_failed",
          message: "Agent monitoring requires a durable dispatch identity"
        })
        expect(requests).toEqual([])
        expect(observed).toEqual([])
      } else {
        expect(result).toMatchObject({ _tag: "Success", value: { approved: true, issues: [] } })
        expect(requests).toHaveLength(1)
        if (kind === "observer") {
          expect(observed.some((item) => item.event === "resolved")).toBe(true)
          expect(observed.every((item) => item.step === undefined)).toBe(true)
        } else {
          expect(observed).toEqual([])
        }
      }
    }
  )

  it("hands every event to the host sink as it happens, before the step resolves", async () => {
    const requests: Array<string> = []
    const seen: Array<string> = []
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const reached = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        let settled = false
        // The sink holds the third event inside the run. Whatever it has seen
        // when the gate is still shut is what it saw while the model was still
        // working, which is the whole claim: the events are not a replay of a
        // buffer handed over at the end.
        const sink = EventSink.layer({
          emit: (event) =>
            Effect.suspend(() => {
              seen.push(event._tag)
              return seen.length === 3
                ? Effect.andThen(Deferred.succeed(reached, void 0), Deferred.await(gate))
                : Effect.void
            })
        })
        const fiber = yield* ReviewFlow.execute({ diff: "-  old\n+  new" }, { executionId: "sink-order" }).pipe(
          Effect.tap(() => Effect.sync(() => (settled = true))),
          Effect.provide(
            Layer.merge(
              stack(
                Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)),
                host,
                scripted([decodes], requests)
              ),
              sink
            )
          ),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(reached)
        const during = [...seen]
        const settledDuring = settled
        yield* Deferred.succeed(gate, void 0)
        const value = yield* Fiber.join(fiber)
        return { during, settledDuring, value }
      })
    )

    expect(outcome.settledDuring).toBe(false)
    // The third is the request the model is about to be asked, journaled
    // before the call: the model had not answered when the sink saw it.
    expect(outcome.during).toEqual(["discipline-armed", "turn-opened", "model-requested"])
    expect(outcome.value).toEqual({ approved: true, issues: [] })
    // The terminal answer is unchanged by the sink watching it.
    expect(seen).toContain("transition-applied")
    expect(seen.length).toBeGreaterThan(outcome.during.length)
  })

  it("sees the correction attempt's events as well as the first attempt's", async () => {
    const requests: Array<string> = []
    const turns: Array<number> = []
    let frames = 0
    const result = await Effect.runPromise(
      ReviewFlow.execute({ diff: "-  old\n+  new" }, { executionId: "sink-corrections" }).pipe(
        Effect.provide(
          Layer.merge(
            stack(
              Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)),
              host,
              scripted([answering("Looks fine to me."), decodes], requests)
            ),
            EventSink.layer({
              emit: (event) =>
                Effect.sync(() => {
                  frames++
                  if (event._tag === "turn-opened") turns.push(frames)
                })
            })
          )
        )
      )
    )

    expect(result).toEqual({ approved: true, issues: [] })
    // Two provider calls, and the sink saw a turn open for each of them: a
    // re-prompt is a new run and its events reach the host like any other.
    expect(requests).toHaveLength(2)
    expect(turns).toHaveLength(2)
  })

  it("drops every event under the explicit noop, leaving the step's answer unchanged", async () => {
    const requests: Array<string> = []
    // `layerNoop()` writes down what a composition with no sink already does,
    // so the step it wraps must answer exactly as the sink-less runs above do.
    const result = await Effect.runPromise(
      ReviewFlow.execute({ diff: "-  old\n+  new" }, { executionId: "sink-noop" }).pipe(
        Effect.provide(
          Layer.merge(
            stack(
              Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)),
              host,
              scripted([decodes], requests)
            ),
            EventSink.layerNoop()
          )
        )
      )
    )

    expect(result).toEqual({ approved: true, issues: [] })
    expect(requests).toHaveLength(1)
  })

  it("lets an override replace the noop's method", async () => {
    const requests: Array<string> = []
    const seen: Array<string> = []
    const result = await Effect.runPromise(
      ReviewFlow.execute({ diff: "-  old\n+  new" }, { executionId: "sink-noop-override" }).pipe(
        Effect.provide(
          Layer.merge(
            stack(
              Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)),
              host,
              scripted([decodes], requests)
            ),
            EventSink.layerNoop({ emit: (event) => Effect.sync(() => seen.push(event._tag)) })
          )
        )
      )
    )

    expect(result).toEqual({ approved: true, issues: [] })
    // The override is the only method the service has, so it saw the same run
    // the layer form sees.
    expect(seen.slice(0, 4)).toEqual(["discipline-armed", "turn-opened", "model-requested", "model-delta"])
    expect(seen).toContain("transition-applied")
  })

  it.each([true, false])("arms each step's own run with the host's judge (judged: %s)", async (judged) => {
    const requests: Array<string> = []
    const armed: Array<AgentEvent.DisciplineArmed> = []
    const result = await Effect.runPromise(
      ReviewFlow.execute({ diff: "-  old\n+  new" }, { executionId: `judged-${judged}` }).pipe(
        Effect.provide(
          Layer.merge(
            stack(
              Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)),
              judged ? { ...host, judged, supervisor: { stance: "paranoid" } } : host,
              scripted([decodes], requests)
            ),
            EventSink.layer({
              emit: (event) => Effect.sync(() => event._tag === "discipline-armed" && void armed.push(event))
            })
          )
        )
      )
    )

    expect(result).toEqual({ approved: true, issues: [] })
    expect(armed).toHaveLength(1)
    expect(armed[0]?.supervisorSteer).toBeUndefined()
    expect(armed[0]?.judged).toBe(judged ? true : undefined)
    // The host's supervisor options reach each step: a judged step is taught its stance.
    expect(armed[0]?.stance).toBe(judged ? "paranoid" : undefined)
  })
})

describe("AgentAction payload-chosen seats", () => {
  /** A step whose caller, not its declaration, decides which model answers. */
  const Dispatched = AgentAction.make("agent/test/Dispatched", {
    payload: { diff: Schema.String, model: Schema.String },
    output: Review,
    seat: ({ model }) => model,
    prompt: ({ diff }) => `Review this diff:\n${diff}`
  })
  const DispatchedFlow = Flow.make("agent/test/DispatchedFlow", {
    payload: { diff: Schema.String, model: Schema.String },
    success: Review,
    error: AgentAction.AgentFailure,
    body: (input) => Dispatched.call(input)
  })

  /** Records every seat id the step asked the host's resolver for. */
  const recordingSeats = (model: Model.Model, asked: Array<string>): Layer.Layer<SeatResolver.SeatResolver> =>
    SeatResolver.layer({
      resolve: (id) => {
        asked.push(id)
        return Effect.succeed(
          Seat.make({ id, modelId: Seat.modelIdOf(id), model, route, contextWindowTokens: 200_000 })
        )
      }
    })

  it("refuses an empty seat before resolving or contacting a provider", async () => {
    const asked: string[] = []
    const requests: string[] = []
    const exit = await Effect.runPromise(Effect.exit(
      DispatchedFlow.execute({ diff: "change", model: "   " }, { executionId: "invalid-seat" }).pipe(
        Effect.provide(
          Layer.mergeAll(Dispatched.layer, Interpreter.layer(DispatchedFlow)).pipe(
            Layer.provideMerge(AgentAction.layerHost(host)),
            Layer.provideMerge(recordingSeats(scripted([], requests), asked)),
            Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
            Layer.provideMerge(Safety.layer),
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(FlowEngine.layerMemory),
            Layer.provideMerge(NodeCrypto.layer)
          )
        )
      )
    ))
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("must name a model")
    expect(asked).toEqual([])
    expect(requests).toEqual([])
  })

  it("resolves the seat the payload names, once, and asks for no other", async () => {
    const asked: Array<string> = []
    const requests: Array<string> = []
    const result = await Effect.runPromise(
      DispatchedFlow.execute({ diff: "-  old\n+  new", model: "anthropic:caller-chosen" }, {
        executionId: "payload-seat"
      }).pipe(
        Effect.provide(
          Layer.mergeAll(Dispatched.layer, Interpreter.layer(DispatchedFlow)).pipe(
            Layer.provideMerge(AgentAction.layerHost(host)),
            Layer.provideMerge(recordingSeats(scripted([answering(`{"approved":true,"issues":[]}`)], requests), asked)),
            Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
            Layer.provideMerge(Safety.layer),
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(FlowEngine.layerMemory),
            Layer.provideMerge(NodeCrypto.layer)
          )
        )
      )
    )

    expect(result.approved).toBe(true)
    // One resolution for the whole execution, and it is the caller's model.
    expect(asked).toEqual(["anthropic:caller-chosen"])
    expect(requests).toHaveLength(1)
  })

  it("lets a second call of the same step run on a different model", async () => {
    const asked: Array<string> = []
    const requests: Array<string> = []
    const stack = Layer.mergeAll(Dispatched.layer, Interpreter.layer(DispatchedFlow)).pipe(
      Layer.provideMerge(AgentAction.layerHost(host)),
      Layer.provideMerge(
        recordingSeats(scripted([answering(`{"approved":true,"issues":[]}`)], requests), asked)
      ),
      Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
      Layer.provideMerge(Safety.layer),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer)
    )
    for (const [index, model] of ["anthropic:first", "anthropic:second"].entries()) {
      await Effect.runPromise(
        DispatchedFlow.execute({ diff: "-  old\n+  new", model }, { executionId: `payload-seat-${index}` }).pipe(
          Effect.provide(stack)
        )
      )
    }
    expect(asked).toEqual(["anthropic:first", "anthropic:second"])
  })
})

describe("AgentAction seat auto", () => {
  const decodes = answering(`{"approved":true,"issues":[]}`)
  // Sonnet runs alone here; Opus fails over to Sol.
  const candidates = ["sonnet", "opus", "sol", "fable"]
  const catalog = SeatRouter.layer({ candidates: Effect.succeed(candidates), variants: SeatRouter.defaultVariants })

  /** Edge answers the graph routes to Sonnet, to Opus, and to the review panel. */
  const edges = (phase: string, size: string, clarity: string): Readonly<Record<string, Evaluator.ScriptedAnswer>> => ({
    phase: { choice: phase },
    size: { choice: size },
    clarity: { choice: clarity },
    binary: { probability: 0.1 }
  })
  const toSonnet = edges("implement", "simple", "clear")
  const toOpus = edges("implement", "simple", "unknowns")
  const toPanel = edges("review", "important", "clear")

  /**
   * Jev: each `seat/route` request takes the next scripted pick and is
   * recorded; every other question goes to the offline completion judge.
   */
  const judge = (
    picks: ReadonlyArray<Readonly<Record<string, Evaluator.ScriptedAnswer>>>,
    routed: Array<Evaluator.Request>
  ) =>
    Layer.effect(Evaluator.Evaluator)(Effect.gen(function*() {
      const completion = yield* Effect.provide(
        Effect.gen(function*() {
          return yield* Evaluator.Evaluator
        }),
        scriptedCompletionJudge
      )
      const router = yield* Effect.provide(
        Effect.gen(function*() {
          return yield* Evaluator.Evaluator
        }),
        Evaluator.layerScripted((request) => {
          routed.push(request)
          const pick = { ...picks[Math.min(routed.length, picks.length) - 1]!, system: { choice: "answer" } }
          return Object.fromEntries(Object.entries(pick).filter(([id]) => id in request.questions))
        })
      )
      return Evaluator.Evaluator.of({
        evaluate: (request) => "size" in request.questions ? router.evaluate(request) : completion.evaluate(request)
      })
    }))

  /** Records every seat id the step asked the host's resolver for; a function gives each seat its own model. */
  const resolving = (
    model: Model.Model | ((id: string) => Model.Model),
    asked: Array<string>
  ): Layer.Layer<SeatResolver.SeatResolver> =>
    SeatResolver.layer({
      resolve: (id) => {
        asked.push(id)
        return Effect.succeed(
          Seat.make({
            id,
            modelId: Seat.modelIdOf(id),
            model: typeof model === "function" ? model(id) : model,
            route,
            contextWindowTokens: 200_000
          })
        )
      }
    })

  const routedStack = <ROut, RIn>(
    step: Layer.Layer<ROut, never, RIn>,
    model: Model.Model | ((id: string) => Model.Model),
    asked: Array<string>,
    evaluator: Layer.Layer<Evaluator.Evaluator>,
    routing: Layer.Layer<SeatRouter.Catalog> | Layer.Layer<never> = catalog,
    safety: Layer.Layer<QuotaPolicy.QuotaClassifier | Budget.Budget> = Safety.layer,
    composition: AgentAction.Host = host,
    engine: Layer.Layer<FlowRuntime.FlowRuntime> = FlowEngine.layerMemory
  ) =>
    step.pipe(
      Layer.provideMerge(AgentAction.layerHost(composition)),
      Layer.provideMerge(resolving(model, asked)),
      Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, evaluator, routing)),
      Layer.provideMerge(safety),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(engine),
      Layer.provideMerge(NodeCrypto.layer)
    )

  const Routed = AgentAction.make("agent/test/Routed", {
    payload: { diff: Schema.String },
    output: Review,
    seat: Seat.auto,
    system: ["You review diffs."],
    prompt: ({ diff }) => `Review this diff:\n${diff}`
  })
  const RoutedFlow = Flow.make("agent/test/RoutedFlow", {
    payload: { diff: Schema.String },
    success: Review,
    error: AgentAction.AgentFailure,
    body: ({ diff }) => Routed.call({ diff })
  })
  const routedStep = Layer.mergeAll(Routed.layer, Interpreter.layer(RoutedFlow))

  it.each(["memory", "durable", "restart"])("keeps its recorded route after a quota park (%s)", async (mode) => {
    const routed: Array<Evaluator.Request> = []
    const calls: Array<string> = []
    const requests: Array<string> = []
    const answered = scripted([decodes], requests)
    const models = (seat: string): Model.Model =>
      Model.make({
        stream: (request) =>
          Stream.suspend(() => {
            calls.push(seat)
            return calls.length === 1
              ? Stream.fail(
                new ModelError({
                  code: "rate_limited",
                  message: "wait",
                  httpStatus: 429,
                  retryAfterMillis: mode === "memory" ? 50 : 3_000
                })
              )
              : answered.stream(request)
          })
      })
    const stores = Layer.mergeAll(
      Layer.sync(DurableEngineState.DurableEngineState)(DurableEngineState.makeMemory),
      StepBoundary.layerTest(),
      Layer.succeed(Jj.Jj)(Jj.make({
        snapshot: () => Effect.succeed({ commitId: "route-snapshot" as never, changeId: "route-snapshot" as never }),
        restore: () => Effect.void,
        diff: () => Effect.succeed(""),
        workspaceAdd: () => Effect.void,
        workspaceForget: () => Effect.void,
        status: () => Effect.succeed("")
      })),
      TestStores.layer()
    )
    const executionId = `auto-quota-${mode}`
    const incarnation = (hostId: string) =>
      Effect.gen(function*() {
        const engine = mode === "memory" ? undefined : yield* EngineStore.make({
          owner: { hostId },
          journalSource: hostId,
          isAlive: () => Effect.succeed(false)
        })
        return routedStack(
          routedStep,
          models,
          [],
          judge([toSonnet, toOpus], routed),
          catalog,
          Layer.merge(Budget.layerUnbounded(), QuotaPolicy.layerDefault()),
          { ...host, modelRetryPolicy: Schedule.recurs(0) },
          engine === undefined ? FlowEngine.layerMemory : Layer.succeed(FlowRuntime.FlowRuntime)(engine)
        )
      })
    const settle = <A, E>(running: Fiber.Fiber<A, E>) =>
      Effect.gen(function*() {
        if (mode === "memory") return yield* Fiber.join(running)
        for (let step = 0; step < 60 && running.pollUnsafe() === undefined; step++) {
          yield* TestClock.adjust("1 second")
        }
        return yield* Fiber.join(running)
      })
    const observed = await Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        const first = yield* Effect.scoped(Effect.gen(function*() {
          const wiring = yield* incarnation("auto-quota-before")
          const context = yield* Layer.build(wiring)
          const running = yield* RoutedFlow.execute({ diff: "diff" }, { executionId }).pipe(
            Effect.provideContext(context),
            Effect.forkChild({ startImmediately: true })
          )
          let parked = false
          for (let step = 0; step < 400 && !parked; step++) {
            if (mode === "memory") {
              const result = yield* RoutedFlow.poll(executionId).pipe(Effect.provideContext(context))
              parked = Option.isSome(result) && result.value._tag === "Suspended"
            } else {
              const waiting = yield* state.waitingRuns({ reason: "quota" })
              parked = waiting.some((row) => row.runId === executionId && row.reason === "quota")
            }
            yield* Effect.yieldNow
          }
          expect(parked).toBe(true)
          expect(calls).toEqual(["sonnet"])
          expect(routed).toHaveLength(1)
          if (mode === "restart") {
            yield* Fiber.interrupt(running)
            return undefined
          }
          const value = yield* settle(running)
          const replayed = yield* RoutedFlow.execute({ diff: "diff" }, { executionId }).pipe(
            Effect.provideContext(context)
          )
          return { value, replayed }
        }))
        if (first !== undefined) return first
        return yield* Effect.scoped(Effect.gen(function*() {
          const wiring = yield* incarnation("auto-quota-after")
          const context = yield* Layer.build(wiring)
          const running = yield* RoutedFlow.execute({ diff: "diff" }, { executionId }).pipe(
            Effect.provideContext(context),
            Effect.forkChild({ startImmediately: true })
          )
          const value = yield* settle(running)
          const replayed = yield* RoutedFlow.execute({ diff: "diff" }, { executionId }).pipe(
            Effect.provideContext(context)
          )
          return { value, replayed }
        }))
      }).pipe(
        Effect.provide(stores),
        Effect.provide(mode === "memory" ? NodeCrypto.layer : Layer.merge(NodeCrypto.layer, TestClock.layer()))
      )
    ))
    expect(observed.value).toEqual({ approved: true, issues: [] })
    expect(observed.replayed).toEqual(observed.value)
    expect(routed).toHaveLength(1)
    expect(calls).toEqual(["sonnet", "sonnet"])
  })

  it("routes once per execution and hands the receipt to the sink before the first ask", async () => {
    const routed: Array<Evaluator.Request> = []
    const asked: Array<string> = []
    const requests: Array<string> = []
    const seen: Array<AgentEvent.AgentEvent> = []
    const result = await Effect.runPromise(
      RoutedFlow.execute({ diff: "-  old\n+  new" }, { executionId: "auto-once" }).pipe(
        Effect.provide(Layer.merge(
          routedStack(routedStep, scripted([decodes], requests), asked, judge([toOpus], routed)),
          EventSink.layer({ emit: (event) => Effect.sync(() => void seen.push(event)) })
        ))
      )
    )

    expect(result).toEqual({ approved: true, issues: [] })
    expect(routed).toHaveLength(1)
    expect((routed[0]!.state as SeatRouter.State).task).toBe("Review this diff:\n-  old\n+  new")
    expect((routed[0]!.state as SeatRouter.State).flow).toBe("agent/test/Routed")
    // The receipt names the routed seat's model; the route's backups are the run's fallbacks.
    expect(asked).toEqual(["opus", "opus", "sol"])
    expect(seen.slice(0, 3).map((event) => event._tag)).toEqual(["seat-routed", "decision-settled", "discipline-armed"])
    expect(seen[0]).toMatchObject({
      declared: "auto",
      seat: "opus",
      backups: ["sol"],
      modelId: "opus",
      variant: "answer"
    })
    // The picked variant's teaching sits after the host's and before the step's.
    const answerVariant = SeatRouter.defaultVariants.find((variant) => variant.id === "answer")!.system[0]!
    expect(requests[0]!.indexOf(answerVariant)).toBeGreaterThanOrEqual(0)
    expect(requests[0]!.indexOf(answerVariant)).toBeLessThan(requests[0]!.indexOf("You review diffs."))
  })

  it("reuses the routed seat for a correction and the repair", async () => {
    const Repaired = AgentAction.make("agent/test/Repaired", {
      payload: { diff: Schema.String },
      output: Review,
      seat: Seat.auto,
      corrections: 1,
      prompt: ({ diff }) => `Review this diff:\n${diff}`,
      repair: { prompt: () => "Repair the answer.", system: ["You repair answers."] }
    })
    const RepairedFlow = Flow.make("agent/test/RepairedFlow", {
      payload: { diff: Schema.String },
      success: Review,
      error: AgentAction.AgentFailure,
      body: ({ diff }) => Repaired.call({ diff })
    })
    const routed: Array<Evaluator.Request> = []
    const asked: Array<string> = []
    const requests: Array<string> = []
    const miss = answering("Looks fine to me.")
    const result = await Effect.runPromise(
      RepairedFlow.execute({ diff: "diff" }, { executionId: "auto-repair" }).pipe(
        Effect.provide(routedStack(
          Layer.mergeAll(Repaired.layer, Interpreter.layer(RepairedFlow)),
          scripted([miss, miss, decodes], requests),
          asked,
          judge([toSonnet], routed)
        ))
      )
    )

    expect(result).toEqual({ approved: true, issues: [] })
    expect(requests).toHaveLength(3)
    expect(routed).toHaveLength(1)
    expect(asked).toEqual(["sonnet"])
    // The repair keeps the routed variant's teaching beside its own.
    expect(requests[2]).toContain("You repair answers.")
    expect(requests[2]).toContain(SeatRouter.defaultVariants.find((variant) => variant.id === "answer")!.system[0]!)
  })

  it("runs an explicit repair seat instead of the routed one", async () => {
    const Overridden = AgentAction.make("agent/test/Overridden", {
      payload: { diff: Schema.String },
      output: Review,
      seat: Seat.auto,
      corrections: 0,
      prompt: ({ diff }) => `Review this diff:\n${diff}`,
      repair: { prompt: () => "Repair the answer.", seat: "anthropic:repairer" }
    })
    const OverriddenFlow = Flow.make("agent/test/OverriddenFlow", {
      payload: { diff: Schema.String },
      success: Review,
      error: AgentAction.AgentFailure,
      body: ({ diff }) => Overridden.call({ diff })
    })
    const routed: Array<Evaluator.Request> = []
    const asked: Array<string> = []
    const requests: Array<string> = []
    const result = await Effect.runPromise(
      OverriddenFlow.execute({ diff: "diff" }, { executionId: "auto-repair-seat" }).pipe(
        Effect.provide(routedStack(
          Layer.mergeAll(Overridden.layer, Interpreter.layer(OverriddenFlow)),
          scripted([answering("Looks fine to me."), decodes], requests),
          asked,
          judge([toOpus], routed)
        ))
      )
    )

    expect(result).toEqual({ approved: true, issues: [] })
    expect(routed).toHaveLength(1)
    expect(asked).toEqual(["opus", "sol", "anthropic:repairer"])
  })

  it("routes two executions of one step independently", async () => {
    const Chosen = AgentAction.make("agent/test/Chosen", {
      payload: { diff: Schema.String, model: Schema.String },
      output: Review,
      seat: ({ model }) => model,
      prompt: ({ diff }) => `Review this diff:\n${diff}`
    })
    const ChosenFlow = Flow.make("agent/test/ChosenFlow", {
      payload: { diff: Schema.String, model: Schema.String },
      success: Review,
      error: AgentAction.AgentFailure,
      body: (input) => Chosen.call(input)
    })
    const routed: Array<Evaluator.Request> = []
    const asked: Array<string> = []
    const layers = routedStack(
      Layer.mergeAll(Chosen.layer, Interpreter.layer(ChosenFlow)),
      scripted([decodes], []),
      asked,
      judge([toSonnet, toOpus], routed)
    )
    for (const [index, diff] of ["first", "second"].entries()) {
      await Effect.runPromise(
        ChosenFlow.execute({ diff, model: Seat.auto }, { executionId: `auto-child-${index}` }).pipe(
          Effect.provide(layers)
        )
      )
    }

    expect(routed.map((request) => (request.state as SeatRouter.State).task)).toEqual([
      "Review this diff:\nfirst",
      "Review this diff:\nsecond"
    ])
    expect(asked).toEqual(["sonnet", "opus", "sol"])
  })

  describe("a panel route", () => {
    const Paneled = AgentAction.make("agent/test/Paneled", {
      payload: { diff: Schema.String },
      output: Review,
      seat: Seat.auto,
      phase: "review",
      prompt: ({ diff }) => `Review this diff:\n${diff}`
    })
    const PaneledFlow = Flow.make("agent/test/PaneledFlow", {
      payload: { diff: Schema.String },
      success: Review,
      error: AgentAction.AgentFailure,
      body: ({ diff }) => Paneled.call({ diff })
    })
    const review = (seat: string, approved = true) => answering(`{"approved":${approved},"issues":["${seat}"]}`)
    const refusal = new ModelError({ code: "rate_limited", message: "slow down", httpStatus: 429, retryAfterMillis: 5 })
    const broken = new ModelError({ code: "invalid_request", message: "bad request", httpStatus: 400 })

    /** How one seat answers: its member answer, its merged answer, and whether it refuses. */
    interface Script {
      readonly answer: string
      readonly merged?: string
      /** `once`: a quota refusal on the first call; `always`: a request error on every call. */
      readonly refuse?: "once" | "always"
    }

    /**
     * One model per seat, answering by its {@link Script}. Every seat's first
     * call waits until all `gate` seats have called, so members that ran one
     * after another would never get past the first.
     */
    const seatModels = (
      scripts: Readonly<Record<string, Script>>,
      requests: Record<string, Array<string>>,
      gate: number
    ) => {
      const arrived = new Set<string>()
      const open = Deferred.makeUnsafe<void>()
      const models = new Map<string, Model.Model>()
      return (id: string): Model.Model => {
        const held = models.get(id)
        if (held !== undefined) return held
        const seen: Array<string> = (requests[id] = [])
        const script = scripts[id]!
        let calls = 0
        const model = Model.make({
          stream: (request) =>
            Stream.unwrap(Effect.gen(function*() {
              if (!arrived.has(id)) {
                arrived.add(id)
                if (arrived.size >= gate) yield* Deferred.succeed(open, undefined)
                yield* Deferred.await(open)
              }
              calls++
              if (script.refuse === "always" || (script.refuse === "once" && calls === 1)) {
                return Stream.fail(script.refuse === "always" ? broken : refusal)
              }
              const text = [
                ...request.system.map((part) => part.text),
                ...request.messages.flatMap((message) =>
                  message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
                )
              ].join("\n")
              const cell = text.includes("Independent answers") ? script.merged! : script.answer
              return scripted([cell], seen).stream(request)
            }))
        })
        models.set(id, model)
        return model
      }
    }

    /** A review whose answers decode but refuse to encode, so no member answer can travel to the merger. */
    const OneWay = Review.pipe(Schema.decodeTo(Schema.toType(Review), {
      decode: SchemaGetter.passthrough(),
      encode: SchemaGetter.forbidden(() => "a review answer is never re-encoded")
    }))
    const OneWayPaneled = AgentAction.make("agent/test/OneWayPaneled", {
      payload: { diff: Schema.String },
      output: OneWay,
      seat: Seat.auto,
      phase: "review",
      prompt: ({ diff }) => `Review this diff:\n${diff}`
    })
    const OneWayFlow = Flow.make("agent/test/OneWayPaneledFlow", {
      payload: { diff: Schema.String },
      success: OneWay,
      error: AgentAction.AgentFailure,
      body: ({ diff }) => OneWayPaneled.call({ diff })
    })

    const run = async (
      scripts: Readonly<Record<string, Script>>,
      executionId: string,
      oneWay = false
    ) => {
      const routed: Array<Evaluator.Request> = []
      const requests: Record<string, Array<string>> = {}
      const seen: Array<AgentEvent.AgentEvent> = []
      // Opus and Sol have no backup here; Fable fails over to Sol.
      const catalog = SeatRouter.layer({
        candidates: Effect.succeed(["opus", "fable", "sol"]),
        variants: SeatRouter.defaultVariants
      })
      const runtime = ManagedRuntime.make(Layer.merge(
        routedStack(
          Layer.mergeAll(
            Paneled.layer,
            Interpreter.layer(PaneledFlow),
            OneWayPaneled.layer,
            Interpreter.layer(OneWayFlow)
          ),
          seatModels(scripts, requests, 3),
          [],
          judge([toPanel], routed),
          catalog,
          // Quota refusals park, as on a live host.
          Layer.merge(Budget.layerUnbounded(), QuotaPolicy.layerDefault())
        ),
        EventSink.layer({ emit: (event) => Effect.sync(() => void seen.push(event)) })
      ))
      const flow = oneWay ? OneWayFlow : PaneledFlow
      const exit = await runtime.runPromiseExit(flow.execute({ diff: "diff" }, { executionId }))
      const answered = Object.values(requests).flat().length
      const replayed = await runtime.runPromiseExit(flow.execute({ diff: "diff" }, { executionId }))
      await runtime.dispose()
      return { exit, replayed, replayCalls: Object.values(requests).flat().length - answered, routed, requests, seen }
    }

    /** The prompt the merger was given. */
    const mergeOf = (requests: Record<string, Array<string>>) =>
      requests["fable"]!.find((prompt) => prompt.includes("Independent answers"))!

    it("runs its members in parallel on their own seats, then the merger on their answers", async () => {
      // Opus and Sol are refused at the same time, and both park.
      const { exit, replayCalls, replayed, requests, routed, seen } = await run(
        {
          opus: { answer: review("opus"), refuse: "once" },
          fable: { answer: review("fable"), merged: review("merged", false) },
          sol: { answer: review("sol", false), refuse: "once" }
        },
        "auto-panel"
      )

      expect(exit._tag === "Success" && exit.value).toEqual({ approved: false, issues: ["merged"] })
      // A finished execution replays its answer and calls no model.
      expect(replayed).toEqual(exit)
      expect(replayCalls).toBe(0)
      // The pinned phase is not asked.
      expect(Object.keys(routed[0]!.questions)).not.toContain("phase")
      expect(seen[0]).toMatchObject({
        seat: "fable",
        backups: ["sol"],
        panel: {
          seats: [
            { seat: "opus", backups: [] },
            { seat: "fable", backups: [] },
            { seat: "sol", backups: [] }
          ],
          merger: "fable"
        }
      })
      // The merger reads the task and every member's decoded answer.
      const merge = mergeOf(requests)
      expect(merge).toContain("Review this diff:\ndiff")
      for (const seat of ["opus", "fable", "sol"]) {
        expect(merge).toContain(`${seat}: {"approved":${seat !== "sol"},"issues":["${seat}"]}`)
      }
      expect(merge).not.toContain("failed and gave no answer")
    })

    it("merges the members that answered when one fails, and names the one that failed", async () => {
      const { exit, requests } = await run(
        {
          opus: { answer: review("opus") },
          fable: { answer: review("fable"), merged: review("merged", false) },
          sol: { answer: review("sol"), refuse: "always" }
        },
        "auto-panel-survivors"
      )

      expect(exit._tag === "Success" && exit.value).toEqual({ approved: false, issues: ["merged"] })
      const merge = mergeOf(requests)
      expect(merge).toContain(`opus: {"approved":true,"issues":["opus"]}`)
      expect(merge).toContain(`fable: {"approved":true,"issues":["fable"]}`)
      expect(merge).not.toContain(`sol: {`)
      expect(merge).toContain("These seats failed and gave no answer: sol.")
    })

    it("fails when no member answers, without asking the merger", async () => {
      const { exit, requests } = await run(
        {
          opus: { answer: review("opus"), refuse: "always" },
          fable: { answer: review("fable"), refuse: "always" },
          sol: { answer: review("sol"), refuse: "always" }
        },
        "auto-panel-none"
      )

      expect(exit._tag).toBe("Failure")
      expect(Object.values(requests).flat().some((prompt) => prompt.includes("Independent answers"))).toBe(false)
    })

    it("fails with a typed error naming the member when no member answer encodes", async () => {
      const { exit, requests } = await run(
        {
          opus: { answer: review("opus") },
          fable: { answer: review("fable"), merged: review("merged") },
          sol: { answer: review("sol") }
        },
        "auto-panel-one-way",
        true
      )

      // Every member answered and decoded; none could be handed on.
      for (const seat of ["opus", "fable", "sol"]) expect(requests[seat]).toHaveLength(1)
      expect(Object.values(requests).flat().some((prompt) => prompt.includes("Independent answers"))).toBe(false)
      const failure = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
      expect(failure).toMatchObject({ code: "model_failed", message: "The panel answer of opus did not encode" })
    })
  })

  it("serves a replayed execution its recorded seat without asking Jev", async () => {
    const routed: Array<Evaluator.Request> = []
    const asked: Array<string> = []
    const requests: Array<string> = []
    const runtime = ManagedRuntime.make(
      routedStack(routedStep, scripted([decodes], requests), asked, judge([toOpus], routed))
    )
    const first = await runtime.runPromise(RoutedFlow.execute({ diff: "diff" }, { executionId: "auto-replay" }))
    const second = await runtime.runPromise(RoutedFlow.execute({ diff: "diff" }, { executionId: "auto-replay" }))
    await runtime.dispose()

    expect(second).toEqual(first)
    expect(routed).toHaveLength(1)
    expect(requests).toHaveLength(1)
  })

  it("routes a step dispatched without a durable identity by its tag", async () => {
    const routed: Array<Evaluator.Request> = []
    const seen: Array<{ readonly event: string; readonly step: unknown }> = []
    const result = await Effect.runPromise(
      RoutedFlow.execute({ diff: "diff" }, { executionId: "auto-legacy" }).pipe(
        Effect.provide(Layer.merge(
          routedStack(
            routedStep.pipe(Layer.provideMerge(legacyRuntime(Routed.name))),
            scripted([decodes], []),
            [],
            judge([toOpus], routed)
          ),
          EventSink.layer({ emit: (event, step) => Effect.sync(() => void seen.push({ event: event._tag, step })) })
        ))
      )
    )

    expect(result).toEqual({ approved: true, issues: [] })
    expect(routed).toHaveLength(1)
    expect(seen[0]).toEqual({ event: "seat-routed", step: undefined })
  })

  const unrouted = async (routing: Layer.Layer<SeatRouter.Catalog> | Layer.Layer<never>, executionId: string) => {
    const routed: Array<Evaluator.Request> = []
    const requests: Array<string> = []
    const exit = await Effect.runPromise(
      RoutedFlow.execute({ diff: "diff" }, { executionId }).pipe(
        Effect.provide(
          routedStack(routedStep, scripted([decodes], requests), [], judge([toOpus], routed), routing)
        ),
        Effect.exit
      )
    )
    expect(requests).toEqual([])
    return { exit, routed }
  }

  it("fails SeatUnrouted unconfigured when no catalog is bound, asking nothing", async () => {
    const { exit, routed } = await unrouted(Layer.empty, "auto-no-catalog")

    expect(routed).toEqual([])
    const failure = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
    expect(failure).toBeInstanceOf(Seat.SeatUnrouted)
    expect(failure).toMatchObject({ seat: "auto", reason: "unconfigured" })
  })

  it("fails SeatUnrouted when the catalog no longer offers the recorded variant", async () => {
    let reads = 0
    const shifting = SeatRouter.layer({
      candidates: Effect.succeed(candidates),
      // The router reads the variants it offers Jev; the step reads them again
      // for the one Jev picked, and by then the catalog has dropped it.
      get variants() {
        reads++
        return reads === 1 ? SeatRouter.defaultVariants : [SeatRouter.defaultVariants[0]!]
      }
    })
    const { exit, routed } = await unrouted(shifting, "auto-variant-gone")

    expect(routed).toHaveLength(1)
    const failure = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
    expect(failure).toMatchObject({
      _tag: "@smthrs/agent/Seat/SeatUnrouted",
      reason: "unconfigured",
      message: `The seat catalog no longer offers the variant "answer"`
    })
  })

  it("gates each step's relevance on its own prompt under its own session", async () => {
    const lookup = FlowBinding.source("host/lookup", [
      FlowBinding.make({ flow: StandardFlows.askFlow, name: "lookup", handler: () => Effect.die("unused") })
    ])
    const relevance: Array<{ readonly task: string; readonly ids: ReadonlyArray<string> }> = []
    const evaluator = Evaluator.layerScripted((request) => {
      if (!Object.keys(request.questions).some((id) => id.startsWith("unnecessary_"))) {
        return { complete: { probability: 0.99 }, overclaims: { probability: 0.01 }, invented: { probability: 0.01 } }
      }
      const state = request.state as {
        readonly context: { readonly task: string }
        readonly items: ReadonlyArray<{ readonly id: string }>
      }
      relevance.push({ task: state.context.task, ids: state.items.map((item) => item.id) })
      // The parent's task never needs the lookup; the child's does.
      const p = state.context.task.includes("parent") ? 0.95 : 0.1
      return Object.fromEntries(state.items.map((_, index) => [`unnecessary_${index}`, { probability: p }]))
    })
    const step = (name: string) =>
      AgentAction.make(`agent/test/${name}`, {
        payload: { diff: Schema.String },
        output: Review,
        seat: "anthropic:test-model",
        prompt: ({ diff }) => `As the ${name.toLowerCase()}, review:\n${diff}`
      })
    const Parent = step("Parent")
    const Child = step("Child")
    const Nested = Flow.make("agent/test/Nested", {
      payload: { diff: Schema.String },
      success: Review,
      error: AgentAction.AgentFailure,
      body: ({ diff }) => Parent.call({ diff }).pipe(Node.bindPlanned(() => Child.call({ diff })))
    })
    const requests: Array<string> = []
    const settled: Array<AgentEvent.RelevanceSettled> = []
    const result = await Effect.runPromise(
      Nested.execute({ diff: "diff" }, { executionId: "auto-isolation" }).pipe(
        Effect.provide(Layer.merge(
          Layer.mergeAll(Parent.layer, Child.layer, Interpreter.layer(Nested)).pipe(
            Layer.provideMerge(AgentAction.layerHost({ ...host, judged: true, flows: [lookup] })),
            Layer.provideMerge(seats(scripted([decodes], requests))),
            Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, evaluator)),
            Layer.provideMerge(Safety.layer),
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(FlowEngine.layerMemory),
            Layer.provideMerge(NodeCrypto.layer)
          ),
          EventSink.layer({
            emit: (event) => Effect.sync(() => event._tag === "relevance-settled" && void settled.push(event))
          })
        ))
      )
    )

    expect(result).toEqual({ approved: true, issues: [] })
    expect(relevance).toEqual([
      { task: "The task for this run:\n\nAs the parent, review:\ndiff", ids: ["lookup"] },
      { task: "The task for this run:\n\nAs the child, review:\ndiff", ids: ["lookup"] }
    ])
    expect(settled.map((event) => event.withheld.map((item) => item.id))).toEqual([["lookup"], []])
    expect(settled[0]!.scope).toContain("agent/test/Parent")
    expect(settled[1]!.scope).toContain("agent/test/Child")
    // The child's catalog still offers what the parent's reading withheld.
    expect(requests).toHaveLength(2)
    expect(requests[0]).not.toContain("lookup")
    expect(requests[1]).toContain("lookup")
  })

  it.each([true, false])("gates the step's declared memory rows as opening memory (judged: %s)", async (judged) => {
    const judgedItems: Array<ReadonlyArray<{ readonly kind: string; readonly id: string }>> = []
    const evaluator = Evaluator.layerScripted((request) => {
      if (!Object.keys(request.questions).some((id) => id.startsWith("unnecessary_"))) {
        return { complete: { probability: 0.99 }, overclaims: { probability: 0.01 }, invented: { probability: 0.01 } }
      }
      const state = request.state as {
        readonly items: ReadonlyArray<{ readonly kind: string; readonly id: string; readonly text: string }>
      }
      judgedItems.push(state.items.map(({ id, kind }) => ({ id, kind })))
      // Jev is confident only the release note is unnecessary for a migration review.
      return Object.fromEntries(
        state.items.map((item, index) => [`unnecessary_${index}`, {
          probability: item.text.includes("release") ? 0.97 : 0.05
        }])
      )
    })
    const Remembering = AgentAction.make("agent/test/Remembering", {
      payload: { diff: Schema.String, notes: Schema.Array(Schema.String) },
      output: Review,
      seat: "anthropic:test-model",
      prompt: ({ diff }) => `Review this migration:\n${diff}`,
      memory: ({ notes }) =>
        notes.map((text, index) => ({ origin: "recall" as const, bank: "flow:coding", key: `note-${index}`, text }))
    })
    const Remember = Flow.make("agent/test/Remember", {
      payload: { diff: Schema.String, notes: Schema.Array(Schema.String) },
      success: Review,
      error: AgentAction.AgentFailure,
      body: (input) => Remembering.call(input)
    })
    const requests: Array<string> = []
    const settled: Array<AgentEvent.RelevanceSettled> = []
    const run = (notes: ReadonlyArray<string>, executionId: string) =>
      Effect.runPromise(
        Remember.execute({ diff: "+ add column", notes }, { executionId }).pipe(
          Effect.provide(Layer.merge(
            Layer.mergeAll(Remembering.layer, Interpreter.layer(Remember)).pipe(
              Layer.provideMerge(AgentAction.layerHost(judged ? { ...host, judged } : host)),
              Layer.provideMerge(seats(scripted([decodes], requests))),
              Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, evaluator)),
              Layer.provideMerge(Safety.layer),
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(FlowEngine.layerMemory),
              Layer.provideMerge(NodeCrypto.layer)
            ),
            EventSink.layer({
              emit: (event) => Effect.sync(() => event._tag === "relevance-settled" && void settled.push(event))
            })
          ))
        )
      )

    expect(await run(["Keep migrations additive", "Tag the release on Fridays"], `memory-${judged}`)).toEqual({
      approved: true,
      issues: []
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain("<flows_memory_context>")
    expect(requests[0]).toContain("[flow\\u003acoding/note-0] Keep migrations additive")
    // The rows reach the model only through the gate, never through the prompt.
    expect(requests[0]!.split("Keep migrations additive")).toHaveLength(2)
    if (judged) {
      expect(judgedItems).toEqual([[{ kind: "memory", id: "note-0" }, { kind: "memory", id: "note-1" }]])
      expect(requests[0]).not.toContain("Tag the release")
      expect(settled).toHaveLength(1)
      expect(settled[0]!.source).toBe("run")
      expect(settled[0]!.scope).toContain("agent/test/Remembering")
      expect(settled[0]!.kept.filter((item) => item.kind === "memory").map((item) => item.id)).toEqual(["note-0"])
      expect(settled[0]!.withheld.map((item) => [item.kind, item.id])).toEqual([["memory", "note-1"]])
    } else {
      // An unjudged host shows every declared row and journals no reading.
      expect(judgedItems).toEqual([])
      expect(requests[0]).toContain("[flow\\u003acoding/note-1] Tag the release on Fridays")
      expect(settled).toEqual([])
    }

    // No rows declares no memory block at all.
    await run([], `memory-none-${judged}`)
    expect(requests).toHaveLength(2)
    expect(requests[1]).not.toContain("<flows_memory_context>")
  })
})

describe("AgentAction ordered fallback seats", () => {
  const Step = AgentAction.make("agent/test/FallbackReview", {
    payload: { diff: Schema.String },
    output: Review,
    seat: ["anthropic:first", "anthropic:second"],
    prompt: ({ diff }) => diff
  })
  const Workflow = Flow.make("agent/test/FallbackReviewFlow", {
    payload: { diff: Schema.String },
    success: Review,
    error: AgentAction.AgentFailure,
    body: (input) => Step.call(input)
  })
  it("switches models on provider failure and replays without contacting either model", async () => {
    const contacted: string[] = []
    const answer = scripted([answering(`{"approved":true,"issues":[]}`)], [])
    const model = Model.make({
      stream: (request) =>
        Stream.suspend(() => {
          contacted.push(request.modelId)
          return request.modelId === "first"
            ? Stream.fail(new ModelError({ code: "provider_internal", message: "unavailable", httpStatus: 503 }))
            : answer.stream(request)
        })
    })
    const stack = Layer.mergeAll(Step.layer, Interpreter.layer(Workflow)).pipe(
      Layer.provideMerge(AgentAction.layerHost({ ...host, modelRetryPolicy: Schedule.recurs(0) })),
      Layer.provideMerge(seats(model)),
      Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
      Layer.provideMerge(Safety.layer),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer)
    )
    const results = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* Workflow.execute({ diff: "change" }, { executionId: "fallback-replay" })
        const replay = yield* Workflow.execute({ diff: "change" }, { executionId: "fallback-replay" })
        return [first, replay]
      }).pipe(Effect.provide(stack))
    )
    expect(results).toEqual([{ approved: true, issues: [] }, { approved: true, issues: [] }])
    expect(contacted).toEqual(["first", "second"])
  })
})
