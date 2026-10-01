/**
 * RPC and HTTP API definitions for flows.
 *
 * Given one or more `Flow` values, `toRpcGroup` creates the RPC definitions
 * for clients and servers, while `toHttpApiGroup` creates HTTP POST endpoints
 * that can be mounted in an API. Each flow gets execute, discard, and
 * resume operations, so callers can start a flow or resume a suspended run
 * by `executionId` without importing the flow handler directly.
 *
 * @since 0.1.0
 */

import { CapabilityPattern } from "@smthrs/capability/Capability"
import { type Flow, FlowRuntime } from "@smthrs/flow"
import type { NonEmptyReadonlyArray } from "effect/Array"
import * as Schema from "effect/Schema"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import { isWellFormedUtf16 } from "./internal/Utf16.ts"

/**
 * Raised before proxy construction when two flow operations share one wire
 * identity.
 *
 * @category errors
 * @since 1.0.0
 */
export class FlowProxyCollision extends Schema.TaggedError<FlowProxyCollision>()(
  "@smthrs/engine/FlowProxyCollision",
  { operation: Schema.String }
) {
  override readonly name = "FlowProxyCollision"
  readonly code = "flow_proxy_collision"
  override get message(): string {
    return `Flow proxy operation ${JSON.stringify(this.operation)} is not unique`
  }
}

/**
 * Raised before HTTP proxy construction when a flow tag is ill-formed UTF-16.
 *
 * @category errors
 * @since 1.0.0
 */
export class InvalidFlowTag extends Schema.TaggedError<InvalidFlowTag>()(
  "@smthrs/engine/InvalidFlowTag",
  { tag: Schema.String }
) {
  override readonly name = "InvalidFlowTag"
  readonly code = "invalid_flow_tag"
  override get message(): string {
    return `Flow tag ${JSON.stringify(this.tag)} is not well-formed UTF-16`
  }
}

/**
 * The four wire operation names one flow owns.
 *
 * @category models
 * @since 1.0.0
 */
export interface OperationAddresses {
  readonly execute: string
  readonly discard: string
  readonly resume: string
  /** Requests cancellation, as `FlowRuntime.interrupt` does. */
  readonly interrupt: string
}

/**
 * Derives operation names shared by proxy definitions and server handlers.
 *
 * @category constructors
 * @since 1.0.0
 */
export const operationAddresses = (tag: string, prefix = ""): OperationAddresses => ({
  execute: `${prefix}${tag}`,
  discard: `${prefix}${tag}Discard`,
  resume: `${prefix}${tag}Resume`,
  interrupt: `${prefix}${tag}Interrupt`
})

/**
 * Refuses a flow set whose generated operation names are ambiguous.
 *
 * @category validation
 * @since 1.0.0
 */
export const assertNoCollisions = (
  flows: ReadonlyArray<Flow.Any>,
  prefix = ""
): void => {
  const seen = new Set<string>()
  for (const flow of flows) {
    for (const operation of Object.values(operationAddresses(flow._tag, prefix))) {
      if (seen.has(operation)) throw new FlowProxyCollision({ operation })
      seen.add(operation)
    }
  }
}

/**
 * The most capability groups one placed request may carry.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxCeilingGroups = 64

/**
 * The most capability patterns one group of a placed request may carry.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxCeilingPatterns = 256

const ExecutionId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.makeFilter(isWellFormedUtf16, { expected: "well-formed UTF-16 text" })
)

/**
 * Authority carried by a placed request; each inner group is an alternative,
 * and groups intersect. The serving engine intersects it with its own
 * authority, so it can only narrow the run. Omitted is unrestricted, which a
 * serving engine still bounds by its own authority. Both levels are bounded so
 * a request cannot make admission do unbounded work.
 */
const CapabilityCeilings = Schema.Array(
  Schema.Array(CapabilityPattern).check(Schema.isMaxLength(maxCeilingPatterns))
).check(Schema.isMaxLength(maxCeilingGroups))
const OptionalCapabilityCeilings = Schema.optional(CapabilityCeilings)

type ExecutePayload<Payload extends Flow.AnyStructSchema> = Schema.Struct<{
  readonly payload: Payload
  readonly executionId: typeof ExecutionId
  readonly capabilityCeilings: typeof OptionalCapabilityCeilings
}>

const executePayload = <Payload extends Flow.AnyStructSchema>(
  payload: Payload
): ExecutePayload<Payload> =>
  Schema.Struct({
    payload,
    executionId: ExecutionId,
    capabilityCeilings: OptionalCapabilityCeilings
  })

