/**
 * The authoring surface for a model-backed step.
 *
 * `packages/smithers/flows/flow/src/Graph.ts` records the decision this module is built on:
 * the model-shaped `Dynamic` node did not come across, because **a model call
 * is an ordinary action**. That decision is right and it left a hole. The
 * runtime to run one already existed — {@link module:Agent} assembles the whole
 * cell loop and returns its `Stream<AgentEvent>` — but the only ways to reach it
 * were a markdown flow run whole by {@link module:AgentSession}, where the agent
 * *is* the flow, or a hand-registered flow body at a composition root. Neither
 * is something a workflow author can write as one step among other steps.
 *
 * {@link make} is that missing constructor. It declares an ordinary
 * `Action` — same tag, same payload schema, same `.call()`, same plan node,
 * same durable replay — and ships the implementation with it: seat, system
 * teaching, a prompt built from the step payload, and a declared output schema
 * that the answer must satisfy. Nothing about the graph changes; what changes
 * is that the author no longer supplies the implementation, because a model
 * call has exactly one.
 *
 * Structured output is enforced at this boundary by
 * `@smthrs/harness/StructuredOutput`, whose own module documentation states
 * the recovery contract: the declared schema is rendered
 * into the run's system teaching, the final `complete` transition's `output` is
 * decoded by it, and a decode miss spends a correction slot on a re-prompt
 * before it becomes a typed `StructuredOutputFailure`.
 *
 * The host half is two services. {@link Host} carries the registry, the sandbox
 * budget, and the catalog every model-backed action in a composition shares;
 * `SeatResolver` turns the declared seat string into a live model. An author's
 * declaration therefore names no model credentials and no host wiring, and a
 * test swaps the whole model for a scripted one by providing a different
 * `SeatResolver`.
 *
 * Reference consulted: `reference/effect`
 * `packages/effect/src/unstable/ai/LanguageModel.ts` (`generateObject`) for the
 * declare-schema / decode-with-typed-failure shape, and `reference/opencode`
 * `packages/llm` for keeping provider resolution behind a host-supplied seam
 * rather than in the authoring call. Deviation from effect: `generateObject`
 * sends the schema as a provider `responseFormat`; `@smthrs/model` has no such
 * request field and the cell loop's answer is a `Cell.Complete` string, so the
 * schema travels in the prompt and is enforced locally.
 *
 * @since 0.1.0
 */

import type * as Capability from "@smthrs/capability/Capability"
import * as Digest from "@smthrs/core/Digest"
import { Action, DurableClock, type Flow, FlowRuntime } from "@smthrs/flow"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import type * as CellCalls from "@smthrs/harness/CellCalls"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import { HarnessError } from "@smthrs/harness/HarnessError"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import type * as Steering from "@smthrs/harness/Steering"
import * as StructuredOutput from "@smthrs/harness/StructuredOutput"
import { Journal, JournalEvent, type StepFact } from "@smthrs/journal"
import type * as Evaluator from "@smthrs/model/Evaluator"
import type * as Model from "@smthrs/model/Model"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import * as ObservabilityMetric from "@smthrs/observability/Metric"
import type { FlowsHooks, PluginInput } from "@smthrs/plugin"
import type { FlowsConfig } from "@smthrs/plugin/Config"
import { PluginError } from "@smthrs/plugin/PluginError"
import { ModelSelection } from "@smthrs/registry/Descriptor"
import type * as Registry from "@smthrs/registry/Registry"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import type * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { Agent, type Options as AgentOptions } from "./Agent.ts"
import * as Budget from "./Budget.ts"
import { EventSink } from "./EventSink.ts"
import * as FlowEngineLike from "./FlowEngineLike.ts"
import { agentOutcome } from "./internal/AgentOutcome.ts"
import { failureJson } from "./internal/FailureJson.ts"
import * as QuotaPolicy from "./QuotaPolicy.ts"
import * as Seat from "./Seat.ts"
import { contextWindowResolver, SeatResolver } from "./SeatResolver.ts"
import * as SeatRouter from "./SeatRouter.ts"

/**
 * The host composition every model-backed action in a run shares.
 *
 * This is half of the seam a test replaces: an in-memory registry here and a
 * scripted `Model` behind `SeatResolver` are the whole difference between a
 * deterministic run and a live one. Nothing here is declared by the author, and
 * nothing the author declares can widen it — the capability envelope and the
 * executable catalog are the host's.
 *
 * @category models
 * @since 0.1.0
 */
