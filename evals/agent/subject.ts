/**
 * The subject under evaluation: the Smithers agent, composed the way a host
 * composes it.
 *
 * The behaviour under evaluation is production code: the cell controller and
 * its loop, the QuickJS sandbox, the registry-backed call bridge, the
 * structured-output boundary, and the seat seam are the same objects a real
 * host wires. What the suite supplies around them is stated rather than
 * implied. Execution runs on `FlowEngine.layerMemory`, the engine's in-process
 * volatile runtime, not the durable SQLite one a deployed host uses. The
 * `Model` behind `SeatResolver` answers with recorded cells instead of
 * streaming from a provider, the `Route` it seals against never leaves the
 * process, and the `Registry` is an empty one this file builds. That is what
 * makes the suite offline, deterministic, and safe to run in CI with no API
 * key, and it is also the boundary of what a green run proves: the loop and its
 * seams, not durability and not a real catalog.
 *
 * Two entry points, because the agent has two public ways in and both are worth
 * measuring. {@link runAction} drives it through `AgentAction` — one typed step
 * inside an ordinary flow, with a declared output schema the answer must
 * satisfy. {@link runAgent} drives the `Agent` service directly inside a real
 * flow execution, which is how a scenario reaches an option `AgentAction` does
 * not forward, such as `readOnlyCap`.
 *
 * Imports reach the workspace packages by relative path because the repository
 * root does not depend on `@smthrs/agent`; pnpm resolves each package's
 * internal dependencies to the same realpaths, so module identity holds.
 *
 * @since 0.1.0
 */
import * as ScriptedJudge from "../../packages/smithers/agent/src/ScriptedJudge.ts"
import * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import {
  Agent,
  AgentAction,
  Budget,
  type FlowEngineLike,
  QuotaPolicy,
  Seat,
  SeatResolver
} from "../../packages/smithers/agent/src/index.ts"
import { Flow as CoreFlow } from "../../packages/smithers/flows/core/src/index.ts"
import { FlowEngine } from "../../packages/smithers/flows/engine/src/index.ts"
import { Action, Flow, FlowRuntime, Interpreter } from "../../packages/smithers/flows/flow/src/index.ts"
import type { AgentEvent } from "../../packages/smithers/agent/harness/src/index.ts"
import { FlowBinding } from "../../packages/smithers/agent/harness/src/index.ts"
import {
  Model,
  ModelEvent,
  type ModelRequest,
  type Route
} from "../../packages/smithers/agent/model/src/index.ts"
import { Node } from "../../packages/smithers/flows/plan/src/index.ts"
import { Registry } from "../../packages/smithers/agent/registry/src/index.ts"

const hostCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(() => globalThis.crypto.subtle.digest(algorithm, data.slice().buffer)).pipe(
        Effect.map((buffer) => new Uint8Array(buffer))
      )
  })
)

// Every eval seat is scripted, so there is no provider quota to park on. The
// suite also has no approved plan envelope from which to derive a spend cap.
// eslint-disable-next-line no-restricted-syntax -- offline evals have no approved envelope
const offlinePolicy = Layer.mergeAll(QuotaPolicy.layerUnclassified(), Budget.layerUnbounded())

// The completion brake never falls back: a claim nothing judged fails the run
// as `completion_unjudged`. This suite explicitly binds an offline judge that
// compares claimed commands with recorded checks, answers all three completion
// questions from that evidence, and refuses questions it does not understand.
const offlineEvaluator = ScriptedJudge.layer

/**
 * What one scenario run reports, and the only thing the scorers read.
 *
 * The shape is deliberately flat and JSON-comparable: a case's `expected` is a
 * literal of it, so a baseline diff names the behaviour that changed rather
 * than a score that moved.
 *
 * @category models
 * @since 0.1.0
 */
export const Observation = Schema.Struct({
  /** `answer` when the step produced a value, `failure` when it reported one. */
  kind: Schema.Literals(["answer", "failure"]),
  /** The decoded answer. Present only when `kind` is `answer`. */
  value: Schema.optional(Schema.Unknown),
  /** The failure's schema tag. Present only when `kind` is `failure`. */
  failure: Schema.optional(Schema.String),
  /** How many times the agent called the model across the whole scenario. */
  modelCalls: Schema.Finite,
  /** The flows the cell invoked, in call order. */
  flowCalls: Schema.Array(Schema.String)
})

