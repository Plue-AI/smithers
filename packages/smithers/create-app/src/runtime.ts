/**
 * Turns declarations into executable flows.
 *
 * {@link materializeFlow} pairs one `FlowSpec` with the `AgentSpec` the router
 * resolved for it, which is why a flow file never names a seat.
 * {@link layerFor} composes the host services one flow runs under from its
 * three layer files. A host calls both per run: the Worker does it per turn,
 * and `@smthrs/create-app/testing` does it per test.
 *
 * @since 0.1.0
 */

import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as Capability from "@smthrs/capability/Capability"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow } from "@smthrs/flow"
import type * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import * as Evaluator from "@smthrs/model/Evaluator"
import type * as Model from "@smthrs/model/Model"
import * as Registry from "@smthrs/registry/Registry"
import type * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import {
  type AgentSpec,
  type AnyFlowSpec,
  defaultCallLimit,
  defaultMaxFrames,
  type SandboxSpec,
  type ToolsGrant,
  type ToolsSpec
} from "./app.ts"

/**
 * One flow made executable: the declared agent action and the flow that calls
 * it, both named after the flow's routed id.
 *
 * @category models
 * @since 0.1.0
 */
export interface MaterializedFlow {
  readonly id: string
  readonly action: ReturnType<typeof AgentAction.make>
  readonly flow: ReturnType<typeof Flow.make>
}

/**
 * Binds one flow declaration to the agent layer resolved for it.
 *
 * The action's system teaching is the agent layer's lines followed by the
 * flow's own, in that order: the layer says what the app is, the flow says
 * what this task is.
 *
 * @category constructors
 * @since 0.1.0
 */
export const materializeFlow = (id: string, spec: AnyFlowSpec, agent: AgentSpec): MaterializedFlow => {
  // `AnyFlowSpec` erased the payload type, and `prompt` is contravariant in it,
  // so the two are re-paired here. `defineFlow` is what guarantees the pairing:
  // it built both from one type parameter.
  const prompt = spec.prompt as (payload: Schema.Struct.Type<Schema.Struct.Fields>) => string
  const action = AgentAction.make(`app/${id}/agent`, {
    payload: spec.payload,
    output: spec.output,
    seat: agent.seat,
    system: [...agent.system, ...(spec.system ?? [])],
    prompt
  })
  const flow = Flow.make(`app/${id}`, {
    payload: spec.payload,
    success: spec.output,
    error: AgentAction.AgentFailure,
    body: (payload: Schema.Struct.Type<typeof spec.payload>) => action.call(payload)
  })
  return { id, action, flow }
}

/**
 * How a host turns a seat id into a live model.
 *
 * This is the one seam between a routed app and a provider: the Worker
 * resolves seats against its bound credentials, and a test resolves every seat
 * to a recorded model.
 *
 * @category models
 * @since 0.1.0
 */
export interface SeatProvider {
  readonly resolve: (
    seatId: string
  ) => Effect.Effect<{ readonly model: Model.Model; readonly route: Seat.Seat["route"] }, Seat.SeatUnresolved>
}

/**
 * The three resolved layer files plus the things only a host can supply.
 *
 * `sandboxVariant` names the QuickJS build the sandbox compiles. Omitted, the
 * host gets the single-file build, which Node and a browser compile from bytes
 * and Cloudflare's workerd refuses; see {@link layerFor}.
 *
 * The host's resolved agent seat also judges completions. Offline hosts may
 * supply an explicit scripted evaluator. No separate judge credential exists.
 *
 * @category models
 * @since 0.1.0
 */
export interface LayerOptions {
  readonly agent: AgentSpec
  readonly sandbox: SandboxSpec
  readonly tools: ToolsSpec
  readonly seats: SeatProvider
  readonly crypto: Layer.Layer<Crypto.Crypto>
  readonly sandboxVariant?: Layer.Layer<QuickJSSandbox.Variant> | undefined
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
}

/**
 * Why a routed app's host could not be composed.
 *
 * `invalid_grant` is a `TOOLS.ts` capability grant the kernel's pattern
 * grammar does not accept.
 *
 * @category models
 * @since 0.1.0
 */
export type LayerErrorCode = "invalid_grant"

/**
 * A refused layer composition, thrown rather than returned because every
 * caller — the Worker, a test, the dev server — wants the host build to stop.
 *
 * @category errors
 * @since 0.1.0
 */
export class LayerError extends Data.TaggedError("create-app/LayerError")<{
  readonly code: LayerErrorCode
  readonly message: string
}> {
  /**
   * @category models
   * @since 0.1.0
   */
  override readonly name = "LayerError"
  constructor(code: LayerErrorCode, message: string) {
    super({ code, message })
  }
}

const patternActions: ReadonlySet<string> = new Set(Capability.PatternAction.literals)

/**
 * Decodes one declared grant into the capability pattern the harness enforces.
 *
 * The grant is checked here rather than passed through as `never`: an unknown
 * action or an over-long resource used to reach `CapabilityPattern`'s schema
 * and fail with a message that named neither the grant that carried it nor the
 * component that was wrong.
 */
