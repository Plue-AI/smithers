/**
 * The Smithers agent.
 *
 * This module is the production composition of the durable cell loop, and it is
 * the one the whole package is named for. Everything the loop needs already
 * existed as a separate piece — the controller in `@smthrs/harness/CellTurn`,
 * registry-backed call resolution in `@smthrs/harness/CellCalls`, the sandbox in
 * `@smthrs/harness/QuickJSSandbox`, the durable engine port in
 * `./FlowEngineLike.ts` — and what did not exist was one place that wires them
 * together. This is that place.
 *
 * One agent, one implementation, two ways to run it. {@link module:AgentSession}
 * runs it as a whole control-plane run: the launch is a durable flow execution,
 * the events go to the journal, an operator steers and approves it.
 * {@link module:AgentAction} runs it as one typed step inside a larger flow:
 * the same loop, bounded by a declared output schema, replayed like any other
 * action. Neither adapter reimplements the loop, and a future agent that drives
 * a foreign CLI is another implementation of {@link Service} rather than a
 * second loop next to this one.
 *
 * What {@link Service.run} returns is the framework-neutral
 * `Stream<AgentEvent>` the controller emits — no callbacks, no event emitter, no
 * host-shaped result type. A caller renders it, journals it, or ignores it.
 *
 * Composition boundaries are deliberate:
 *
 * - The stream's requirements are `FlowEngine` and `FlowInstance` (a run must be
 *   started inside a running flow body, because the port is per-execution) plus
 *   `Sandbox` and `Steering.Source`, which the host supplies.
 *   {@link layerDefaults} provides browser-safe defaults for the latter two.
 * - Nothing here imports a Node built-in or a platform layer. The QuickJS
 *   sandbox is the browser single-file build, so this composition is the same
 *   in both environments; only the engine's storage layer differs.
 * - The catalog shown to the model is `registry.visible()` narrowed to
 *   model-invocable flows, and the *same* registry answers the calls, so the
 *   declaration digest a cell was written against is the one checked at the
 *   boundary.
 *
 * @since 0.1.0
 */
import * as Capability from "@smthrs/capability/Capability"
import * as Digest from "@smthrs/core/Digest"
import { Action, DurableClock, FlowRuntime } from "@smthrs/flow"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import type * as Cell from "@smthrs/harness/Cell"
import * as CellCalls from "@smthrs/harness/CellCalls"
import * as CellTurn from "@smthrs/harness/CellTurn"
import * as ContextWindow from "@smthrs/harness/ContextWindow"
import * as EngineLike from "@smthrs/harness/EngineLike"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Monitor from "@smthrs/harness/Monitor"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import * as Steering from "@smthrs/harness/Steering"
import * as Supervisor from "@smthrs/harness/Supervisor"
import * as Redaction from "@smthrs/journal/Redaction"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import * as Bank from "@smthrs/memory/Bank"
import * as MemoryError from "@smthrs/memory/MemoryError"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as MemorySource from "@smthrs/memory/Source"
import type * as Evaluator from "@smthrs/model/Evaluator"
import type * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as ObservabilityMetric from "@smthrs/observability/Metric"
import type { FlowsHooks, PluginInput } from "@smthrs/plugin"
import type { FlowsConfig, ResolvedConfig } from "@smthrs/plugin/Config"
import type { PluginError } from "@smthrs/plugin/PluginError"
import type * as Plugins from "@smthrs/plugin/Plugins"
import type * as Descriptor from "@smthrs/registry/Descriptor"
import type * as Registry from "@smthrs/registry/Registry"
import * as Checkpoints from "@smthrs/std/Checkpoints"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import type * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import type * as Budget from "./Budget.ts"
import * as CellPlugin from "./CellPlugin.ts"
import * as Checkpointed from "./Checkpointed.ts"
import * as FlowEngineLike from "./FlowEngineLike.ts"
import * as QuotaPolicy from "./QuotaPolicy.ts"
import type * as Seat from "./Seat.ts"
import * as StandardFlows from "./StandardFlows.ts"