/**
 * Derives an `RpcGroup` from a list of flows.
 *
 * **Example** (Deriving RPC endpoints from flows)
 *
 * ```ts
 * import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
 * import { Effect, Layer, Schema } from "effect"
 * import { RpcServer } from "effect/unstable/rpc"
 * import { FlowEngine, FlowProxy, FlowProxyServer } from "@smthrs/engine"
 * import { Action, Flow, Interpreter } from "@smthrs/flow"
 *
 * const RenderEmail = Action.make("RenderEmail", {
 *   payload: { to: Schema.String },
 *   success: Schema.String
 * })
 *
 * const EmailFlow = Flow.make("EmailFlow", {
 *   payload: {
 *     id: Schema.String,
 *     to: Schema.String
 *   },
 *   success: Schema.String,
 *   idempotencyKey: ({ id }) => id,
 *   body: (payload) => RenderEmail.call(payload)
 * })
 *
 * // This example renders a message without delivering it.
 * const EmailLayer = Layer.mergeAll(
 *   RenderEmail.toLayer(({ to }) => Effect.succeed(`Hello, ${to}.`)),
 *   Interpreter.layer(EmailFlow)
 * ).pipe(
 *   Layer.provideMerge(Action.layerImplementations),
 *   Layer.provideMerge(FlowEngine.layerMemory),
 *   Layer.provideMerge(NodeCrypto.layer)
 * )
 *
 * const myFlows = [EmailFlow] as const
 *
 * // Use FlowProxy.toRpcGroup to create a `RpcGroup` from the
 * // flows
 * class MyRpcs extends FlowProxy.toRpcGroup(myFlows) {}
 *
 * // Use FlowProxyServer.layerRpcHandlers to create a layer that implements
 * // the rpc handlers
 * const ApiLayer = RpcServer.layer(MyRpcs, { disableFatalDefects: true }).pipe(
 *   Layer.provide(FlowProxyServer.layerRpcHandlers(myFlows).pipe(
 *     Layer.provide(EmailLayer)
 *   ))
 * )
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const toRpcGroup = <
  const Flows extends NonEmptyReadonlyArray<Flow.Any>,
  const Prefix extends string = ""
>(
  flows: Flows,
  options?: {
    readonly prefix?: Prefix | undefined
  }
): RpcGroup.RpcGroup<ConvertRpcs<Flows[number], Prefix>> => {
  const prefix = options?.prefix ?? ""
  assertNoCollisions(flows, prefix)
  const rpcs: Array<Rpc.Any> = []
  for (const flow_ of flows) {
    const flow = flow_ as Flow.AnyWithProps
    const operation = operationAddresses(flow._tag, prefix)
    rpcs.push(
      Rpc.make(operation.execute, {
        payload: executePayload(flow.payloadSchema),
        error: Schema.Union([flow.errorSchema, FlowRuntime.ExecutionIdentityConflict]),
        success: flow.successSchema
      }).annotateMerge(flow.annotations),
      Rpc.make(operation.discard, {
        error: FlowRuntime.ExecutionIdentityConflict,
        payload: executePayload(flow.payloadSchema)
      }).annotateMerge(flow.annotations),
      Rpc.make(operation.resume, { payload: ResumePayload })
        .annotateMerge(flow.annotations),
      Rpc.make(operation.interrupt, { payload: ResumePayload, error: CancelRequestFailed })
        .annotateMerge(flow.annotations)
    )
  }
  return RpcGroup.make(...rpcs) as any
}

/**
 * Maps each flow to the RPC definitions generated for execute, discard,
 * and resume operations.
 *
 * @category converting
 * @since 0.1.0
 */
export type ConvertRpcs<Flows extends Flow.Any, Prefix extends string> = Flows extends Flow.Flow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Requires
> ?
    | Rpc.Rpc<
      `${Prefix}${_Name}`,
      ExecutePayload<_Payload>,
      _Success,
      Schema.Union<[_Error, typeof FlowRuntime.ExecutionIdentityConflict]>
    >
    | Rpc.Rpc<
      `${Prefix}${_Name}Discard`,
      ExecutePayload<_Payload>,
      typeof Schema.Void,
      typeof FlowRuntime.ExecutionIdentityConflict
    >
    | Rpc.Rpc<`${Prefix}${_Name}Resume`, typeof ResumePayload>
    | Rpc.Rpc<`${Prefix}${_Name}Interrupt`, typeof ResumePayload, typeof Schema.Void, typeof CancelRequestFailed>
  : never