export interface Host {
  /** Workspace instruction files judged for each action's own task. */
  readonly instructions?: AgentOptions["instructions"]
  /** Flow sources always visible to a judged action. */
  readonly pinnedSources?: AgentOptions["pinnedSources"]
  /** The catalog a cell is shown and the registry its calls resolve against. */
  readonly registry: Registry.Registry
  /** The explicit sandbox budget every cell runs under. Never unlimited. */
  readonly limits: Sandbox.Limits
  /** Wall-clock limit for one model call, supplied by the host. */
  readonly modelCallMs?: number | undefined
  /** Host executable-flow sources composed into every run's catalog. */
  readonly flows?: ReadonlyArray<FlowBinding.Source> | undefined
  /** Host implementations for module-backed flows, keyed by flow name. */
  readonly implementations?: ReadonlyMap<string, CellCalls.Implementation> | undefined
  /** Runs rendered markdown children; the host closes over their runtime dependencies. */
  readonly promptRunner?: CellCalls.PromptRunner | undefined
  readonly plugins?: PluginInput<FlowsHooks> | undefined
  readonly config?: FlowsConfig | undefined
  /** Stable system teaching placed ahead of every action's own. */
  readonly system?: ReadonlyArray<string> | undefined
  readonly capabilityEnvelope?: ReadonlyArray<Capability.CapabilityPattern> | undefined
  readonly maxFrames?: number | undefined
  /**
   * Forwarded to `Agent.Options.claimCap`.
   *
   * Zero disarms the completion claim brake for actions whose completions are
   * answers rather than workspace claims.
   */
  readonly claimCap?: number | undefined
  /** Whether this host can answer a parked agent step. Unattended hosts default to false. */
  readonly approvalChannel?: boolean | undefined
  /**
   * Provider-run tools every model call of an action may use, such as the
   * provider's own web search. Forwarded to `Agent.Options.serverTools`.
   */
  readonly serverTools?: ReadonlyArray<ModelRequest.ServerTool> | undefined
  /**
   * How many times a decode miss may be re-prompted when an action declares no
   * budget of its own.
   *
   * This is the composition-wide default the old engine spelled
   * `maxSchemaRetries`: one number an operator raises for a whole run rather
   * than editing every declaration. {@link Options.corrections} always wins,
   * including when it is zero, so a step that has declared a first miss
   * terminal stays terminal under a generous host. Omitting both leaves the
   * budget at one.
   */
  readonly defaultCorrections?: number | undefined
  /**
   * Overrides the bounded transport retry schedule at the model boundary for
   * every model-backed action in this composition.
   *
   * Forwarded to `Agent.Options.modelRetryPolicy`. A host that classifies its
   * own quota parks (see {@link module:QuotaPolicy}) sets this to keep the
   * transport ladder from spending a run's wall clock on a refusal a park will
   * wait out properly.
   */
  readonly modelRetryPolicy?: Schedule.Schedule<unknown, Model.ModelFailure> | undefined
  /**
   * How many times one ask may park on a quota refusal before the refusal is
   * reported.
   *
   * Defaults to {@link module:QuotaPolicy.defaultMaxParks}. The bound is per
   * ask: a step that parks, answers, and is then corrected starts its next ask
   * with a full allowance, because the correction is a different question.
   */
  readonly maxQuotaParks?: number | undefined
  /**
   * Whether the host's `Evaluator` is a real judge. Forwarded to each step's
   * `Agent.Options.judged`, so every subagent is armed on its own session.
   */
  readonly judged?: boolean | undefined
  /**
   * What each step's supervisor may do: its memory bank, whether it writes,
   * its monitors and its stance. Forwarded to each step's
   * `Agent.Options.supervisor`, so a subagent recalls from the run's bank and
   * is taught the operator's stance.
   */
  readonly supervisor?: AgentOptions["supervisor"]
}

/**
 * Context service for the shared host composition.
 *
 * @category services
 * @since 0.1.0
 */
export const Host: Context.Service<Host, Host> = Context.Service(
  "@smthrs/agent/AgentAction/Host"
)

/**
 * Constructs a host composition value.
 *
 * A composition default that is not a non-negative safe integer is refused
 * here rather than at the first decode miss, for the same reason a declaration
 * is: an unbounded correction budget is a run that re-prompts forever, and the
 * cheapest place to say so is where the number was written.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeHost = (host: Host): Host => {
  if (host.defaultCorrections !== undefined) {
    checkCorrections(host.defaultCorrections, "AgentAction.Host defaultCorrections")
  }
  return Host.of(host)
}

/**
 * Provides one host composition to every model-backed action in a run.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHost = (host: Host): Layer.Layer<Host> => Layer.succeed(Host)(makeHost(host))

/**
 * Everything a model-backed action can fail with.
 *
 * `StructuredOutputFailure` is the one an author handles: the model answered
 * and the answer did not fit the declared schema after its correction budget.
 * `SeatUnresolved` is the host having no model for the declared seat, and
 * `SeatUnrouted` is Jev not picking one for a step that declared `auto`.
 * `BudgetExceeded` is the run having spent what it was approved for, reported
 * at the step that would have overspent. `Budget.Skipped` is every later model
 * call in a run whose budget declared `skip-remaining`: a verdict no retry can
 * change, which is why {@link module:Budget.neverRetrySkipped} exists. The
 * other two are the composition failing underneath it.
 *
 * @category models
 * @since 0.1.0
 */