/**
 * What one scenario run reports.
 *
 * @category models
 * @since 0.1.0
 */
export type Observation = typeof Observation.Type

/**
 * The mutable tally one scenario writes as it runs.
 *
 * @category models
 * @since 0.1.0
 */
export interface Recorder {
  readonly requests: Array<string>
  readonly flowCalls: Array<string>
}

/**
 * Builds an empty tally for one scenario.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeRecorder = (): Recorder => ({ requests: [], flowCalls: [] })

/**
 * Decides the next cell from the prompt the model was given and the number of
 * calls that came before it.
 *
 * @category models
 * @since 0.1.0
 */
export type Respond = (prompt: string, index: number) => string

const prepared: Route.PreparedRequest = {
  routeId: "evals/agent",
  protocolId: "evals/agent",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

/**
 * The whole prompt one call was shown, system teaching first. A scenario reads
 * this to decide what to answer, which is how a case can prove that a piece of
 * teaching actually reached the provider.
 */
const rendered = (request: ModelRequest.ModelRequest): string =>
  request.system.map((part) => part.text).join("\n") + "\n" +
  request.messages.flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
    .join("\n")

/**
 * The scripted provider. It records every prompt it is shown and answers with
 * one fenced cell, which is exactly the surface a real provider presents to the
 * loop.
 */
const scripted = (recorder: Recorder, respond: Respond): Model.Model =>
  Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        const prompt = rendered(request)
        const index = recorder.requests.length
        recorder.requests.push(prompt)
        const source = respond(prompt, index)
        const id = `cell-${index}`
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id, text: "```cell\n" + source + "\n```" }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })

/**
 * A cell that finishes the run with a literal answer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const completeWith = (output: string): string => `ctx.done(${JSON.stringify(output)})`

/**
 * A cell that never finishes, so a frame budget is what stops the run.
 *
 * @category constructors
 * @since 0.1.0
 */
export const stall = `var thinking = true`

/**
 * A cell that calls the `echo` flow and reports what came back.
 *
 * @category constructors
 * @since 0.1.0
 */
export const callEcho =
  `const out = await ctx.call("echo", { note: "one" })\nctx.done('{"approved":true,"issues":["' + out.echoed + '"]}')`

/** The seat seam, holding a scripted model instead of a credentialed route. */
const scriptedSeats = (
  recorder: Recorder,
  respond: Respond
): Layer.Layer<SeatResolver.SeatResolver> =>
  SeatResolver.layer({
    resolve: (id) =>
      Effect.succeed(
        Seat.make({
          id,
          modelId: Seat.modelIdOf(id),
          model: scripted(recorder, respond),
          route,
          contextWindowTokens: 200_000
        })
      )
  })

const emptyRegistry: Registry.Registry = Registry.makeNoop({
  list: () => Effect.succeed([]),
  visible: () => Effect.succeed([]),
  getOption: () => Effect.succeed(Option.none())
})

const echo = CoreFlow.make({
  name: "echo",
  description: "Echoes a note back to the cell that called it.",
  input: Schema.Struct({ note: Schema.String }),
  output: Schema.Struct({ echoed: Schema.String }),
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" }
})

/**
 * One host-supplied executable flow, so a scenario can measure a real call
 * boundary rather than a mocked one.
 *
 * @category constructors
 * @since 0.1.0
 */
export const echoSource = (recorder: Recorder): FlowBinding.Source =>
  FlowBinding.source("evals/agent", [
    FlowBinding.make({
      flow: echo,
      handler: (input) =>
        Effect.sync(() => {
          recorder.flowCalls.push("echo")
          return { echoed: `pong:${input.note}` }
        })
    })
  ])

