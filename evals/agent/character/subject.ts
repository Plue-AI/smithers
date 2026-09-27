/**
 * One conversational turn of a role, run through the real agent loop.
 *
 * The composition is the one a host builds for a role turn: the `Agent`
 * service's cell loop, the QuickJS sandbox, the registry-backed call bridge,
 * and a resolved seat, inside a real flow execution on
 * `FlowEngine.layerMemory`. The role's system segments come from
 * `profile.ts`; the world's tools are bound as executable flows
 * (`world.ts`). Two seats:
 *
 * - **live**: a seat the CLI's own resolver signs, on the owner's
 *   subscriptions (`SMITHERS_OPENAI_AUTH=chatgpt`, the codex login in
 *   `$CODEX_HOME/auth.json`; API key variables are removed). This spends
 *   subscription usage.
 * - **replay**: a scripted model that answers with one recorded cell, used
 *   to run golden transcripts and counterexamples through the same loop and
 *   tools offline.
 *
 * The completion brakes built for code tasks (claim, unmoved tree, narrowed
 * evidence, unresolved failure, repeated observation) are disarmed: a turn
 * of conversation claims nothing about a workspace, and its reader is the
 * judge. Frames are capped.
 *
 * @since 0.1.0
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type { AgentEvent } from "../../../packages/smithers/agent/harness/src/index.ts"
import { Model, ModelEvent, ModelRequest, type Route } from "../../../packages/smithers/agent/model/src/index.ts"
import * as RequestExecutor from "../../../packages/smithers/agent/model/src/RequestExecutor.ts"
import { Registry } from "../../../packages/smithers/agent/registry/src/index.ts"
import {
  Agent,
  Budget,
  type FlowEngineLike,
  QuotaPolicy,
  Seat,
  SeatResolver
} from "../../../packages/smithers/agent/src/index.ts"
import * as ScriptedJudge from "../../../packages/smithers/agent/src/ScriptedJudge.ts"
import { FlowEngine } from "../../../packages/smithers/flows/engine/src/index.ts"
import { Flow, FlowRuntime } from "../../../packages/smithers/flows/flow/src/index.ts"
import * as KernelHttpClient from "../../../packages/smithers/flows/kernel/src/HttpClient.ts"
import { Capability, GrantStore, Permission, Workspace } from "../../../packages/smithers/flows/kernel/src/index.ts"
import { Node } from "../../../packages/smithers/flows/plan/src/index.ts"
import * as EgressHttpClient from "../../../packages/smithers/flows/platform-node/src/EgressHttpClient.ts"
import * as NativeEquipment from "../../../packages/smithers/src/internal/NativeEquipment.ts"
import type * as Profile from "./profile.ts"
import * as World from "./world.ts"

/** Token counts of one model call, as the provider reported them. */
export interface Usage {
  readonly input: number
  readonly cached: number
  readonly output: number
  readonly reasoning: number
}

/** What one turn produced. */
export interface Turn {
  /** The reply posted where the event arrived; `undefined` when the run failed. */
  readonly reply: string | undefined
  readonly actions: ReadonlyArray<World.Action>
  readonly failure: string | undefined
  readonly modelCalls: number
  readonly usage: ReadonlyArray<Usage>
  readonly durationMs: number
}

/** A recorded answer: the calls the role made and the reply it finished with. */
export interface Transcript {
  readonly reply: string
  readonly calls?: ReadonlyArray<{ readonly tool: string; readonly input: Record<string, unknown> }> | undefined
}

const emptyRegistry: Registry.Registry = Registry.makeNoop({
  list: () => Effect.succeed([]),
  visible: () => Effect.succeed([]),
  getOption: () => Effect.succeed(Option.none())
})

// A turn has no approved plan envelope to derive a spend cap from, and the
// subscription meter is the real limit; the runner accounts for usage itself.
// eslint-disable-next-line no-restricted-syntax -- eval turns have no approved envelope
const policy = Layer.mergeAll(QuotaPolicy.layerUnclassified(), Budget.layerUnbounded())