export const AgentFailure = Schema.Union([
  StructuredOutput.StructuredOutputFailure,
  Seat.SeatUnresolved,
  Seat.SeatUnrouted,
  Budget.BudgetExceeded,
  Budget.Skipped,
  HarnessError,
  PluginError
])

/**
 * Everything a model-backed action can fail with.
 *
 * @category models
 * @since 0.1.0
 */
export type AgentFailure = typeof AgentFailure.Type

/**
 * The schema a payload declaration resolves to: a field record becomes a
 * `Schema.Struct`, a schema stays itself. The same widening `Flow.make` and
 * `Action.make` perform, restated because neither exports it.
 *
 * @category models
 * @since 0.1.0
 */
export type PayloadSchemaOf<Payload extends Schema.Struct.Fields | Flow.AnyStructSchema> = Payload extends
  Schema.Struct.Fields ? Schema.Struct<Payload> : Payload

/**
 * The bounded repair ask made after a correction budget is spent.
 *
 * @category models
 * @since 0.1.0
 */
export interface Repair<Payload> {
  /**
   * The repair prompt, written from the failure and the step's own payload.
   *
   * The failure carries the declared schema's digest, the issues the last
   * candidate raised, and how many corrections were spent, so a prompt can say
   * what to fix without the author restating the schema.
   */
  readonly prompt: (
    failure: StructuredOutput.StructuredOutputFailure,
    payload: Payload
  ) => string
  /** The seat the repair runs on. Defaults to the step's own seat. */
  readonly seat?: string | undefined
  /** Stable system teaching for the repair. Defaults to the step's own. */
  readonly system?: ReadonlyArray<string> | undefined
}

/**
 * What an author declares about one model-backed step.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options<
  Payload extends Schema.Struct.Fields | Flow.AnyStructSchema,
  Output extends Schema.Top
> {
  /** The step's typed input, exactly as `Action.make` takes it. */
  readonly payload: Payload
  /** The schema the answer must satisfy. Rendered into the prompt and enforced. */
  readonly output: Output
  /**
   * A seat id or a non-empty ordered list resolved by the host. The first
   * seat is primary; the rest are fallbacks after capacity refusal, context
   * overflow, or HTTP 5xx failure.
   *
   * A callback is evaluated once per execution against the decoded payload.
   * The resolver owns seat names, including provider model ids and aliases.
   *
   * `"auto"` ({@link Seat.auto}), written or returned, routes through
   * {@link module:SeatRouter} once per execution: Jev classifies the prompt
   * and the routing graph picks the seat, its backups and the system variant,
   * so each subagent routes on its own prompt. A route to a panel runs the
   * step once per member seat and then on the merger, given the members'
   * answers. Every correction and the repair run on the routed seat unless
   * {@link Repair.seat} names one.
   */
  readonly seat: ModelSelection | ((payload: PayloadSchemaOf<Payload>["Type"]) => ModelSelection)
  /** The phase of work an `auto` seat routes as; Jev classifies it when absent. */
  readonly phase?: SeatRouter.Phase | undefined
  /** The task, built from the decoded payload. */
  readonly prompt: (payload: PayloadSchemaOf<Payload>["Type"]) => string
  /** Stable system teaching for this step, after the host's and before the schema's. */
  readonly system?: ReadonlyArray<string> | undefined
  /**
   * How many times a decode miss may be re-prompted before the step fails.
   *
   * Falls back to {@link Host.defaultCorrections}, and then to one, which
   * matches the harness's existing "correct once, then report" posture. Zero
   * declares that a first miss is terminal, and beats a generous host default
   * rather than being read as "unset".
   */
  readonly corrections?: number | undefined
  /**
   * One bounded repair ask made after the correction budget is spent.
   *
   * A correction re-prompt repeats the task verbatim and adds the validation
   * issues: it assumes the model can still answer the question it was asked. A
   * repair does not. It is the author's own prompt, written about the failure,
   * and it is asked exactly once — the old engine's repair task, which ran
   * after `maxSchemaRetries` was exhausted rather than as another rung of the
   * same ladder.
   *
   * Its answer is decoded by the same declared schema. A repair that does not
   * validate either fails the action with its own failure, which is the last
   * evidence the boundary has.
   */
  readonly repair?: Repair<PayloadSchemaOf<Payload>["Type"]> | undefined
  readonly modelParams?: ModelRequest.GenerationParams | undefined
  readonly maxFrames?: number | undefined
  /**
   * The idle bound for an action whose frames are meant to change files:
   * consecutive frames that write nothing before the run is asked for an
   * edit, and twice that before it fails `read_only_cap`. Omitted disarms it,
   * which is right for an action that only answers.
   */
  readonly readOnlyCap?: number | undefined
}