/**
 * Everything one assembled cell run declares.
 *
 * The required half is the run itself — who is running, on what seat, against
 * which registry and model. The optional half is authority and budget, and every
 * default is the conservative one: no capabilities, no placement, no
 * compaction, and a host that implements nothing until it says so.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** The durable session or lineage every call identity is scoped to. */
  readonly session: string
  /** Overrides the bounded transport retry schedule at the model boundary. */
  readonly modelRetryPolicy?: Schedule.Schedule<unknown, Model.ModelFailure> | undefined
  /**
   * The resolved seat this run streams from.
   *
   * A `SeatResolver` produced it, so the model, the route, and the context
   * window arrive together and the composition never parses a seat string or
   * holds a credential of its own.
   */
  readonly seat: Seat.Seat
  /** Resolved seats attempted in order after `seat` on a capacity refusal. */
  readonly fallbackSeats?: ReadonlyArray<Seat.Seat>
  /**
   * Capacity policy for this run; parking is enabled by default.
   *
   * `maxParks` bounds the parks one run takes, `QuotaPolicy.defaultMaxParks`
   * when absent, as for a flow `Agent.action`. The refusal that finds the
   * budget spent fails the run with the provider's typed `ModelError`.
   */
  readonly capacity?:
    | { readonly park: boolean; readonly maxParkMillis?: number; readonly maxParks?: number }
    | undefined
  /** Resolves context budgets after a steer, using the host seat vocabulary. */
  readonly contextWindowTokensFor?: CellTurn.Input["contextWindowTokensFor"]
  /** The task the run was admitted with. */
  readonly prompt: string
  /** Stable system teaching placed ahead of the cell contract. */
  readonly system?: ReadonlyArray<string> | undefined
  readonly registry: Registry.Registry
  /** Shared-kernel plugins resolved for the harness target. */
  readonly plugins?: PluginInput<FlowsHooks> | undefined
  /** Raw config threaded through the plugin kernel's config waterfall. */
  readonly config?: FlowsConfig | undefined
  /**
   * One explicitly selected memory snapshot.
   *
   * The host obtains this value from `memory/Source.declared`, which reads
   * `Source.readRows` and freezes the rows with the snapshot recorder;
   * omitting it injects no memory. The opening context renders every row
   * with `Source.render`, and when {@link judged} the run-start relevance
   * reading judges each row beside the catalog and the instructions. The
   * composition never reads a memory store or worldview on its own.
   */
  readonly memory?: MemorySource.Declared | undefined
  /**
   * Ordered executable-flow sources composed into the run's catalog.
   *
   * This is how a capability becomes reachable from a cell: standard
   * filesystem and shell flows, memory flows, a durable wait, an incoming MCP
   * server, a child agent — each is a `FlowBinding.Source`, and each ends up as
   * one more entry in `ctx.flows` invoked with `ctx.call`. Plugin `cellFlows`
   * handlers run after these, in resolution order.
   */
  readonly flows?: ReadonlyArray<FlowBinding.Source> | undefined
  /** Host implementations for module-backed flows, keyed by flow name. */
  readonly implementations?: ReadonlyMap<string, CellCalls.Implementation> | undefined
  /** Runs a rendered markdown flow. A host with none refuses them catchably. */
  readonly promptRunner?: CellCalls.PromptRunner | undefined
  /**
   * Decides whether a call may proceed, before its durable boundary opens.
   *
   * Kept outside the activity on purpose: a permission requirement raised
   * inside one would be journaled and replayed forever, and no later grant
   * could unblock it.
   */
  readonly authorize?: ((call: Cell.Call) => Effect.Effect<void, HarnessError>) | undefined
  readonly modelParams?: ModelRequest.GenerationParams | undefined
  readonly layers?: ReadonlyArray<string> | undefined
  readonly capabilityEnvelope?: ReadonlyArray<Capability.CapabilityPattern> | undefined
  readonly placement?: Option.Option<Descriptor.Placement> | undefined
  readonly maxFrames?: number | undefined
  /**
   * Caps consecutive read-only frames; see `CellTurn.make`.
   *
   * Armed for task runs only: a task run's frames are supposed to change
   * something, and a run that only reads is the failure mode a flat frame
   * budget cannot see. A run that is meant to answer rather than act leaves it
   * unset.
   *
   * @since 1.0.0-rc.0
   */
  readonly readOnlyCap?: number | undefined
  /**
   * Caps the wall-clock one model call may spend, in milliseconds; see
   * `CellTurn.defaultModelCallMs` for the default and the evidence behind it.
   *
   * Armed by default, unlike `readOnlyCap`, because it bounds a failure that
   * has nothing to do with what the run is for: a call that answers slowly
   * enough to eat the run's whole wall clock costs a conversational run
   * exactly what it costs a task run. Zero disarms it.
   */
  readonly modelCallMs?: number | undefined
  /**
   * Caps consecutive repeat-observation frames; see
   * `CellTurn.defaultRepeatFrames` for the default and the evidence behind it.
   *
   * Armed by default like `modelCallMs`, and exposed here for the same reason
   * `readOnlyCap` is: the demand it issues names a code task's evidence — the
   * failing check, the history of the symbol, the callers — so a run whose
   * repetition is not a stall passes zero and takes it off. Whatever this says
   * is what `discipline-armed` journals, so a grader reads the host's choice
   * and not a constant.
   */
  readonly repeatCap?: number | undefined
  /**
   * Caps how many completions may be bounced for narrowed evidence; see
   * `CellTurn.defaultNarrowingDemands` for the default and the run it was read
   * off.
   *
   * Armed by default like `repeatCap`. The demand costs a run that verified
   * properly nothing at all — it is computed from calls the run already made
   * and fires only where the tree moved under a check that was never repeated
   * — so the only caller with a reason to pass zero is one whose completions
   * are not evidence claims at all.
   */
  readonly narrowingCap?: number | undefined
  /**
   * Caps how many completions may be bounced for an unmoved tree; see
   * `CellTurn.defaultUnmovedDemands` for the default and the run it was read
   * off.
   *
   * Armed by default. A run that changed something never reaches it, and a run
   * whose task genuinely needs no change answers it in one sentence, so the
   * only caller with a reason to pass zero is one whose completions are not
   * claims about a workspace at all — a question, a review, a summary.
   */
  readonly unmovedCap?: number | undefined
  /**
   * Caps how many completions may be bounced for a failing check the run
   * replaced rather than answered; see `CellTurn.defaultUnresolvedDemands`.
   *
   * Armed by default, and computed entirely from calls the run already made:
   * it fires only where a check reported a failing exit status over the tree
   * being completed on and a later call went back to the same subject with a
   * different command.
   */
  readonly unresolvedCap?: number | undefined
  /**
   * Caps how many completions may be bounced for a claim the run's record does
   * not support; see `CellTurn.make`. Armed by default; zero disarms the one
   * brake that asks the `Evaluator`, which is what an interactive host whose
   * human reads every answer passes when it binds no judge.
   */
  readonly claimCap?: number | undefined
  /**
   * Provider-run tools every model call of this run may use, such as the
   * provider's own web search; see `CellTurn.make`. Omitted declares none.
   */
  readonly serverTools?: ReadonlyArray<ModelRequest.ServerTool> | undefined
  /**
   * Whether a human can answer this run; see `CellTurn.make`.
   *
   * The default is false, because the default run is unattended. Only a caller
   * that has somewhere for an answer to come from — an operator on the other
   * end of `smithers approve`, an interactive session — may claim true, and a
   * caller that claims it wrongly buys a run that waits forever.
   */
  readonly approvalChannel?: boolean | undefined
  readonly limits?: Sandbox.Limits | undefined
  /**
   * What the supervisor may do with its readings; see `Supervisor`.
   *
   * Verdicts are journaled whenever an `Evaluator` is bound, whatever this
   * says; {@link judged} arms nudges and memory insertion. `remember` writes
   * accepted sentences to the bound memory store, redacted the way the
   * journal redacts; it is off unless the host opts in, and a host with no
   * store bound writes nothing. `namespace` is the memory bank read from and
   * written to, one per project or repository. With no namespace the
   * supervisor reads and writes no memory at all: there is no global bank a
   * run of one repository could share with another's. `monitors` follow
   * `Monitor.defaults()` into the `cellMonitors` plugin hook. `stance` is the
   * static stance a {@link judged} run is taught, `careful` when omitted; an
   * unjudged run is taught none.
   */
  readonly supervisor?: {
    readonly remember?: boolean | undefined
    readonly banks?: ReadonlyArray<string> | undefined
    readonly monitors?: ReadonlyArray<Monitor.Monitor> | undefined
    readonly stance?: "careful" | "paranoid" | undefined
  } | undefined
  /**
   * Whether the host's `Evaluator` is a real judge, which arms Jev's features
   * on this run; see `CellTurn.Input.judged`. Omitted is false.
   */
  readonly judged?: boolean | undefined
  /**
   * Human-provided instruction files, such as a repository's `AGENTS.md`.
   * They are shown after `system`; a judged run drops the chunks Jev is
   * confident the task does not need. See `CellTurn.Input.instructions`.
   *
   * @since 1.0.0-rc.0
   */
  readonly instructions?: ReadonlyArray<{ readonly path: string; readonly text: string }> | undefined
  /**
   * Names of `flows` sources whose flows a judged run never withholds, beside
   * `StandardFlows.coreSources`.
   *
   * @since 1.0.0-rc.0
   */
  readonly pinnedSources?: ReadonlyArray<string> | undefined
}

