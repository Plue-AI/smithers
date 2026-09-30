import { Capability } from "@smthrs/kernel"
import { ModelEvent, ModelRequest } from "@smthrs/model"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Descriptor } from "@smthrs/registry"
import { Clock, Effect, type Layer, Option, Schema, Stream } from "effect"
import * as AgentEvent from "../../src/AgentEvent.ts"
import * as CellHistory from "../../src/CellHistory.ts"
import * as CellTurn from "../../src/CellTurn.ts"
import * as ContextWindow from "../../src/ContextWindow.ts"
import * as EngineLike from "../../src/EngineLike.ts"
import { HarnessError } from "../../src/HarnessError.ts"
import * as QuickJSSandbox from "../../src/QuickJSSandbox.ts"
import type * as Sandbox from "../../src/Sandbox.ts"
import * as Steering from "../../src/Steering.ts"
import * as Supervisor from "../../src/Supervisor.ts"
import * as ScriptedEngine from "./scriptedEngine.ts"
import * as ScriptedModel from "./scriptedModel.ts"

/**
 * A model-invocable flow the controller can disclose and call.
 *
 * @category fixtures
 * @since 0.1.0
 */
export const descriptor = (
  name: string,
  overrides: {
    readonly tier?: Descriptor.EffectTier
    readonly capabilities?: ReadonlyArray<string>
    /** Declared write set, which is what makes a call count as a mutation. */
    readonly writes?: ReadonlyArray<string>
  } = {}
): Descriptor.FlowDescriptor =>
  new Descriptor.FlowDescriptor({
    name,
    description: `The ${name} flow.`,
    body: new Descriptor.BodyRefModule({ path: `/flows/${name}/flow.ts` }),
    input: new Descriptor.SchemaRefNone(),
    output: new Descriptor.SchemaRefNone(),
    model: Option.none(),
    flows: [],
    capabilities: overrides.capabilities ?? [],
    effects: {
      reads: [],
      writes: overrides.writes ?? [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: overrides.tier ?? "sealed"
    },
    placement: Option.none(),
    modelInvocable: true,
    path: `/flows/${name}`,
    frontmatter: {},
    provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
  })

/**
 * A recorded model frame whose text carries one fenced cell.
 *
 * @category fixtures
 * @since 0.1.0
 */
export const emits = (cell: string): ScriptedModel.Step => ({
  events: [
    ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
    ModelEvent.ModelEvent.TextDelta({
      type: "text-delta",
      id: "cell",
      text: "Here is the next step.\n\n```cell\n" + cell + "\n```"
    }),
    ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
    ModelEvent.ModelEvent.Usage({ inputTokens: 8, outputTokens: 4 }),
    ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
  ]
})

/**
 * A recorded model frame whose text carries no cell at all.
 *
 * @category fixtures
 * @since 0.1.0
 */
export const prose = (text: string): ScriptedModel.Step => ({
  events: [
    ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "prose" }),
    ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "prose", text }),
    ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "prose" }),
    ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
  ]
})

/**
 * The opening window every controller suite starts from: the cell contract
 * and one user turn.
 *
 * @category fixtures
 * @since 0.1.0
 */
export const window = ContextWindow.make({
  modelId: "test-model",
  segments: [
    { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "cell contract" })] },
    { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("start")] }
  ]
})

/**
 * The opening window plus the task, where `Agent` puts it. The completion
 * brake reads the task, so a suite that needs a judged completion starts here.
 *
 * @category fixtures
 * @since 0.1.0
 */
export const tasked = ContextWindow.make({
  modelId: "test-model",
  segments: [
    { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "cell contract" })] },
    {
      kind: "instructions",
      zone: "prefix",
      content: [ModelRequest.SystemPart.make({ text: "The task for this run:\n\nKeep the query string." })]
    },
    { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("start")] }
  ]
})

/**
 * Parses a declared `action:verb:resource` capability into an envelope entry.
 *
 * @category fixtures
 * @since 0.1.0
 */
export const pattern = (declared: string): Capability.CapabilityPattern => {
  const parsed = declared.split(":")
  return new Capability.CapabilityPattern({
    action: `${parsed[0]}:${parsed[1]}` as Capability.PatternAction,
    resource: parsed.slice(2).join(":")
  })
}