/**
 * Raised synchronously when an action declaration has an unbounded correction
 * budget.
 *
 * @category errors
 * @since 0.1.0
 */
export class InvalidCorrectionBudget extends Schema.TaggedError<InvalidCorrectionBudget>()(
  "flows/agent/InvalidCorrectionBudget",
  {
    corrections: Schema.Number,
    message: Schema.String
  }
) {}

/**
 * Refuses a correction budget that is not a non-negative safe integer.
 *
 * Shared by the declaration and the composition default so both refuse the
 * same values with the same error.
 */
const checkCorrections = (corrections: number, subject: string): void => {
  if (!Number.isSafeInteger(corrections) || corrections < 0) {
    throw new InvalidCorrectionBudget({
      corrections,
      message: `${subject} must be a non-negative safe integer`
    })
  }
}

/**
 * The journal event one rejected answer writes.
 *
 * A run that answered three times is one run with one final failure, and the
 * failure says only how the LAST candidate was wrong. The record is the rest of
 * the story: which attempt was rejected, against which schema, and a digest of
 * the issues, so two runs that spent their budget the same way can be told
 * apart without the answers themselves being journaled.
 *
 * @category records
 * @since 0.1.0
 */
export const structuredOutputRejectedEvent = "flows.agent.structured-output-rejected.v1"

/** The recorded step that decides one park, so a replay waits the same deadline; suffixed by the session. */
const quotaParkActivityName = "agent/quota-park"

/** The journal source every record this module writes is attributed to. */
const recordSource = JournalEvent.SourceId.make("/agent/action")

/**
 * Writes one record on the journal's lossy channel, when the composition has a
 * journal at all.
 *
 * Optional on purpose: a model-backed action runs on the reference memory
 * engine as readily as on the durable one, and a step that demanded a journal
 * would make the memory composition unbuildable. Lossy is the channel a
 * client-side trail takes (`AgentSession` writes its own the same way): these
 * are evidence about a run, not the run's own lifecycle state, and a durable
 * emit from inside a flow body queues behind the transaction the body is in.
 */
const record = (
  eventType: string,
  runId: string,
  payload: Record<string, unknown>
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const journal = yield* Effect.serviceOption(Journal.Journal)
    if (Option.isNone(journal)) return
    yield* journal.value.emitLossy(
      new JournalEvent.Input({
        runId: JournalEvent.RunId.make(runId),
        sourceId: recordSource,
        eventType,
        payload
      })
    ).pipe(Effect.ignore)
  })

/**
 * A declared model-backed action, plus the layer that implements it.
 *
 * The declaration half is an ordinary `Action.Declared`: `.call()` records the
 * same plan node any other action records. The {@link AgentAction.layer} half
 * is what {@link make} adds — an author never writes `toLayer` for a model
 * call, because there is only one implementation and it ships here.
 *
 * @category models
 * @since 0.1.0
 */
export interface AgentAction<
  Tag extends string,
  Payload extends Flow.AnyStructSchema,
  Output extends Schema.Top
> extends Action.Declared<Tag, Payload, Output, typeof AgentFailure> {
  readonly layer: Layer.Layer<
    Action.Requirement<Tag>,
    never,
    | Agent
    | FlowRuntime.FlowRuntime
    | Host
    | Sandbox.Sandbox
    | SeatResolver
    | Steering.Source
    | Crypto.Crypto
    | Budget.Budget
    | QuotaPolicy.QuotaClassifier
    | Evaluator.Evaluator
    | Payload["DecodingServices"]
    | Payload["EncodingServices"]
    | Output["DecodingServices"]
    | Output["EncodingServices"]
  >
}

/**
 * Reports a refused budget as the budget failure, not as a harness one.
 *
 * The model boundary can only fail with what its port declares, so a refusal
 * travels from {@link module:FlowEngineLike} wrapped in a `HarnessError`. The
 * step is where an author reads it, and at a step "this run has spent its
 * tokens" is a different fact from "the model call failed" — it names no
 * provider, and no retry of the call will change it.
 */
const budgetFailure = (failure: AgentFailure): AgentFailure =>
  failure instanceof HarnessError &&
    (failure.cause instanceof Budget.BudgetExceeded || failure.cause instanceof Budget.Skipped)
    ? failure.cause
    : failure