/**
 * What a memory fault says on the journal: the store's code and message for a
 * typed `MemoryError`, a fixed sentence for anything else.
 */
const memoryDetail = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  return error instanceof MemoryError.MemoryError
    ? `${error.code}: ${error.message}`
    : "The memory store failed unexpectedly"
}

/**
 * The supervisor's memory port over whatever memory the host bound.
 *
 * Optional on both sides: a composition with no `MemoryStore`, or a run with
 * no namespace, recalls nothing and writes nothing, and says so through
 * `bound`. A store or recall that fails is logged and fails typed, and the
 * supervisor journals it and carries on: it runs off the loop's hot path, and
 * a memory fault must not become a run fault.
 *
 * A written sentence passes the journal's secret redaction first. It came
 * from the model's prose, which can quote a key it read, and memory outlives
 * the run that wrote it.
 */
const supervisorMemory = (options: Options): Effect.Effect<Supervisor.Memory> =>
  Effect.gen(function*() {
    const store = yield* Effect.serviceOption(MemoryStore.MemoryStore)
    const recall = yield* Effect.serviceOption(Recall.Recall)
    const declared = options.supervisor?.banks ?? []
    const ambient = yield* CapabilitySet.current
    const ceiling = options.capabilityEnvelope === undefined
      ? ambient
      : CapabilitySet.intersect(ambient, CapabilitySet.fromPatterns(options.capabilityEnvelope))
    const explicit = (options.capabilityEnvelope ?? []).filter((pattern) =>
      pattern.action.startsWith("memory:") && !/[?*]/.test(pattern.resource)
    ).map((pattern) => pattern.resource)
    const candidates = [...new Set([...declared, ...explicit])]
    const banks = candidates.filter((bank) => CapabilitySet.allows(ceiling, Capability.make("memory:read", bank)))
    const writeBank = candidates.find((bank) => CapabilitySet.allows(ceiling, Capability.make("memory:write", bank)))
    if (Option.isNone(store) || (banks.length === 0 && writeBank === undefined)) return Supervisor.memoryNone
    return {
      bound: true,
      recall: (query, limit) =>
        Option.isNone(recall) ? Effect.succeed([]) : recall.value.recall({
          banks,
          query,
          maxTokens: limit * 256
        }).pipe(
          Effect.map((rows) => rows.slice(0, limit).map((row) => ({ key: row.key, text: row.text }))),
          Effect.catchCause((cause) =>
            Effect.andThen(
              Effect.logWarning("The supervisor could not recall memory", cause),
              Effect.fail({ detail: memoryDetail(cause) })
            )
          )
        ),
      remember: (text) => {
        if (writeBank === undefined) return Effect.void
        const redacted = String(Redaction.redact(text))
        return Bank.parse(writeBank).pipe(Effect.flatMap((namespace) =>
          store.value.putNote({
            namespace,
            id: Digest.digest(`${writeBank}\0${redacted}`),
            text: redacted,
            tags: ["source:supervisor"],
            provenance: { runId: options.session },
            status: "accepted"
          })
        )).pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.andThen(
              Effect.logWarning("The supervisor could not write memory", cause),
              Effect.fail({ detail: memoryDetail(cause) })
            )
          )
        )
      }
    }
  })

