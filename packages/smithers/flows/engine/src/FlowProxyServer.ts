/**
 * Server-side layers for flow proxy APIs.
 *
 * `layerHttpApi` connects the HTTP API group created by `FlowProxy` to the
 * supplied flows. `layerRpcHandlers` does the same for the generated RPC
 * definitions. Both layers route execute, discard, and resume requests to the
 * matching flow operation, while the `FlowRuntime` and flow handler
 * services stay on the server side.
 *
 * A handler here calls `flow.execute`, so both layers require what the served
 * bodies require: `Flow.Requirements` of every flow, alongside the schema
 * services `Flow.RequirementsHandler` names. Serving a flow is executing it,
 * and the compile-time gate on a missing action implementation has to hold
 * on this side of an RPC boundary too — the client, which only encodes a
 * payload and decodes a result, still requires nothing of the kind.
 *
 * @since 0.1.0
 */

import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { Flow, FlowRuntime } from "@smthrs/flow"
import type { NonEmptyReadonlyArray } from "effect/Array"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as HttpApi from "effect/unstable/httpapi/HttpApi"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import type * as Rpc from "effect/unstable/rpc/Rpc"
import * as FlowProxy from "./FlowProxy.ts"
import { renderDiagnostic } from "./internal/Diagnostic.ts"

/**
 * Rewrites the caller-supplied execution id before it reaches the engine, so
 * a multi-tenant server namespaces client identity in one place instead of at
 * every call site.
 *
 * The server calls the function once inside each execute, discard, or resume
 * handler. Execute and discard inputs include the decoded flow payload, while
 * resume inputs use `undefined` because a resume request carries only an
 * execution id. Returning `undefined` for execute or discard lets the engine
 * select the flow's idempotency key or ambient execution-id source. Returning `undefined` for
 * resume refuses the request with a `Flow.ExecutionIdRequired` defect:
 * falling back to the client value there would let a client resume outside
 * the namespace this option confines it to. Without this option, every
 * client value passes through unchanged.
 *
 * Implementations must be pure, must return for every input, and must return
 * a string for every resume. The function receives the flow and request
 * payload, but no request-scoped service. A resume request carries no
 * payload, so a scope that reads a middleware-authenticated tenant from
 * `payload` has to close over the trusted namespace for resume; a scope built
 * where the tenant is already known covers all three operations.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecutionIdScope {
  (input: {
    readonly flow: Flow.Any
    readonly operation: "execute" | "discard" | "resume" | "interrupt"
    readonly clientValue: string | undefined
    readonly payload: unknown
  }): string | undefined
}

const scopeExecutionId = (
  scope: ExecutionIdScope | undefined,
  input: Parameters<ExecutionIdScope>[0]
): string | undefined => scope === undefined ? input.clientValue : scope(input)

/**
 * Resolves the execution id a resume handler passes to `Flow.resume`, or dies
 * with `Flow.ExecutionIdRequired` when a configured scope declines to name
 * one. The client value is never a fallback here: a scope that namespaces
 * execute and discard but degrades to pass-through on resume would let a
 * client re-drive an execution in another namespace.
 */
const resumeExecutionId = (
  scope: ExecutionIdScope | undefined,
  flow: Flow.AnyWithProps,
  clientValue: string,
  operation: "resume" | "interrupt" = "resume"
): Effect.Effect<string> => {
  const scoped = scopeExecutionId(scope, {
    flow,
    operation,
    clientValue,
    payload: undefined
  })
  return scoped === undefined
    ? Effect.die(new Flow.ExecutionIdRequired({ flowName: flow._tag }))
    : Effect.succeed(scoped)
}

/**
 * The refusal a served flow dies with when its handler died of anything else.
 *
 * A defect is an implementation error, and an implementation error is the kind
 * that carries the credential the call was made with: an HTTP client error
 * holding the request headers, a provider SDK error holding the API key it was
 * constructed with. Inside the process that value is the best diagnostic there
 * is, so the engine keeps dying with it. Crossing this boundary it is a
 * liability instead — the server log prints it with `Cause.pretty`, and
 * `RpcServer` answers the caller that triggered the run with `Schema.Defect`
 * of it, which encodes a plain object as full JSON. `diagnostic` is the same
 * bounded, redacted rendering the engine writes to its own log line, so the
 * operator still reads what failed and the caller still learns that it did.
 *
 * @category errors
 * @since 1.0.0
 */