/**
 * Makes a failure survive the action boundary's encoder.
 *
 * `HarnessError.cause` is `Schema.Unknown`, and what the cell controller puts
 * there is a live error INSTANCE — a `ModelError` most of the time. Encoding
 * the action's failure then fails the union outright, so the caller of a
 * model-backed step that hit a provider refusal received a schema issue naming
 * every member of `AgentFailure` instead of the refusal. The provider's code,
 * its reset fields, and its message were all in the cause and none of them
 * reached the flow.
 *
 * Rendering the cause to plain JSON keeps every field and loses only the
 * prototype, which no consumer of `cause` may depend on anyway: it is typed
 * `unknown`. A cause that cannot be rendered at all — a cycle, a BigInt field
 * reported by a third-party plugin hook — is kept as its text form rather than
 * dropped, because "something failed and we cannot say what" is worse than a
 * rendered approximation.
 *
 * The rendering is the package's one failure serializer, shared with the
 * session settlement and the budget's accounting failure, so a native `Error`
 * nested in the cause keeps its message here too instead of encoding as `{}`.
 */
const encodableFailure = (failure: AgentFailure): AgentFailure => {
  if (!(failure instanceof HarnessError) || failure.cause === undefined) return failure
  return new HarnessError({
    code: failure.code,
    message: failure.message,
    cause: failureJson(failure.cause)
  })
}

/**
 * Routes one execution of a step that declared {@link Seat.auto}.
 *
 * The decision is keyed by the execution and the dispatch, so every rung of
 * the step reuses it. A composition that binds no catalog fails the step as
 * `unconfigured`, and a recorded variant the catalog no longer offers fails it
 * rather than running without the teaching it was picked for.
 */
const routeSeat = (
  tag: string,
  task: string,
  executionId: string,
  stepId: string | undefined,
  phase: SeatRouter.Phase | undefined
) =>
  Effect.gen(function*() {
    const unrouted = (message: string) => new Seat.SeatUnrouted({ seat: Seat.auto, reason: "unconfigured", message })
    const catalog = yield* Effect.serviceOption(SeatRouter.Catalog)
    if (Option.isNone(catalog)) return yield* unrouted(`The agent action "${tag}" has no seat catalog to route in`)
    const decision = yield* SeatRouter.durable(
      {
        declared: Seat.auto,
        state: { task, flow: tag, description: tag, capabilities: [] },
        phase
      },
      { executionId, purpose: stepId ?? tag }
    ).pipe(Effect.provideService(SeatRouter.Catalog, catalog.value))
    const variant = SeatRouter.variantText(catalog.value.variants, decision.variant)
    if (variant === undefined) {
      return yield* unrouted(`The seat catalog no longer offers the variant "${decision.variant}"`)
    }
    return { decision, variant }
  })