const patternOf = (grant: ToolsGrant, index: number): Capability.CapabilityPattern => {
  if (!patternActions.has(grant.action)) {
    throw new LayerError(
      "invalid_grant",
      `TOOLS.ts grant[${index}].action is not a capability action: ${JSON.stringify(grant.action)}`
    )
  }
  if (grant.resource.length > Capability.maxResourceLength) {
    throw new LayerError(
      "invalid_grant",
      `TOOLS.ts grant[${index}].resource is ${grant.resource.length} characters; `
        + `the limit is ${Capability.maxResourceLength}`
    )
  }
  return new Capability.CapabilityPattern({ action: grant.action, resource: grant.resource })
}

/** The context window a seat is assumed to have until a resolver says otherwise. */
const defaultContextWindowTokens = 200_000

/**
 * Projects the two author-facing layer files onto the one `Sandbox.Limits` the
 * agent host takes.
 *
 * The split is deliberate: how many tools a step may reach for belongs to the
 * agent, and how much compute one cell may burn belongs to the sandbox.
 */
const limitsOf = (agent: AgentSpec, sandbox: SandboxSpec): Sandbox.Limits => ({
  calls: agent.limits?.calls ?? defaultCallLimit,
  memoryBytes: sandbox.limits.heapBytes,
  steps: sandbox.limits.interruptChecks,
  totalMs: sandbox.limits.wallClockMs
})

/**
 * The catalog a routed app's cells are shown: nothing.
 *
 * A routed app reaches its tools through the `TOOLS.ts` binding sources, which
 * the agent host composes into every cell as `Host.flows`. No routed app
 * resolves a flow by registry lookup, so an empty registry is the honest
 * declaration rather than a placeholder.
 *
 * @category constructors
 * @since 0.1.0
 */
export const emptyRegistry = (): Registry.Registry =>
  Registry.makeNoop({
    list: () => Effect.succeed([]),
    visible: () => Effect.succeed([]),
    getOption: () => Effect.succeed(Option.none())
  })

/**
 * The full host for one flow: the agent host, the seat resolver, the agent
 * loop, the sandbox and steering defaults, the action implementations, an
 * in-memory flow engine, and the caller's crypto.
 *
 * This is where the QuickJS build is selected, and the one place that says
 * why a Worker host cannot run a live turn yet. Without `sandboxVariant` the
 * host gets `Agent.layerDefaults`, whose sandbox compiles the single-file
 * QuickJS build with `WebAssembly.compile` over bytes. workerd refuses that:
 * it instantiates only a module the toolchain compiled. Such a host builds a
 * variant from a `.wasm` module import (`QuickJSSandbox.layerVariant`) and
 * passes it here, which composes `Agent.layerDefaultsWithVariant` instead.
 * The `aomi` template's Worker does not pass one yet.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerFor = (options: LayerOptions) => {
  const evaluator = options.evaluator ?? Layer.succeed(Evaluator.Evaluator)({
    evaluate: (request) =>
      options.seats.resolve(options.agent.seat).pipe(
        Effect.mapError(() =>
          new Evaluator.EvaluatorError({ code: "unreachable", message: Evaluator.unreachableMessage })
        ),
        Effect.flatMap((seat) =>
          Effect.flatMap(Evaluator.Evaluator, (judge) => judge.evaluate(request)).pipe(
            Effect.provide(Evaluator.layerFromSeat({ model: seat.model, modelId: Seat.modelIdOf(options.agent.seat) }))
          )
        )
      )
  })
  const host = AgentAction.layerHost({
    registry: emptyRegistry(),
    limits: limitsOf(options.agent, options.sandbox),
    flows: options.tools.sources,
    capabilityEnvelope: options.tools.grant.map(patternOf),
    maxFrames: options.agent.maxFrames ?? defaultMaxFrames
  })
  const seats = SeatResolver.layer({
    resolve: (id) =>
      options.seats.resolve(id).pipe(
        Effect.map(({ model, route }) =>
          Seat.make({ id, modelId: Seat.modelIdOf(id), model, route, contextWindowTokens: defaultContextWindowTokens })
        )
      )
  })
  // Routed apps spend real model calls, so a reset-bearing refusal should
  // park. This boundary has no approved plan envelope, so an invented ceiling
  // would be policy the app author never chose.
  // eslint-disable-next-line no-restricted-syntax -- no approved envelope exists, see above
  const agentPolicy = Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded())
  const defaults = options.sandboxVariant === undefined
    ? Agent.layerDefaults
    : Agent.layerDefaultsWithVariant.pipe(Layer.provide(options.sandboxVariant))
  return Layer.mergeAll(host, seats, Agent.layer).pipe(
    Layer.provideMerge(agentPolicy),
    Layer.provideMerge(defaults),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(options.crypto),
    Layer.provideMerge(evaluator)
  )
}

/** Refuses a composition root that still owes a service. */
type Complete<L> = [L] extends [Layer.Layer<infer _A, infer _E, infer R>] ? [R] extends [never] ? true : false
  : false

/** Fails to compile unless its argument is `true`. */
type Expect<T extends true> = T

/**
 * The routed-app runtime supplies every service its flow can require.
 *
 * @category models
 * @since 0.1.0
 */
export type CompositionRootsAreComplete = [Expect<Complete<ReturnType<typeof layerFor>>>]