/**
 * The static stance a run is taught: the chosen one, `careful` by default,
 * and only when judged.
 */
const stanceOf = (options: Options): "careful" | "paranoid" | undefined =>
  options.judged === true ? options.supervisor?.stance ?? "careful" : undefined

/**
 * The opening memory the run-start relevance reading judges. The rows it is
 * handed back are rows of `declared`, so they render as the host's rows.
 */
const openingMemory = (declared: MemorySource.Declared): CellTurn.Memory => ({
  rows: declared.rows,
  digest: declared.digest,
  render: (kept) => MemorySource.render(declared.rows.filter((row) => kept.includes(row)))
})

/**
 * Assembles the initial context window for a run.
 *
 * The cell contract and the callable-flow catalog are added by
 * `CellTurn.teach`, which puts both in prefix segments — so they survive every
 * transition and a cell never has to re-project its own teaching.
 */
const opening = (
  options: Options,
  flows: ReadonlyArray<Descriptor.FlowDescriptor>,
  pinned: boolean
): ContextWindow.ContextWindow => {
  // A host fact rather than a contract edit: the contract is measured and
  // shared by every host, while only a host with no store refuses `at`.
  const declared: Array<ContextWindow.SegmentInput> = [
    ...(options.system ?? []),
    ...(pinned ? [] : [Checkpointed.unpinnedFact])
  ].map((text) => ({
    kind: "system",
    zone: "prefix",
    content: [ModelRequest.SystemPart.make({ text })]
  }))
  if (options.instructions !== undefined && options.instructions.length > 0) {
    declared.push(CellTurn.instructionsSegment(options.instructions, new Set()))
  }
  const memory = MemorySource.render(options.memory?.rows ?? [])
  if (options.memory !== undefined && memory.length > 0) {
    declared.push(CellTurn.memorySegment(memory, options.memory.digest))
  }
  return CellTurn.teach(
    ContextWindow.make({
      modelId: options.seat.modelId,
      segments: [
        ...declared,
        // The task itself is a PREFIX segment, so it survives compaction: a
        // benchmark run made the intended fix, forgot the environment teaching
        // that lived only in the opening prompt, and parked asking a human for
        // what the prompt had told it.
        {
          kind: "instructions",
          zone: "prefix",
          content: [ModelRequest.SystemPart.make({ text: `The task for this run:\n\n${options.prompt}` })]
        },
        {
          kind: "transcript",
          zone: "tail",
          content: [
            ModelRequest.Message.user(
              "Begin. Your task and environment are in the system context above and remain visible every frame."
            )
          ]
        }
      ]
    }),
    flows,
    undefined,
    stanceOf(options)
  )
}