/**
 * Declares a model-backed action and ships its implementation.
 *
 * The returned value is used exactly like any other declared action — `.call()`
 * in a flow body, `.layer` in the composition — with one difference: the layer
 * is already written. What it does is resolve the seat through `SeatResolver`,
 * run one agent loop through {@link module:Agent} inside the current flow
 * execution, and decode the run's final answer with the declared output schema,
 * spending {@link Options.corrections} re-prompts before it reports a typed
 * `StructuredOutputFailure`.
 *
 * @example
 * ```ts
 * import * as AgentAction from "@smthrs/agent/AgentAction"
 * import * as Schema from "effect/Schema"
 *
 * const Research = AgentAction.make("docs/Research", {
 *   payload: { topic: Schema.String },
 *   output: Schema.Struct({ summary: Schema.String }),
 *   seat: "anthropic:claude-sonnet-4-5",
 *   system: ["You are a research assistant."],
 *   prompt: ({ topic }) => `Research ${topic}.`
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <
  const Tag extends string,
  Payload extends Schema.Struct.Fields | Flow.AnyStructSchema,
  Output extends Schema.Top
>(
  tag: Tag,
  options: Options<Payload, Output>
): AgentAction<Tag, PayloadSchemaOf<Payload>, Output> => {
  if (options.corrections !== undefined) {
    checkCorrections(options.corrections, "AgentAction corrections")
  }
  type PayloadSchema = PayloadSchemaOf<Payload>
  const declared = Action.make(tag, {
    payload: options.payload,
    success: options.output,
    error: AgentFailure
  }) as unknown as Action.Declared<Tag, PayloadSchema, Output, typeof AgentFailure>

  const execute = (payload: PayloadSchema["Type"]) =>
    Effect.gen(function*() {
      const host = yield* Host
      const seats = yield* SeatResolver
      const agent = yield* Agent
      const instance = yield* FlowRuntime.FlowInstance
      // Resolved once, before the first attempt, and asked nothing further. A
      // composition either equips its steps with somewhere to send events as
      // they happen or it does not, and the absence is the buffered behavior
      // this action has always had rather than a failure.
      const sink = yield* Effect.serviceOption(EventSink)
      const invocation = yield* Action.CurrentInvocationKey
      const dispatchAttempt = yield* Action.CurrentAttempt
      const stepId = invocation === undefined ? undefined : Digest.digest(invocation)
      const sessionRoot = `${instance.executionId}/${tag}${stepId === undefined ? "" : `@${stepId}:${dispatchAttempt}`}`
      if (stepId === undefined && Option.isSome(sink) && sink.value.atSource === true) {
        return yield* new HarnessError({
          code: "engine_failed",
          message: "Agent monitoring requires a durable dispatch identity"
        })
      }
      const task = options.prompt(payload)
      // One resolution per execution: the declared seat may be a function of
      // the payload, and every later rung compares against the id it chose.
      const declaredSeat = typeof options.seat === "function" ? options.seat(payload) : options.seat
      const declaredIds = typeof declaredSeat === "string" ? [declaredSeat] : declaredSeat
      if (!Schema.is(ModelSelection)(declaredSeat) || declaredIds.some((id) => id.trim() === "")) {
        return yield* new HarnessError({
          code: "model_failed",
          message: "AgentAction seat must name a model or a non-empty model list"
        })
      }
      // `auto` asks Jev once per execution, as a sealed step, so each subagent
      // routes on its own prompt and a replay is served the seat it ran on.
      const routed = declaredSeat === Seat.auto
        ? yield* routeSeat(tag, task, instance.executionId, stepId, options.phase)
        : undefined
      const ids = routed === undefined ? declaredIds : [routed.decision.seat, ...routed.decision.backups]
      /** The trace coordinates of one ask, when the dispatch has an identity. */
      const stepOf = (ask: StepFact.Step["ask"], retry: number, scope: string): StepFact.Step | undefined =>
        stepId === undefined ? undefined : {
          stepId,
          executionId: instance.executionId,
          action: tag,
          attempt: dispatchAttempt,
          ask,
          retry,
          scope
        }
      if (routed !== undefined && Option.isSome(sink)) {
        // The routing receipt reaches the sink ahead of the first ask's events.
        const step = stepOf(0, yield* Action.CurrentAttempt, sessionRoot)
        const modelId = (yield* seats.resolve(routed.decision.seat)).modelId
        for (const event of SeatRouter.events(routed.decision, { scope: sessionRoot, modelId })) {
          yield* sink.value.emit(event, step)
        }
      }
      const quota = yield* QuotaPolicy.current
      const maxParks = host.maxQuotaParks ?? QuotaPolicy.defaultMaxParks
      // The declaration decides, the composition supplies the default, and one
      // is the floor. Zero is a declared decision, so `??` and not `||`.
      const limit = options.corrections ?? host.defaultCorrections ?? 1
      const variant = routed?.variant ?? []
      const system = [
        ...(host.system ?? []),
        ...variant,
        ...(options.system ?? []),
        StructuredOutput.instructions(options.output)
      ]

      /**
       * Waits out a quota refusal instead of failing on it.
       *
       * The park is a real durable wait — `annotateWaiting` classifies the
       * suspension as `quota` and `DurableClock.sleep` holds the deadline — so
       * a supervisor sees a parked run with a wake time rather than a run that
       * stalled, and a process that dies during the wait resumes into it.
       * The one-millisecond `inMemoryThreshold` is deliberate: a two-second
       * window is still a park, and `DurableClock.sleep`'s default threshold
       * would run any wait of a minute or less as an in-memory sleep, hiding it
       * from every operator view. One millisecond rather than zero because the
       * option is read for truthiness, so zero silently means "unset".
       *
       * `Action.retry` is what makes the retry a retry: it bumps the attempt
       * the enclosing dispatches run under, so the re-issued model call is a
       * NEW attempt of the same step rather than a replay of the attempt the
       * provider refused. The step's own correction budget is untouched, which
       * is the old engine's rule that a quota wait is not a failed attempt.
       *
       * `waiting` is mutable because the classification is made once, where the
       * clock is, and read by the retry predicate immediately after it; the
       * predicate has no clock of its own and must not guess a second instant.
       */
      const waitOutQuota = <A, E, R>(
        session: string,
        effect: Effect.Effect<A, E, R>
      ): Effect.Effect<A, E, R | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance | Crypto.Crypto> => {
        let waiting = false
        let parked = 0
        return Action.retry(
          effect.pipe(
            Effect.tapError((error) =>
              Effect.gen(function*() {
                if (parked >= maxParks) return
                // The decision is a RECORDED step, not a computation the body
                // repeats. A park is read off the wall clock, so a replay that
                // classified afresh would choose a new deadline every time the
                // body re-ran and the run would park again on every resume.
                // Recording it also puts the wake time and its source in the
                // run's own evidence, where an operator reads them.
                const decision = yield* Action.make({
                  // Named per session, so concurrent panel members each park
                  // under their own ordinals and replay deterministically.
                  name: `${quotaParkActivityName}/${session}`,
                  success: Schema.NullOr(QuotaPolicy.Park),
                  tier: "sealed",
                  execute: Effect.gen(function*() {
                    const now = yield* Clock.currentTimeMillis
                    const park = quota.classify(error, now)
                    if (Option.isNone(park)) return null
                    yield* record(QuotaPolicy.quotaParkedEvent, instance.executionId, {
                      action: tag,
                      session,
                      wakeAt: park.value.wakeAt,
                      source: park.value.source
                    })
                    // Count only the first execution of the sealed decision.
                    // Replaying the recorded park must not count it again.
                    yield* Metric.update(ObservabilityMetric.quotaParks, 1)
                    return park.value
                  })
                })
                if (decision === null) return
                parked++
                waiting = true
                const now = yield* Clock.currentTimeMillis
                yield* FlowRuntime.annotateWaiting({ reason: "quota", wakeAt: decision.wakeAt })
                yield* DurableClock.sleep({
                  name: `${tag}/quota/${session}#${parked}`,
                  duration: Duration.millis(Math.max(0, decision.wakeAt - now)),
                  inMemoryThreshold: 1
                })
              })
            )
          ),
          {
            while: () => {
              const again = waiting
              waiting = false
              return again
            },
            times: maxParks
          }
        )
      }

      /**
       * Runs the step's correction ladder, then its repair, under `root` on
       * the seats `ids` name: the first is primary and the rest are its
       * fallbacks.
       */
      const solve = (root: string, question: string, ids: ReadonlyArray<string>) =>
        Effect.gen(function*() {
          const seatId = ids[0]!
          const resolvedSeats = yield* Effect.forEach(ids, (id) => seats.resolve(id))
          const seat = resolvedSeats[0]!
          const fallbackSeats = resolvedSeats.slice(1)

          /**
           * One whole cell run, under its own session and prompt.
           *
           * `correction` is the ladder rung this ask is, and it travels into the
           * engine port rather than only into the session string: the session is
           * key material and is hashed, so a reader of the run's sealed steps
           * could see three model calls and not which of them was the ask. The
           * port stamps the ordinal onto each rung's own durable record.
           */
          const ask = (
            session: string,
            prompt: string,
            teaching: ReadonlyArray<string>,
            askSeat: string,
            correction: number | undefined
          ): Effect.Effect<
            string,
            AgentFailure,
            | FlowRuntime.FlowRuntime
            | FlowRuntime.FlowInstance
            | Sandbox.Sandbox
            | Steering.Source
            | Crypto.Crypto
            | Budget.Budget
            | QuotaPolicy.QuotaClassifier
            | Evaluator.Evaluator
          > =>
            waitOutQuota(
              session,
              Effect.gen(function*() {
                const step = stepOf(correction ?? "repair", yield* Action.CurrentAttempt, session)
                const observe = (event: AgentEvent.AgentEvent): Effect.Effect<void> =>
                  Option.isNone(sink) ? Effect.void : sink.value.emit(event, step)
                const atSource = Option.isSome(sink) && sink.value.atSource === true
                const resolved = askSeat === seatId ? seat : yield* seats.resolve(askSeat)
                const outcome = yield* agent.run({
                  instructions: host.instructions,
                  pinnedSources: host.pinnedSources,
                  contextWindowTokensFor: contextWindowResolver(seats),
                  session,
                  seat: resolved,
                  ...(askSeat === seatId ? { fallbackSeats } : {}),
                  // This adapter owns its recorded quota park and replay decision.
                  capacity: { park: false },
                  prompt,
                  system: teaching,
                  registry: host.registry,
                  flows: host.flows,
                  implementations: host.implementations,
                  promptRunner: host.promptRunner,
                  plugins: host.plugins,
                  config: host.config,
                  modelParams: options.modelParams,
                  modelRetryPolicy: host.modelRetryPolicy,
                  capabilityEnvelope: host.capabilityEnvelope,
                  limits: host.limits,
                  modelCallMs: host.modelCallMs,
                  maxFrames: options.maxFrames ?? host.maxFrames,
                  readOnlyCap: options.readOnlyCap,
                  claimCap: host.claimCap,
                  serverTools: host.serverTools,
                  judged: host.judged,
                  supervisor: host.supervisor,
                  approvalChannel: host.approvalChannel
                }).pipe(
                  Stream.provideService(AgentEvent.Observer, atSource ? observe : () => Effect.void),
                  (stream) => agentOutcome(stream, atSource ? () => Effect.void : observe)
                )
                if (outcome._tag === "FramesExhausted") {
                  return yield* new HarnessError({
                    code: "model_failed",
                    message:
                      `The agent action "${tag}" ended without a completed answer after ${outcome.frames} frames`,
                    cause: outcome
                  })
                }
                return outcome.output
              }).pipe(Effect.provideService(FlowEngineLike.Correction, correction))
            )

          /**
           * The bounded repair, or the exhausted failure when none was declared.
           *
           * It asks once. A repair that misses too reports its own failure rather
           * than the correction ladder's: it is the last thing the boundary saw,
           * and an operator reading the run needs to know the repair ran and what
           * it answered, not what the third correction said.
           */
          const repair = (
            failure: StructuredOutput.StructuredOutputFailure
          ): Effect.Effect<
            Output["Type"],
            AgentFailure,
            | FlowRuntime.FlowRuntime
            | FlowRuntime.FlowInstance
            | Sandbox.Sandbox
            | Steering.Source
            | Crypto.Crypto
            | Budget.Budget
            | QuotaPolicy.QuotaClassifier
            | Evaluator.Evaluator
            | Output["DecodingServices"]
          > => {
            const declaredRepair = options.repair
            if (declaredRepair === undefined) return Effect.fail(failure)
            return ask(
              `${root}#repair`,
              declaredRepair.prompt(failure, payload),
              declaredRepair.system === undefined ? system : [
                ...(host.system ?? []),
                ...variant,
                ...declaredRepair.system,
                StructuredOutput.instructions(options.output)
              ],
              declaredRepair.seat ?? seatId,
              // The repair is not a rung of the ladder: it is the one ask that
              // follows the ladder's exhaustion, and numbering it `limit + 1`
              // would present it as a correction the policy never allowed.
              undefined
            ).pipe(
              Effect.flatMap((answer) => StructuredOutput.decode(options.output, answer, { corrections: limit, limit }))
            )
          }

          // One attempt is one whole cell run. The correction re-prompt is a NEW
          // run under a distinct session carrying the diagnostics, so its sealed
          // step keys differ from the attempt it is correcting and a replay
          // reproduces both rather than collapsing them onto one recorded model
          // call.
          const attempt = (
            correction: number,
            prompt: string
          ): Effect.Effect<
            Output["Type"],
            AgentFailure,
            | FlowRuntime.FlowRuntime
            | FlowRuntime.FlowInstance
            | Sandbox.Sandbox
            | Steering.Source
            | Crypto.Crypto
            | Budget.Budget
            | QuotaPolicy.QuotaClassifier
            | Evaluator.Evaluator
            | Output["DecodingServices"]
          > =>
            ask(`${root}#${correction}`, prompt, system, seatId, correction).pipe(
              Effect.flatMap((answer) =>
                StructuredOutput.decode(options.output, answer, { corrections: correction, limit })
              ),
              Effect.catchTag("/harness/StructuredOutputFailure", (failure) =>
                record(structuredOutputRejectedEvent, instance.executionId, {
                  action: tag,
                  attempt: correction,
                  limit,
                  schema: failure.schema,
                  candidate: failure.candidate,
                  issuesDigest: StructuredOutput.issuesDigest(failure)
                }).pipe(
                  Effect.andThen(
                    correction >= limit
                      ? repair(failure)
                      : attempt(correction + 1, `${question}\n\n${StructuredOutput.correction(failure)}`)
                  )
                ))
            )

          return yield* attempt(0, question)
        })

      // A panel's members answer in parallel, each under its own session, so
      // each is its own durable scope and a replay serves each its own run.
      // A member that fails after its backups is left out; the merger then
      // answers with the survivors' answers in hand.
      const panel = routed?.decision.panel
      const solved = panel === undefined ? solve(sessionRoot, task, ids) : Effect.gen(function*() {
        const results = yield* Effect.forEach(panel.seats, (member, index) =>
          solve(`${sessionRoot}/panel/${index}`, task, [member.seat, ...member.backups]).pipe(
            Effect.flatMap((answer) => Schema.encodeUnknownEffect(options.output)(answer)),
            Effect.mapError((failure) =>
              Schema.isSchemaError(failure)
                ? new HarnessError({
                  code: "model_failed",
                  message: `The panel answer of ${member.seat} did not encode`
                })
                : failure
            ),
            Effect.result
          ), { concurrency: "unbounded" })
        const answered = panel.seats.flatMap((member, index) => {
          const result = results[index]!
          return Result.isSuccess(result) ? [[member.seat, JSON.stringify(result.success)] as const] : []
        })
        const failed = panel.seats.filter((_, index) =>
          Result.isFailure(results[index]!)
        ).map(({ seat }) => seat)
        if (answered.length === 0) {
          return yield* Effect.fail((results[0] as Result.Failure<never, AgentFailure>).failure)
        }
        return yield* solve(`${sessionRoot}/merge`, SeatRouter.mergePrompt(task, answered, failed), ids)
      })

      return yield* solved.pipe(
        Effect.mapError(budgetFailure),
        Effect.mapError(encodableFailure)
      )
    })

  return {
    ...declared,
    layer: declared.toLayer(execute)
  }
}