export class FlowHandlerDefect extends Schema.TaggedError<FlowHandlerDefect>()(
  "@smthrs/engine/FlowHandlerDefect",
  {
    code: Schema.Literal("flow_handler_defect").pipe(
      Schema.withConstructorDefault(Effect.succeed("flow_handler_defect"))
    ),
    flowName: Schema.String,
    diagnostic: Schema.String,
    message: Schema.String
  }
) {}

/**
 * Logs a handler defect as its redacted rendering and re-dies with a refusal
 * carrying the same rendering, so neither the log nor the wire sees the raw
 * value.
 *
 * @private
 */
const guardDefects = (flowName: string) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.catchDefect(effect, (defect) => {
    const diagnostic = renderDiagnostic(defect)
    return Effect.andThen(
      Effect.logError("A flow proxy handler died", diagnostic),
      Effect.die(
        new FlowHandlerDefect({
          flowName,
          diagnostic,
          message: `A ${flowName} proxy handler died: ${diagnostic}`
        })
      )
    )
  })

/** The decoded body of an execute or a discard request. */
type ExecuteRequest = {
  readonly payload: any
  readonly executionId: string
  readonly capabilityCeilings?: CapabilitySet.CapabilitySet["groups"]
}

/** The decoded body of a resume request, which names only an execution. */
type ResumeRequest = {
  readonly executionId: string
  readonly capabilityCeilings?: CapabilitySet.CapabilitySet["groups"]
}

/**
 * Builds the body one served execute or discard request runs.
 *
 * Both transports decode the same request and answer it by executing the
 * flow, so the scoped execution id, the defect guard, and the log annotation
 * are assembled once here instead of once per transport per operation.
 *
 * @private
 */
const handleExecute = (
  flow: Flow.AnyWithProps,
  scope: ExecutionIdScope | undefined,
  operation: "execute" | "discard",
  method: string
) =>
(request: ExecuteRequest) =>
  Effect.suspend(() =>
    flow.execute(request.payload, {
      discard: operation === "discard",
      executionId: scopeExecutionId(scope, {
        flow,
        operation,
        clientValue: request.executionId,
        payload: request.payload
      })
    })
  ).pipe(
    CapabilitySet.attenuateGroups(request.capabilityCeilings ?? []),
    guardDefects(flow._tag),
    Effect.annotateLogs({ module: "FlowProxyServer", method })
  )

/**
 * Builds the body one served resume request runs.
 *
 * @private
 */
const handleResume = (
  flow: Flow.AnyWithProps,
  scope: ExecutionIdScope | undefined,
  method: string
) =>
(request: ResumeRequest) =>
  Effect.suspend(() => resumeExecutionId(scope, flow, request.executionId)).pipe(
    Effect.flatMap((executionId) => flow.resume(executionId)),
    CapabilitySet.attenuateGroups(request.capabilityCeilings ?? []),
    guardDefects(flow._tag),
    Effect.annotateLogs({ module: "FlowProxyServer", method })
  )

/**
 * Builds the body one served interrupt request runs: the cancellation
 * `FlowRuntime.interrupt` requests, for the execution the request names.
 *
 * @private
 */
const handleInterrupt = (
  flow: Flow.AnyWithProps,
  scope: ExecutionIdScope | undefined,
  method: string
) =>
(request: ResumeRequest) =>
  Effect.suspend(() => resumeExecutionId(scope, flow, request.executionId, "interrupt")).pipe(
    Effect.flatMap((executionId) =>
      Effect.flatMap(FlowRuntime.FlowRuntime, (runtime) => runtime.interrupt(flow, executionId))
    ),
    guardDefects(flow._tag),
    Effect.annotateLogs({ module: "FlowProxyServer", method })
  )