/**
 * Resolves order-sensitive host composition material for durable keys.
 *
 * @category identity
 * @since 0.1.0
 */
const compositionLayers = (
  options: Options,
  plugins: Plugins.Service<FlowsHooks>,
  config: ResolvedConfig
): Effect.Effect<ReadonlyArray<string>, PluginError> =>
  CellPlugin.identity(options.layers ?? [], plugins, config).pipe(
    Effect.map((identity) => [...(options.layers ?? []), identity])
  )

const withRequestPlugins = (
  engine: EngineLike.EngineLike,
  plugins: Plugins.Service<FlowsHooks>
): EngineLike.EngineLike => {
  // The controller asks what a request resolves to and then seals that same
  // request, so the waterfall's answer is kept between the two by the request
  // object it answered. A plugin that counts, meters or logs therefore still
  // sees one call per model call, which is what it saw before the controller
  // asked anything. Weak, so a request the controller drops takes its entry
  // with it.
  //
  // What is kept is the waterfall's exit, its failure included. A hook is an
  // effect and nothing makes it answer the same way twice: one that failed the
  // first ask and succeeded the second would send a provider a request whose
  // record was written from the failure. Holding the failure means the sealed
  // step reports the failure that was met, and no plugin runs a second time
  // to produce it. An interruption is never held: an interrupted fiber does
  // not run the continuation that holds the exit, and a hook that interrupts
  // itself reaches here as the waterfall's typed `hook_failed`.
  const rewritten = new WeakMap<ModelRequest.ModelRequest, Exit.Exit<ModelRequest.ModelRequest, PluginError>>()
  const rewrite = (request: ModelRequest.ModelRequest): Effect.Effect<ModelRequest.ModelRequest, PluginError> =>
    Effect.suspend(() => {
      const held = rewritten.get(request)
      return held !== undefined
        ? held
        : Effect.exit(CellPlugin.modelRequest(plugins, request)).pipe(
          Effect.tap((exit) => Effect.sync(() => rewritten.set(request, exit))),
          Effect.flatten
        )
    })
  return EngineLike.make({
    sealStep: engine.sealStep,
    sealStepWithEvents: (
      step: EngineLike.SealedModelStep,
      emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
    ) =>
      Stream.unwrap(
        rewrite(step.request).pipe(
          Effect.mapError((cause) =>
            new HarnessError({
              code: "engine_failed",
              message: "A cell model-request plugin failed",
              cause
            })
          ),
          Effect.map((request) =>
            engine.sealStepWithEvents!({
              request,
              keyMaterial: { ...step.keyMaterial, body: { _tag: "ModelCall", request } },
              modelCallMs: step.modelCallMs
            }, emit)
          )
        )
      ),
    splice: engine.splice,
    call: engine.call,
    ...(engine.admit === undefined ? {} : { admit: engine.admit }),
    record: engine.record,
    observe: engine.observe,
    capture: engine.capture,
    // The request the provider is sent is the one the waterfall hands on, so
    // that is the one the record of the call has to hold. A waterfall that
    // fails has no request to hand on, so it resolves to none and the call
    // leaves no record: the event-aware seal reads the failure held above and reports
    // it, without asking the waterfall again.
    resolve: (request) =>
      rewrite(request).pipe(
        Effect.flatMap((next) => EngineLike.resolve(engine, next)),
        Effect.orElseSucceed(() => Option.none<EngineLike.Resolved>())
      ),
    suspend: engine.suspend
  })
}