const prepared: Route.PreparedRequest = {
  routeId: "evals/character",
  protocolId: "evals/character",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const scriptedRoute: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

/** The cell that replays a transcript: each call in order, then the reply. */
export const replayCell = (transcript: Transcript): string =>
  [
    ...(transcript.calls ?? []).map((call) =>
      `await ctx.call(${JSON.stringify(call.tool)}, ${JSON.stringify(call.input)})`
    ),
    `ctx.done(${JSON.stringify(transcript.reply)})`
  ].join("\n")

/** A seat whose model answers every frame with the transcript's cell. */
export const replaySeat = (transcript: Transcript): Seat.Seat =>
  Seat.make({
    id: "evals:replay",
    modelId: "replay",
    model: Model.make({
      stream: () =>
        Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: "cell",
            text: "```cell\n" + replayCell(transcript) + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
    }),
    route: scriptedRoute,
    contextWindowTokens: 200_000
  })

/** The environment a live seat resolves against: subscriptions, never API keys. */
export const subscriptionEnvironment = (env: Readonly<Record<string, string | undefined>>) => {
  const kept: Record<string, string | undefined> = { ...env, SMITHERS_OPENAI_AUTH: "chatgpt" }
  delete kept.OPENAI_API_KEY
  delete kept.ANTHROPIC_API_KEY
  return kept
}

const allow = (action: Capability.PatternAction, resource: string): Permission.Rule =>
  new Permission.Rule({ effect: "allow", pattern: new Capability.CapabilityPattern({ action, resource }) })

/**
 * Resolves a live seat on this machine's subscriptions. The only grants are
 * outbound model and network calls: the turn's tools are simulated.
 */
export const resolveLive = (seat: string, root: string): Effect.Effect<Seat.Seat, Seat.SeatUnresolved, Scope.Scope> => {
  const env = subscriptionEnvironment(process.env)
  const grants = GrantStore.layer({ attended: false, rules: [allow("net:*", "**"), allow("model:*", "**")] }).pipe(
    Layer.provide(Workspace.layer(root)),
    Layer.orDie
  )
  const executor = RequestExecutor.layer.pipe(
    Layer.provide(KernelHttpClient.layer),
    Layer.provide([EgressHttpClient.layer(env), grants])
  )
  // The seat's model keeps using the executor (and its grant store) for every
  // later call, so the layer is built into the caller's scope: the seat lives
  // as long as that scope. Callers open one scope per conversation, because a
  // pooled HTTP/2 session the server has closed is never replaced, and every
  // later call on it fails with ERR_HTTP2_INVALID_SESSION.
  return Effect.gen(function*() {
    const context = yield* Layer.build(executor)
    const request = Context.get(context, RequestExecutor.RequestExecutor)
    return yield* NativeEquipment.seatResolver(env, request).resolve(seat)
  })
}

const DriveFlow = Flow.make("evals/character/Turn", {
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

const usageOf = (events: ReadonlyArray<AgentEvent.AgentEvent>): Array<Usage> =>
  events.flatMap((event) => {
    if (event._tag !== "model-settled") return []
    const usage = event.usage
    const cached = usage.cachedInputTokens ?? 0
    return [{
      input: Math.max(0, (usage.inputTokens ?? 0) - cached),
      cached,
      output: usage.outputTokens ?? 0,
      reasoning: usage.reasoningTokens ?? 0
    }]
  })

const describe = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause) as { readonly _tag?: unknown; readonly message?: unknown }
  const tag = typeof error?._tag === "string" ? error._tag : "failure"
  const message = typeof error?.message === "string" ? error.message : String(error)
  const detail = process.env.CHARACTER_DEBUG === undefined ? "" : `\n${Cause.pretty(cause)}`
  return `${tag}: ${message}${detail}`.slice(0, process.env.CHARACTER_DEBUG === undefined ? 600 : 20_000)
}

/** Everything one turn needs. */
export interface TurnOptions {
  readonly composed: Profile.Composed
  readonly seat: Seat.Seat
  readonly world: World.World
  readonly prompt: string
  readonly maxFrames?: number | undefined
  readonly session?: string | undefined
  /** Where the ids this turn's tools mint start (see `World.sources`). */
  readonly idBase?: number | undefined
  /** Sees every agent event as it happens, e.g. to trace a run. */
  readonly onEvent?: ((event: AgentEvent.AgentEvent) => void) | undefined
}

/** Runs one turn and reports the reply, the recorded actions and the usage. */
export const runTurn = (options: TurnOptions): Effect.Effect<Turn> =>
  Effect.gen(function*() {
    const actions: Array<World.Action> = []
    const events: Array<AgentEvent.AgentEvent> = []
    const started = Date.now()
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const settled = Deferred.makeUnsafe<Exit.Exit<string, unknown>>()
    const body = Effect.gen(function*() {
      const agent = yield* Agent.Agent
      yield* agent.run({
        session: options.session ?? "evals-character",
        seat: options.seat,
        prompt: options.prompt,
        system: options.composed.system,
        registry: emptyRegistry,
        capabilityEnvelope: [],
        maxFrames: options.maxFrames ?? 8,
        flows: World.sources(options.world, options.composed.role, actions, options.idBase ?? 0),
        ...(options.composed.effort === undefined
          ? {}
          : { modelParams: ModelRequest.GenerationParams.make({ reasoningEffort: options.composed.effort }) }),
        claimCap: 0,
        unmovedCap: 0,
        narrowingCap: 0,
        unresolvedCap: 0,
        repeatCap: 0,
        capacity: { park: false }
      }).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event)
            options.onEvent?.(event)
          })
        ),
        Effect.provide(Layer.merge(Agent.layerDefaults, ScriptedJudge.layer))
      )
      const answer = resolvedText(events)
      return answer === undefined ? yield* Effect.fail(new Error("the turn resolved with no answer")) : answer
    }).pipe(Effect.provide(Agent.layer), Effect.provide(policy))
    yield* engine.register(
      DriveFlow,
      () => Effect.onExit(body, (exit) => Effect.asVoid(Deferred.succeed(settled, exit)))
    ).pipe(Scope.provide(scope))
    yield* engine.execute(DriveFlow, { executionId: `evals-character-${started}`, payload: {}, discard: true })
    const exit = yield* Deferred.await(settled)
    const usage = usageOf(events)
    return {
      reply: Exit.isSuccess(exit) ? exit.value : undefined,
      actions,
      failure: Exit.isSuccess(exit) ? undefined : describe(exit.cause),
      modelCalls: events.filter((event) => event._tag === "model-settled").length,
      usage,
      durationMs: Date.now() - started
    } satisfies Turn
  }).pipe(
    Effect.provide(Layer.merge(FlowEngine.layerMemory, NodeCrypto.layer)),
    Effect.scoped,
    Effect.orDie
  )