const probe = CoreFlow.make({
  name: "probe",
  description: "Read something and report that it was read.",
  input: Schema.Struct({ note: Schema.String }),
  output: Schema.Struct({ read: Schema.Boolean }),
  effects: { reads: ["/**"], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" }
})

/**
 * A read that declares no writes, so a frame spent on it is a read-only frame.
 *
 * @category constructors
 * @since 0.1.0
 */
export const probeSource = (recorder: Recorder): FlowBinding.Source =>
  FlowBinding.source("evals/agent/probe", [
    FlowBinding.make({
      flow: probe,
      handler: (input) =>
        Effect.sync(() => {
          recorder.flowCalls.push(`probe:${input.note}`)
          return { read: true }
        })
    })
  ])

const check = CoreFlow.make({
  name: "check",
  description: "Run a check over a path and report its exit status.",
  input: Schema.Struct({ command: Schema.String, only: Schema.optional(Schema.String) }),
  output: Schema.Struct({ exitCode: Schema.Number }),
  effects: { reads: ["/**"], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" }
})

const apply = CoreFlow.make({
  name: "apply",
  description: "Write a change to a path.",
  input: Schema.Struct({ path: Schema.String }),
  output: Schema.Struct({ written: Schema.Boolean }),
  effects: { reads: [], writes: ["/**"], mode: "hermetic", onConflict: "serialize", tier: "irreversible" }
})

/**
 * A check that reports an exit status, and a write that moves the workspace.
 *
 * The pair is what the sufficiency signal is built out of: `exitCode` is the
 * one wire key the controller reads off an otherwise opaque result, and a
 * declared write is what makes a frame a mutating one on a host that measures
 * nothing — which this one does not, so the declaration is the whole basis.
 * The check answers by what the run has already done rather than by how it was
 * called, so the scenario's sequence is what decides the statuses: failing
 * while nothing has been written, passing once something has. The one exception
 * is `only: "green"`, which passes whatever the run has done — a check with no
 * failing side, which is what a vacuous proof is made of.
 *
 * `irreversible` is the honest tier for the write. It is what a shell command
 * that edits a file gets, it keeps two invocations of one declaration distinct
 * under the engine's own keying, and unlike `compensable` it needs no
 * compensation seam — this composition has none, and a run that asked for one
 * suspends instead of finishing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const checkSource = (recorder: Recorder): FlowBinding.Source =>
  FlowBinding.source("evals/agent/check", [
    FlowBinding.make({
      flow: check,
      handler: (input) =>
        Effect.sync(() => {
          const written = recorder.flowCalls.includes("apply")
          recorder.flowCalls.push(input.only === undefined ? "check" : `check:${input.only}`)
          // `only: "green"` names a check nothing in this tree can make fail —
          // the shape a task with no reproducible bug has, and the shape a run
          // stores as its proof when it has stopped looking for one. It is what
          // the vacuous-verification scenario needs and what the sufficiency
          // scenario must never accidentally get.
          return { exitCode: input.only === "green" || written ? 0 : 1 }
        })
    }),
    FlowBinding.make({
      flow: apply,
      handler: () =>
        Effect.sync(() => {
          recorder.flowCalls.push("apply")
          return { written: true }
        })
    })
  ])

const Review = Schema.Struct({
  approved: Schema.Boolean,
  issues: Schema.Array(Schema.String)
})

/**
 * The step under evaluation: an ordinary declared action whose implementation
 * is the agent loop, bounded by a declared output schema.
 */
const Reviewer = AgentAction.make("evals/agent/Reviewer", {
  payload: { diff: Schema.String },
  output: Review,
  seat: "anthropic:scripted",
  system: ["You review diffs."],
  prompt: ({ diff }) => `Review this diff:\n${diff}`
})

const ReviewFlow = Flow.make("evals/agent/ReviewFlow", {
  payload: { diff: Schema.String },
  success: Review,
  error: AgentAction.AgentFailure,
  body: ({ diff }) => Reviewer.call({ diff })
})

const tagOf = (error: unknown): string =>
  typeof error === "object" && error !== null && typeof (error as { readonly _tag?: unknown })._tag === "string"
    ? (error as { readonly _tag: string })._tag
    : "unknown"

const observe = (exit: Exit.Exit<unknown, unknown>, recorder: Recorder): Observation => {
  const tally = { modelCalls: recorder.requests.length, flowCalls: [...recorder.flowCalls] }
  return Exit.isSuccess(exit)
    ? { kind: "answer", value: exit.value, ...tally }
    : { kind: "failure", failure: tagOf(Cause.squash(exit.cause)), ...tally }
}

/**
 * What a scenario declares about the host it runs under.
 *
 * @category models
 * @since 0.1.0
 */
export interface ActionOptions {
  readonly recorder: Recorder
  readonly respond: Respond
  /** The frame budget the action inherits from the host. Never unbounded. */
  readonly maxFrames: number
  /** Host executable flows the cell may call. */
  readonly flows?: ReadonlyArray<FlowBinding.Source> | undefined
  /** Set false to run with a resolver that has no model for the seat. */
  readonly resolvable?: boolean | undefined
}

/**
 * Runs the agent as one typed step inside a flow, and reports what came out.
 *
 * @category runners
 * @since 0.1.0
 */
export const runAction = (options: ActionOptions): Effect.Effect<Observation> =>
  ReviewFlow.execute({ diff: "-  old\n+  new" }, { executionId: "evals-agent" }).pipe(
    Effect.provide(
      Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)).pipe(
        Layer.provideMerge(AgentAction.layerHost({
          registry: emptyRegistry,
          limits: { calls: 8 },
          capabilityEnvelope: [],
          maxFrames: options.maxFrames,
          ...(options.flows === undefined ? {} : { flows: options.flows })
        })),
        Layer.provideMerge(
          options.resolvable === false
            ? SeatResolver.layerNoop()
            : scriptedSeats(options.recorder, options.respond)
        ),
        Layer.provideMerge(Layer.merge(Agent.layer, Agent.layerDefaults)),
        Layer.provideMerge(offlinePolicy),
        Layer.provideMerge(offlineEvaluator),
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(hostCrypto)
      )
    ),
    Effect.exit,
    Effect.map((exit) => observe(exit, options.recorder))
  )