/** Keeps one frame on available seats, parking only when every route is cooling. */
const withCapacity = (
  seats: ReadonlyArray<{ readonly seat: Seat.Seat; readonly engine: EngineLike.EngineLike }>,
  capacity: Options["capacity"],
  services: Context.Context<FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance | Crypto.Crypto>
): EngineLike.EngineLike => {
  const primary = seats[0]!.engine
  const cooling = new Map<string, QuotaPolicy.Park>()
  const policy = QuotaPolicy.makeDefault({ defaultWaitMillis: 15 * 60_000, maxWaitMillis: Infinity })
  const maxParks = capacity?.maxParks ?? QuotaPolicy.defaultMaxParks
  let parkCount = 0
  const sealStepWithEvents = (
    step: EngineLike.SealedModelStep,
    emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
  ): Stream.Stream<ModelEvent.ModelEvent, Model.ModelFailure | HarnessError> => {
    let lastError: Model.ModelFailure | HarnessError | undefined
    let previous = -1
    let cycle = 0
    const tried = new Set<number>()
    const attempt = (): Stream.Stream<ModelEvent.ModelEvent, Model.ModelFailure | HarnessError> =>
      Stream.unwrap(
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const entries = yield* Effect.forEach(seats, ({ seat, engine }) => {
            const request = ModelRequest.ModelRequest.make({ ...step.request, modelId: seat.modelId })
            return EngineLike.resolve(engine, request).pipe(Effect.map((resolved) => ({
              seat,
              engine,
              request,
              key: Option.isSome(resolved) && Option.isSome(resolved.value.binding)
                ? resolved.value.binding.value.routeId
                : seat.id
            })))
          })
          const selected = entries.findIndex((entry, index) =>
            !tried.has(index) && (cooling.get(entry.key)?.wakeAt ?? 0) <= now
          )
          if (selected < 0) {
            const availableParks = entries.flatMap((entry) => {
              const park = cooling.get(entry.key)
              return park === undefined ? [] : [{ entry, park }]
            })
            // Overflow and provider failures try each configured seat once;
            // they do not invent a quota reset or enter a timed park.
            if (availableParks.length !== entries.length) return Stream.fail(lastError!)
            const earliest = availableParks.sort((a, b) => a.park.wakeAt - b.park.wakeAt)[0]!
            if (
              capacity?.park === false ||
              parkCount >= maxParks ||
              (capacity?.maxParkMillis !== undefined && earliest.park.wakeAt - now > capacity.maxParkMillis)
            ) {
              return Stream.fail(lastError!)
            }
            const source = earliest.park.source === "text" ? "default" : earliest.park.source
            const code = Option.getOrUndefined(QuotaPolicy.modelErrorOf(lastError))!.code
            const parkName = `agent/capacity/${seats[0]!.seat.id}/${earliest.park.wakeAt}/${parkCount++}`
            yield* Action.make({
              name: `${parkName}/parked`,
              tier: "sealed",
              execute: emit(
                new AgentEvent.ModelParked({
                  eventType: AgentEvent.eventType.modelParked,
                  seat: earliest.entry.seat.id,
                  wakeAt: earliest.park.wakeAt,
                  source,
                  code
                })
              )
            })
            if (earliest.park.wakeAt > now) {
              yield* FlowRuntime.annotateWaiting({ reason: "quota", wakeAt: earliest.park.wakeAt })
            }
            yield* DurableClock.sleep({
              name: parkName,
              duration: Duration.millis(Math.max(0, earliest.park.wakeAt - now)),
              inMemoryThreshold: 1
            })
            yield* emit(
              new AgentEvent.ModelUnparked({
                eventType: AgentEvent.eventType.modelUnparked,
                seat: earliest.entry.seat.id,
                at: yield* Clock.currentTimeMillis
              })
            )
            cycle++
            tried.clear()
            cooling.clear()
            lastError = undefined
            previous = -1
            return attempt()
          }
          const entry = entries[selected]!
          if (previous >= 0 && previous !== selected && lastError !== undefined) {
            const model = Option.getOrUndefined(QuotaPolicy.modelErrorOf(lastError))!
            yield* emit(
              new AgentEvent.SeatFailedOver({
                eventType: AgentEvent.eventType.seatFailedOver,
                from: entries[previous]!.seat.id,
                to: entry.seat.id,
                code: model.code,
                resetAtEpochMillis: model.resetAtEpochMillis
              })
            )
          }
          const changed = {
            ...step,
            request: entry.request,
            keyMaterial: {
              ...step.keyMaterial,
              body: { _tag: "ModelCall", request: entry.request },
              layers: cycle === 0 ? step.keyMaterial.layers : [
                ...step.keyMaterial.layers,
                `capacity-cycle:${cycle}`
              ]
            }
          }
          return entry.engine.sealStepWithEvents!(changed, emit).pipe(
            Stream.catchCause((cause) =>
              Stream.unwrap(Effect.gen(function*() {
                const error = Cause.squash(cause)
                const model = Option.getOrUndefined(QuotaPolicy.modelErrorOf(error))
                const afterCall = yield* Clock.currentTimeMillis
                const classified = model === undefined
                  ? Option.none<QuotaPolicy.Park>()
                  : policy.classify(model, afterCall)
                const canFailOver = model !== undefined && seats.length > 1 &&
                  (model.code === "context_overflow" ||
                    (model.httpStatus !== undefined && model.httpStatus >= 500 && model.httpStatus <= 599))
                if (Option.isNone(classified) && !canFailOver) return Stream.failCause(cause)
                if (Option.isSome(classified)) {
                  const park = yield* Action.make({
                    name: `agent/capacity/${seats[0]!.seat.id}/cool/${cycle}/${selected}/${tried.size}`,
                    tier: "sealed",
                    success: QuotaPolicy.Park,
                    execute: Effect.succeed({
                      ...classified.value,
                      wakeAt: cycle > 0 && classified.value.wakeAt <= afterCall
                        ? afterCall + 15 * 60_000
                        : classified.value.wakeAt
                    })
                  })
                  cooling.set(entry.key, park)
                }
                lastError = error as Model.ModelFailure | HarnessError
                tried.add(selected)
                previous = selected
                return Stream.concat(
                  Stream.make(
                    ModelEvent.ModelEvent.Retry({
                      type: "retry",
                      attempt: tried.size,
                      code: model!.code,
                      delayMillis: 0
                    })
                  ),
                  attempt()
                )
              }))
            ),
            Stream.provideContext(services)
          )
        }).pipe(Effect.provideContext(services))
      )
    return attempt()
  }
  return EngineLike.make({
    ...primary,
    sealStepWithEvents
  })
}