/**
 * Derives an `HttpApiGroup` from a list of flows.
 *
 * **Example** (Deriving HTTP API endpoints from flows)
 *
 * ```ts
 * import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
 * import { Effect, Layer, Schema } from "effect"
 * import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
 * import { FlowEngine, FlowProxy, FlowProxyServer } from "@smthrs/engine"
 * import { Action, Flow, Interpreter } from "@smthrs/flow"
 *
 * const RenderEmail = Action.make("RenderEmail", {
 *   payload: { to: Schema.String },
 *   success: Schema.String
 * })
 *
 * const EmailFlow = Flow.make("EmailFlow", {
 *   payload: {
 *     id: Schema.String,
 *     to: Schema.String
 *   },
 *   success: Schema.String,
 *   idempotencyKey: ({ id }) => id,
 *   body: (payload) => RenderEmail.call(payload)
 * })
 *
 * // This example renders a message without delivering it.
 * const EmailLayer = Layer.mergeAll(
 *   RenderEmail.toLayer(({ to }) => Effect.succeed(`Hello, ${to}.`)),
 *   Interpreter.layer(EmailFlow)
 * ).pipe(
 *   Layer.provideMerge(Action.layerImplementations),
 *   Layer.provideMerge(FlowEngine.layerMemory),
 *   Layer.provideMerge(NodeCrypto.layer)
 * )
 *
 * const myFlows = [EmailFlow] as const
 *
 * // Use FlowProxy.toHttpApiGroup to create a `HttpApiGroup` from the
 * // flows
 * class MyApi extends HttpApi.make("api")
 *   .add(FlowProxy.toHttpApiGroup("flows", myFlows))
 * {}
 *
 * // Use FlowProxyServer.layerHttpApi to create a layer that implements the
 * // flows HttpApiGroup
 * const ApiLayer = HttpApiBuilder.layer(MyApi).pipe(
 *   Layer.provide(
 *     FlowProxyServer.layerHttpApi(MyApi, "flows", myFlows).pipe(
 *       Layer.provide(EmailLayer)
 *     )
 *   )
 * )
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const toHttpApiGroup = <const Name extends string, const Flows extends NonEmptyReadonlyArray<Flow.Any>>(
  name: Name,
  flows: Flows
): HttpApiGroup.HttpApiGroup<Name, ConvertHttpApi<Flows[number]>> => {
  assertNoCollisions(flows)
  let group = HttpApiGroup.make(name)
  for (const flow_ of flows) {
    const flow = flow_ as Flow.AnyWithProps
    const operation = operationAddresses(flow._tag)
    const path = `/${tagToPath(flow._tag)}` as const
    group = group.add(
      HttpApiEndpoint.post(operation.execute, path, {
        payload: executePayload(flow.payloadSchema),
        success: flow.successSchema,
        error: Schema.Union([flow.errorSchema, FlowRuntime.ExecutionIdentityConflict])
      }).annotateMerge(flow.annotations),
      HttpApiEndpoint.post(operation.discard, `${path}/discard`, {
        error: FlowRuntime.ExecutionIdentityConflict,
        payload: executePayload(flow.payloadSchema)
      }).annotateMerge(flow.annotations),
      HttpApiEndpoint.post(operation.resume, `${path}/resume`, {
        payload: ResumePayload
      }).annotateMerge(flow.annotations),
      HttpApiEndpoint.post(operation.interrupt, `${path}/interrupt`, {
        payload: ResumePayload,
        error: CancelRequestFailed
      }).annotateMerge(flow.annotations)
    ) as any
  }
  return group as any
}

const tagToPath = (tag: string): string => {
  if (!isWellFormedUtf16(tag)) throw new InvalidFlowTag({ tag })
  // Routers disagree about whether a percent-encoded slash is decoded before
  // matching. UTF-16 hex is injective, URL-safe, and remains one segment in
  // every adapter while preserving case and normalization distinctions.
  let encoded = "flow-"
  for (let index = 0; index < tag.length; index++) encoded += tag.charCodeAt(index).toString(16).padStart(4, "0")
  return encoded
}

/**
 * Maps each flow to the HTTP API endpoints generated for execute,
 * discard, and resume operations.
 *
 * @category converting
 * @since 0.1.0
 */
export type ConvertHttpApi<Flows extends Flow.Any> = Flows extends Flow.Flow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Requires
> ?
    | HttpApiEndpoint.HttpApiEndpoint<
      _Name,
      "POST",
      `/${string}`,
      never,
      never,
      ExecutePayload<_Payload>,
      never,
      _Success,
      Schema.Union<[_Error, typeof FlowRuntime.ExecutionIdentityConflict]>
    >
    | HttpApiEndpoint.HttpApiEndpoint<
      `${_Name}Discard`,
      "POST",
      `/${string}/discard`,
      never,
      never,
      ExecutePayload<_Payload>,
      never,
      typeof Schema.Void,
      typeof FlowRuntime.ExecutionIdentityConflict
    >
    | HttpApiEndpoint.HttpApiEndpoint<
      `${_Name}Resume`,
      "POST",
      `/${string}/resume`,
      never,
      never,
      typeof ResumePayload
    >
    | HttpApiEndpoint.HttpApiEndpoint<
      `${_Name}Interrupt`,
      "POST",
      `/${string}/interrupt`,
      never,
      never,
      typeof ResumePayload,
      never,
      typeof Schema.Void,
      typeof CancelRequestFailed
    > :
  never

const ResumePayload = Schema.Struct({
  executionId: ExecutionId,
  capabilityCeilings: OptionalCapabilityCeilings,
  poll: Schema.optionalKey(Schema.Boolean)
})

const CancelRequestFailed = FlowRuntime.CancelRequestFailed