/**
 * The one flow a direct-agent scenario executes. Its body is inert: the
 * behaviour under evaluation is the handler registered against it, because the
 * agent's engine port is per-execution and a run has to start inside one.
 */
const DriveFlow = Flow.make("evals/agent/DriveFlow", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

const resolvedText = (events: ReadonlyArray<AgentEvent.AgentEvent>): string | undefined => {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event._tag === "resolved") {
      return event.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    }
  }
  return undefined
}

/**
 * What a direct-agent scenario declares.
 *
 * @category models
 * @since 0.1.0
 */
export interface AgentOptions {
  readonly recorder: Recorder
  readonly respond: Respond
  readonly maxFrames: number
  /** Require a precise failure reason before reducing it to the stable observation. */
  readonly expectedFailureCode?: string | undefined
  /** Caps consecutive read-only frames, the task-run discipline. */
  readonly readOnlyCap?: number | undefined
  /** Host executable flows the cell may call. */
  readonly flows?: ReadonlyArray<FlowBinding.Source> | undefined
}

/**
 * Runs the agent directly inside a real flow execution, and reports the answer
 * the loop resolved with.
 *
 * @category runners
 * @since 0.1.0
 */
export const runAgent = (options: AgentOptions): Effect.Effect<Observation> =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const settled = Deferred.makeUnsafe<Exit.Exit<unknown, unknown>>()
    const body = Effect.gen(function*() {
      const agent = yield* Agent.Agent
      const collected: Array<AgentEvent.AgentEvent> = []
      yield* agent.run({
        session: "evals-agent",
        seat: Seat.make({
          id: "anthropic:scripted",
          modelId: "scripted",
          model: scripted(options.recorder, options.respond),
          route,
          contextWindowTokens: 200_000
        }),
        prompt: "Review the diff and report when you are done.",
        registry: emptyRegistry,
        capabilityEnvelope: [],
        maxFrames: options.maxFrames,
        ...(options.flows === undefined ? {} : { flows: options.flows }),
        ...(options.readOnlyCap === undefined ? {} : { readOnlyCap: options.readOnlyCap })
      }).pipe(
        Stream.runForEach((event) => Effect.sync(() => collected.push(event))),
        Effect.provide(Layer.merge(Agent.layerDefaults, offlineEvaluator))
      )
      const answer = resolvedText(collected)
      return answer === undefined ? yield* Effect.fail(new Error("the run resolved with no answer")) : answer
    }).pipe(Effect.provide(Agent.layer), Effect.provide(offlinePolicy))

    yield* engine.register(
      DriveFlow,
      () => Effect.onExit(body, (exit) => Effect.asVoid(Deferred.succeed(settled, exit)))
    ).pipe(
      Scope.provide(scope)
    )
    yield* engine.execute(DriveFlow, { executionId: "evals-agent", payload: {}, discard: true })
    const exit = yield* Deferred.await(settled)
    if (options.expectedFailureCode !== undefined) {
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== options.expectedFailureCode) {
        return yield* Effect.die(new Error(`Expected failure code ${options.expectedFailureCode}`))
      }
    }
    return observe(exit, options.recorder)
  }).pipe(
    Effect.provide(Layer.merge(FlowEngine.layerMemory, hostCrypto)),
    Effect.scoped,
    Effect.orDie
  )