/**
 * The agent: one method that runs one whole agent loop.
 *
 * A run must be started from inside a running flow body. The engine port is
 * built per execution, which is what makes `suspend` a real durable park rather
 * than a failure, and it is why `FlowInstance` is in the stream's requirements
 * rather than in the service's construction.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  readonly run: (
    options: Options
  ) => Stream.Stream<
    AgentEvent.AgentEvent,
    HarnessError | PluginError,
    | FlowRuntime.FlowRuntime
    | FlowRuntime.FlowInstance
    | Sandbox.Sandbox
    | Steering.Source
    | Budget.Budget
    | QuotaPolicy.QuotaClassifier
    // The completion brake never falls back: a claim nothing could judge
    // fails the run. So every host that runs a loop binds a transport, and
    // one without a gateway key or an explicit scripted judge refuses startup. See `@smthrs/harness`'s
    // `CompletionClaim`.
    | Evaluator.Evaluator
  >
}

/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 0.1.0
 */
export class Agent extends Context.Service<Agent, Service>()("@smthrs/agent/Agent") {}

const runProductionUnmeasured: Service["run"] = (options) =>
  Stream.unwrap(
    Effect.gen(function*() {
      const kernel = yield* CellPlugin.make(options.plugins, options.config)
      yield* Effect.forEach(
        kernel.observerErrors,
        (error) =>
          Effect.annotateLogs(Effect.logWarning("A plugin configuration observer failed"), {
            pluginErrorCode: error.code,
            pluginName: error.plugin,
            pluginHook: error.hook
          }),
        { discard: true }
      )
      const layers = yield* compositionLayers(options, kernel.plugins, kernel.config)
      return Stream.unwrap(
        Effect.gen(function*() {
          const discovered = yield* CellPlugin.registry(kernel.plugins, options.registry)
          // Each source is resolved once: its bindings are both the catalog
          // and, for a pinned source, the names the relevance reading skips.
          const sources = yield* Effect.forEach(
            options.flows ?? [],
            (source) => Effect.map(source.bindings(), (bindings) => ({ name: source.name, bindings }))
          )
          const composed = yield* Effect.fromResult(
            FlowBinding.catalogResult(sources.flatMap((source) => source.bindings))
          )
          const pinnedSources = new Set([...StandardFlows.coreSources, ...(options.pinnedSources ?? [])])
          const pinned = sources.filter((source) => pinnedSources.has(source.name))
            .flatMap((source) => source.bindings.map((binding) => binding.descriptor.name))
          const contributed = yield* CellPlugin.flows(kernel.plugins, composed.entries)
          const catalog = yield* Effect.fromResult(FlowBinding.catalogResult(contributed))
          const monitors = yield* CellPlugin.monitors(kernel.plugins, [
            ...Monitor.defaults(),
            ...(options.supervisor?.monitors ?? [])
          ]).pipe(
            Effect.flatMap(Monitor.validate),
            Effect.catchTag(
              "@smthrs/harness/Monitor/InvalidMonitor",
              (cause) => Effect.fail(new HarnessError({ code: "assembly_failed", message: cause.message, cause }))
            )
          )
          // The controller journals a fresh visible snapshot at each frame.
          // Call resolution still verifies the declaration digest against this
          // registry before executing, so a mid-frame change is refused.
          const registry = FlowBinding.registry(discovered, catalog)
          const resolver = CellCalls.make({
            registry,
            catalog,
            implementations: options.implementations,
            prompt: options.promptRunner
          })
          // This composition is the one place that knows the run's whole
          // authority, so it is the one place that may declare it (issue #75).
          // The envelope is exactly what `CellTurn` runs under, and the
          // default really is "nothing granted" — so an empty envelope is a
          // true complete claim, not an unknown one, and sealed boundaries
          // stay shareable across runs of one composition while two
          // differently-authorized compositions can never alias.
          const envelope = (options.capabilityEnvelope ?? []).map(Capability.format)
          // A call that names a checkpoint runs in a scratch checkout of that
          // tree; one that names none runs exactly as it always has. The
          // decorator is applied here rather than inside the resolver because a
          // composition with nowhere to pin a tree must not be wrapped at all:
          // then `at` is refused by the engine port's own `capture`, which is
          // the one place that knows the host has no store.
          const calls = yield* Checkpointed.decorate({
            ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
            run: resolver.run
          })
          const makePort = (seat: Seat.Seat) =>
            FlowEngineLike.make({
              model: seat.model,
              route: seat.route,
              calls,
              layers,
              capabilities: { envelope },
              modelRetryPolicy: options.modelRetryPolicy
            })
          const seats = [options.seat, ...(options.fallbackSeats ?? [])]
          const ports = yield* Effect.forEach(
            seats,
            (seat) => Effect.map(makePort(seat), (engine) => ({ seat, engine }))
          )
          const capacityServices = yield* Effect.context<
            FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance | Crypto.Crypto
          >()
          const port = options.capacity?.park === false && ports.length === 1
            ? ports[0]!.engine
            : withCapacity(ports, options.capacity, capacityServices)
          const state = CellTurn.make({
            session: options.session,
            seat: options.seat.id,
            modelParams: options.modelParams ?? ModelRequest.GenerationParams.make(),
            layers,
            capabilityEnvelope: options.capabilityEnvelope ?? [],
            placement: options.placement ?? Option.none(),
            contextWindow: opening(options, [], Option.isSome(yield* Effect.serviceOption(Checkpoints.Checkpoints))),
            contextWindowTokens: options.seat.contextWindowTokens,
            maxFrames: options.maxFrames,
            readOnlyCap: options.readOnlyCap,
            modelCallMs: options.modelCallMs,
            repeatCap: options.repeatCap,
            narrowingCap: options.narrowingCap,
            unmovedCap: options.unmovedCap,
            unresolvedCap: options.unresolvedCap,
            claimCap: options.claimCap,
            approvalChannel: options.approvalChannel,
            serverTools: options.serverTools
          })
          const memory = yield* supervisorMemory(options)
          return CellTurn.run({
            state,
            flows: [],
            refreshFlows: Effect.suspend(() => registry.visible()).pipe(
              Effect.map((visible) => visible.filter((descriptor) => descriptor.modelInvocable))
            ),
            limits: options.limits,
            contextWindowTokensFor: options.contextWindowTokensFor,
            supervisor: { remember: options.supervisor?.remember ?? false },
            judged: options.judged,
            stance: stanceOf(options),
            instructions: options.instructions,
            pinned,
            monitors,
            ...(options.memory === undefined ? {} : { memory: openingMemory(options.memory) })
          }).pipe(
            Stream.provideService(EngineLike.EngineLike, withRequestPlugins(port, kernel.plugins)),
            Stream.provideService(Supervisor.Memory, memory)
          )
        })
      ).pipe(
        Stream.provide(kernel.layer)
      )
    })
  )