/**
 * The events of one tag, narrowed to that event's type.
 *
 * @category fixtures
 * @since 0.1.0
 */
export const of = <T extends AgentEvent.AgentEvent["_tag"]>(
  events: ReadonlyArray<AgentEvent.AgentEvent>,
  tag: T
): ReadonlyArray<Extract<AgentEvent.AgentEvent, { readonly _tag: T }>> =>
  events.filter((event): event is Extract<AgentEvent.AgentEvent, { readonly _tag: T }> => event._tag === tag)

/**
 * What one scripted run of the controller is driven with.
 *
 * @category fixtures
 * @since 0.1.0
 */
export interface Options {
  readonly script: ScriptedModel.Script
  readonly state: CellTurn.State
  readonly calls?: ReadonlyArray<ScriptedEngine.CallStep> | undefined
  /** Omitted discloses one read-only `fs/list` flow. */
  readonly flows?: ReadonlyArray<Descriptor.FlowDescriptor> | undefined
  readonly limits?: Sandbox.Limits | undefined
  readonly steering?: Layer.Layer<Steering.Source> | undefined
  readonly clock?: Clock.Clock | undefined
  /**
   * The workspace the engine can measure, as one string. Omitted means the
   * host measures nothing, which is what every case written before observed
   * mutation existed expects.
   */
  readonly tree?: string | undefined
  /**
   * Whether the engine's walk covered the whole tree. False is the bounded
   * measurement a checkout larger than the host's path bound produces.
   */
  readonly treeComplete?: boolean | undefined
  /** Whether the host has anywhere to pin a checkpoint. Omitted pins. */
  readonly pins?: boolean | undefined
  /**
   * The history the controller records executed cells into. Omitted is the
   * host that offers no way to save a flow, which binds none.
   */
  readonly history?: CellHistory.Service | undefined
  /**
   * The transport the claim brake asks. The brake never falls back, so a
   * turn that reaches a completion without one fails as
   * `completion_unjudged`; omitted is therefore {@link confidentEvaluator},
   * the reading that lets a claim stand, which is what every case written
   * before that brake existed expects. A case about the failure binds
   * `Evaluator.layerUnavailable()` or a refusing script instead. See
   * `CompletionClaim`.
   */
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
  /**
   * What the host says a request resolves to on its way out. Omitted is the
   * host that rewrites nothing and names no route, which is what the scripted
   * engine is.
   */
  readonly resolve?: EngineLike.EngineLike["resolve"]
  /** The monitors the supervisor scores and the boundaries gate; omitted takes the defaults. */
  readonly monitors?: CellTurn.Input["monitors"]
  /** Whether the evaluator is a real judge, which delivers monitors and inserts; omitted is false. */
  readonly judged?: boolean | undefined
  /** The static stance the run journals; omitted is none. */
  readonly stance?: CellTurn.Input["stance"]
  /** Instruction files the run-start relevance reading judges; omitted is none. */
  readonly instructions?: CellTurn.Input["instructions"]
  /** Flow names the run-start relevance reading never judges; omitted pins none. */
  readonly pinned?: CellTurn.Input["pinned"]
  /** The shape a completion must fit; omitted accepts any. */
  readonly output?: CellTurn.Input["output"]
  /** The memory the supervisor recalls from; omitted binds none. */
  readonly memory?: Supervisor.Memory | undefined
  /** Observes every event before the controller advances; omitted observes nothing. */
  readonly observer?: ((event: AgentEvent.AgentEvent) => Effect.Effect<void>) | undefined
  /**
   * The journal of recorded boundaries, encoded and keyed by name, session,
   * frame and boundary. A boundary it holds is replayed and one it lacks is
   * executed and added; omitted executes every boundary.
   */
  readonly records?: Map<string, unknown> | undefined
}

const recordKey = (boundary: EngineLike.RecordBoundary<unknown>): string =>
  `${boundary.name}\u0000${
    boundary.identity.session ?? ""
  }\u0000${boundary.identity.frame}\u0000${boundary.identity.boundary}`

/**
 * `record` over a journal that replays what it holds and keeps what it
 * executes; every boundary is also listed in `seen`, replayed or not.
 */