/**
 * Creates handlers for a flow HTTP API group, wiring execute, discard, and
 * resume endpoints to the supplied flows.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHttpApi = <
  ApiId extends string,
  Groups extends HttpApiGroup.Constraint,
  Identifier extends HttpApiGroup.Identifier<Groups>,
  const Flows extends NonEmptyReadonlyArray<Flow.Any>
>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  identifier: Identifier,
  flows: Flows,
  options?: { readonly executionId?: ExecutionIdScope }
): Layer.Layer<
  HttpApiGroup.Service<ApiId, Identifier>,
  never,
  | FlowRuntime.FlowRuntime
  | Flow.Requirements<Flows[number]>
  | Flow.RequirementsHandler<Flows[number]>
> => {
  FlowProxy.assertNoCollisions(flows)
  return HttpApiBuilder.group(
    api,
    identifier,
    // Untraced because proxy handler construction recursively resolves flows.
    Effect.fnUntraced(function*(handlers: any) {
      for (const flow_ of flows) {
        const flow = flow_ as Flow.AnyWithProps
        const operation = FlowProxy.operationAddresses(flow._tag)
        const execute = handleExecute(flow, options?.executionId, "execute", operation.execute)
        const discard = handleExecute(flow, options?.executionId, "discard", operation.discard)
        const resume = handleResume(flow, options?.executionId, operation.resume)
        const interrupt = handleInterrupt(flow, options?.executionId, operation.interrupt)
        handlers = handlers
          .handle(operation.execute, ({ payload }: { payload: ExecuteRequest }) => execute(payload))
          .handle(operation.discard, ({ payload }: { payload: ExecuteRequest }) => discard(payload))
          .handle(operation.resume, ({ payload }: { payload: ResumeRequest }) => resume(payload))
          .handle(operation.interrupt, ({ payload }: { payload: ResumeRequest }) => interrupt(payload))
      }
      return handlers as HttpApiBuilder.Handlers<never>
    })
  )
}

/**
 * Creates RPC handlers for the supplied flows, wiring execute, discard,
 * and resume RPCs to flow operations.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerRpcHandlers = <
  const Flows extends NonEmptyReadonlyArray<Flow.Any>,
  const Prefix extends string = ""
>(flows: Flows, options?: {
  readonly prefix?: Prefix
  readonly executionId?: ExecutionIdScope
}): Layer.Layer<
  RpcHandlers<Flows[number], Prefix>,
  never,
  | FlowRuntime.FlowRuntime
  | Flow.Requirements<Flows[number]>
  | Flow.RequirementsHandler<Flows[number]>
> => {
  const prefix = options?.prefix ?? ""
  // The group owns both halves of a handler address: `Rpc.key`, effect's own
  // service key for a handler, and the execute, discard, and resume names
  // `FlowProxy.operationAddresses` derives. Implementing the group through
  // `toLayer` registers each body against the very `Rpc` the client calls, so
  // neither the key format nor the operation suffixes are restated here.
  // `toRpcGroup` refuses an ambiguous flow set on the way in.
  const group = FlowProxy.toRpcGroup(flows, { prefix })
  const handlers: Record<string, (request: any) => Effect.Effect<any, any, any>> = {}
  for (const flow_ of flows) {
    const flow = flow_ as Flow.AnyWithProps
    const operation = FlowProxy.operationAddresses(flow._tag, prefix)
    handlers[operation.execute] = handleExecute(flow, options?.executionId, "execute", operation.execute)
    handlers[operation.discard] = handleExecute(flow, options?.executionId, "discard", operation.discard)
    handlers[operation.resume] = handleResume(flow, options?.executionId, operation.resume)
    handlers[operation.interrupt] = handleInterrupt(flow, options?.executionId, operation.interrupt)
  }
  return group.toLayer(handlers as never) as any
}

/**
 * Union of RPC handler services required to serve the generated flow
 * execute, discard, and resume RPCs.
 *
 * @category services
 * @since 0.1.0
 */
export type RpcHandlers<Flows extends Flow.Any, Prefix extends string> = Flows extends Flow.Flow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Requires
> ?
    | Rpc.Handler<`${Prefix}${_Name}`>
    | Rpc.Handler<`${Prefix}${_Name}Discard`>
    | Rpc.Handler<`${Prefix}${_Name}Resume`>
    | Rpc.Handler<`${Prefix}${_Name}Interrupt`>
  : never