const runProduction: Service["run"] = (options) =>
  Stream.scoped(
    Stream.unwrap(
      Effect.acquireRelease(
        Metric.modify(ObservabilityMetric.activeSeats, 1),
        () => Metric.modify(ObservabilityMetric.activeSeats, -1)
      ).pipe(Effect.as(runProductionUnmeasured(options)))
    )
  )

/**
 * Builds a {@link Service} from an implementation of its one method.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => Agent.of(implementation)

/**
 * A {@link Service} that emits nothing and runs no model.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    run: () => Stream.empty,
    ...overrides
  })

/**
 * Provides the production agent.
 *
 * The policy services are requirements of the layer so a composition cannot
 * erase them before {@link Service.run} reaches the model boundary.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<
  Agent,
  never,
  QuotaPolicy.QuotaClassifier | Budget.Budget
> = Layer.succeed(Agent)(make({ run: runProduction }))

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<Agent> =>
  Layer.succeed(Agent)(makeNoop(overrides))

/**
 * The browser-safe defaults for the two services a run leaves to the host.
 *
 * The sandbox is the QuickJS single-file build, which runs unchanged in Node and
 * in a browser. Steering defaults to an empty source: a host that accepts
 * mid-run messages provides its own `Steering.layer` instead, and the loop
 * drains it at exactly the same boundaries either way.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerDefaults: Layer.Layer<Sandbox.Sandbox | Steering.Source, Sandbox.SandboxError> = Layer.merge(
  QuickJSSandbox.layer,
  Steering.layerNoop()
)

/**
 * {@link layerDefaults} over the QuickJS build the host names.
 *
 * The steering default is unchanged; only the sandbox differs. A host whose
 * runtime refuses to compile WebAssembly from bytes, such as Cloudflare's
 * workerd, provides `QuickJSSandbox.layerVariant(variant)` beneath this and
 * builds that variant from a `.wasm` module import.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerDefaultsWithVariant: Layer.Layer<
  Sandbox.Sandbox | Steering.Source,
  Sandbox.SandboxError,
  QuickJSSandbox.Variant
> = Layer.merge(
  QuickJSSandbox.layerWithVariant,
  Steering.layerNoop()
)