const journaled = (
  records: Map<string, unknown>,
  seen: Array<EngineLike.RecordBoundary<unknown>>
): EngineLike.EngineLike["record"] =>
(boundary) => {
  seen.push(boundary)
  const held = records.get(recordKey(boundary))
  if (held !== undefined) {
    return Effect.fromResult(Schema.decodeUnknownResult(boundary.success)(held)).pipe(
      Effect.mapError((cause) =>
        new HarnessError({ code: "engine_failed", message: `Boundary ${boundary.name} did not decode`, cause })
      )
    )
  }
  const encode = Schema.encodeUnknownSync(
    boundary.success as unknown as Schema.Schema<unknown> & { readonly "EncodingServices": never }
  )
  return boundary.execute.pipe(
    Effect.tap((value) => Effect.sync(() => records.set(recordKey(boundary), encode(value))))
  )
}

/**
 * A Jev that reads every claim as done and modest, so the sixth brake lets
 * the completion stand and journals the reading it stood on.
 *
 * This is the fixture default because the brake fails a completion it could
 * not put to a model, and almost every case here is about something else.
 * A case about the brake itself scripts its own probabilities.
 *
 * @category fixtures
 * @since 0.1.0
 */
export const confidentEvaluator: Layer.Layer<Evaluator.Evaluator> = Evaluator.layerScripted(() => ({
  complete: { probability: 0.99 },
  overclaims: { probability: 0.01 },
  invented: { probability: 0.01 }
}))

/**
 * Everything one scripted run published, and the doubles it ran against.
 *
 * @category fixtures
 * @since 0.1.0
 */
export interface Run {
  readonly events: ReadonlyArray<AgentEvent.AgentEvent>
  readonly engine: ScriptedEngine.Fixture
  readonly model: ScriptedModel.Fixture
  /** The typed failure the run reported, when it reported one. */
  readonly failure: unknown
  /** Whether the run ended in interruption rather than a typed failure. */
  readonly interrupted: boolean
}

/**
 * Runs the controller against a recorded model and a scripted engine.
 *
 * Events are collected one by one, so a run that ends in a park, a budget
 * stop, or an abort is still observed through everything it published first.
 * The typed failure and the interruption are kept apart: a case that conflates
 * them cannot tell a cancelled run from a corrupted one.
 *
 * @category fixtures
 * @since 0.1.0
 */
export const run = async (options: Options): Promise<Run> => {
  const model = ScriptedModel.make(options.script)
  const engine = ScriptedEngine.make(
    model.model,
    options.calls ?? [],
    options.tree,
    options.treeComplete ?? true,
    options.pins ?? true
  )
  const events: Array<AgentEvent.AgentEvent> = []
  const outcome = await CellTurn.run({
    state: options.state,
    flows: options.flows ?? [descriptor("fs/list", { capabilities: ["fs:read:**"] })],
    limits: options.limits,
    monitors: options.monitors,
    judged: options.judged,
    stance: options.stance,
    instructions: options.instructions,
    pinned: options.pinned,
    output: options.output
  }).pipe(
    Stream.runForEach((event) => Effect.sync(() => events.push(event))),
    Effect.provide(
      options.resolve === undefined && options.records === undefined
        ? engine.layer
        : EngineLike.layer({
          ...engine.engine,
          ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
          ...(options.records === undefined ? {} : { record: journaled(options.records, engine.recorder.records) })
        })
    ),
    Effect.provide(QuickJSSandbox.layer),
    Effect.provide(options.steering ?? Steering.layerNoop()),
    (effect) => options.clock === undefined ? effect : Effect.provideService(effect, Clock.Clock, options.clock),
    (effect) =>
      options.history === undefined
        ? effect
        : Effect.provideService(effect, CellHistory.CellHistory, options.history),
    (effect) =>
      options.memory === undefined ? effect : Effect.provideService(effect, Supervisor.Memory, options.memory),
    (effect) =>
      options.observer === undefined ? effect : Effect.provideService(effect, AgentEvent.Observer, options.observer),
    Effect.provide(options.evaluator ?? confidentEvaluator),
    Effect.result,
    Effect.exit,
    Effect.runPromise
  )
  const settled = outcome._tag === "Success" ? outcome.value : undefined
  return {
    events,
    engine,
    model,
    failure: settled !== undefined && settled._tag === "Failure" ? settled.failure : undefined,
    interrupted: outcome._tag === "Failure"
  }
}
