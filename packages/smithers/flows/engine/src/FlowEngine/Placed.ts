/**
 * Sends an execution whose placement the `Hosts` table binds to another
 * engine through that engine's served `FlowProxy` group.
 *
 * It sits inside the engine, not around it: a flow body reaches its children
 * through the `FlowRuntime` the driver provides, which is the engine itself,
 * so a decorator composed outside the engine would never see a `.child()`.
 *
 * @since 1.0.0
 */

import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { Flow, FlowRuntime } from "@smthrs/flow"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import type * as Scope from "effect/Scope"
import { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import * as FlowProxy from "../FlowProxy.ts"
import { type Binding, Hosts } from "../Hosts.ts"

/**
 * The authority a placed request carries: the caller's ceiling narrowed by
 * the flow's own declaration, exactly what a local admission would persist.
 * The serving engine intersects it with its own authority, so the wire can
 * only narrow what the remote host already allows, never widen it.
 */
const requestCeilings = (flow: Flow.Any): Effect.Effect<CapabilitySet.CapabilitySet["groups"]> =>
  Effect.map(
    Flow.attenuateCapabilities(Flow.capabilityCeilings(flow.annotations))(CapabilitySet.current),
    (set) => set.groups
  )

/**
 * A binding to another engine.
 *
 * @category models
 * @since 1.0.0
 */
export type Proxy = Extract<Binding, { readonly _tag: "Proxy" }>

/** The binding the table gives `flow`'s placement annotation. */
const bindingOf = (flow: Flow.Any): Effect.Effect<Binding> =>
  Effect.map(
    Hosts,
    (hosts) => hosts.resolve(Option.getOrUndefined(Context.getOption(flow.annotations, Flow.Placement)))
  )

/**
 * Whether the transport lost the call: a connection that failed or reset, not
 * a remote answer the client could not read, such as a refused bearer.
 */
const isTransport = (error: unknown): boolean =>
  error instanceof RpcClientError &&
  (error.reason._tag === "HttpError" ? error.reason.kind === "TransportError" : error.reason._tag.startsWith("Socket"))

/**
 * How long a caller keeps asking a remote engine that its transport lost: a
 * reset tunnel or an idle-timed-out connection mid-child. Each ask is under
 * the same id, so the remote engine joins the run it already has or answers
 * the result it recorded. About six minutes before the caller gives up.
 */
const transportRetry = Schedule.max([
  Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("1 minute")]),
  Schedule.recurs(12)
])

/**
 * Runs `use` against an RPC client for `flow`'s group. A transport failure
 * that outlives the caller's retries is a defect of this execution.
 */
const remote = <A, E>(
  binding: Proxy,
  flow: Flow.Any,
  use: (
    client: Record<string, (request: object) => Effect.Effect<any, any>>,
    operation: FlowProxy.OperationAddresses
  ) => Effect.Effect<A, E, Scope.Scope>
): Effect.Effect<A, E> =>
  Effect.scoped(
    Effect.flatMap(
      binding.connect(FlowProxy.toRpcGroup([flow]) as never),
      (client) => use(client as never, FlowProxy.operationAddresses(flow._tag))
    )
  ).pipe(
    // Every client failure the retry did not absorb is a defect of this
    // execution: none of them is an answer the flow declared.
    Effect.catchIf((error): error is never => error instanceof RpcClientError, (error) => Effect.die(error))
  )

/**
 * Runs `flow` on the binding's engine under `request.executionId` and answers
 * its result, or the id for a discard, which answers nothing on the wire.
 *
 * A lost transport is asked again under the same id, so the remote engine
 * joins the run it has or answers the result it recorded. A parent
 * interrupted while the remote run goes on forwards the cancellation, because
 * the remote engine has no lineage edge to carry it; the forward is best
 * effort, bounded, and logged when it fails.
 *
 * @category constructors
 * @since 1.0.0
 */
export const callRemote = (
  binding: Proxy,
  flow: Flow.Any,
  request: { readonly executionId: string; readonly payload: unknown; readonly discard?: boolean | undefined }
): Effect.Effect<unknown, unknown> =>
  remote(binding, flow, (client, operation) =>
    Effect.gen(function*() {
      const parent = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
      if (Option.isSome(parent)) {
        yield* Effect.addFinalizer(() =>
          parent.value.interrupted
            ? Effect.ignore(
              client[operation.interrupt]!({ executionId: request.executionId }).pipe(
                Effect.interruptible,
                Effect.timeout("5 seconds")
              ),
              { log: "Warn" }
            ).pipe(Effect.annotateLogs({ flow: flow._tag, executionId: request.executionId }))
            : Effect.void
        )
      }
      const capabilityCeilings = yield* requestCeilings(flow)
      const wire = { payload: request.payload, executionId: request.executionId, capabilityCeilings }
      const ask = request.discard === true
        ? Effect.as(client[operation.discard]!(wire), request.executionId)
        : client[operation.execute]!(wire)
      return yield* Effect.retry(ask, { while: isTransport, schedule: transportRetry })
    }))

/**
 * `execute` for a placed flow: `inner` when it runs here; otherwise
 * {@link callRemote} under the caller's execution id.
 *
 * @category constructors
 * @since 1.0.0
 */
export const placeExecute = <Execute extends FlowRuntime.FlowRuntime["Service"]["execute"]>(inner: Execute): Execute =>
  ((flow: Flow.Any, options: { readonly executionId: string; readonly payload: unknown; readonly discard?: boolean }) =>
    Effect.flatMap(bindingOf(flow), (binding) =>
      binding._tag === "Here"
        ? inner(flow as never, options as never)
        : callRemote(binding, flow, options))) as never

/**
 * `resume` for a placed flow: here, or the remote engine's resume.
 *
 * @category constructors
 * @since 1.0.0
 */
export const placeResume = (
  inner: FlowRuntime.FlowRuntime["Service"]["resume"]
): FlowRuntime.FlowRuntime["Service"]["resume"] =>
(flow, executionId, options) =>
  Effect.flatMap(bindingOf(flow), (binding) =>
    binding._tag === "Here"
      ? inner(flow, executionId, options)
      : options?.delegated === true
      // The remote resume API is the operator's own request. Forwarding a
      // delegated resume through it would promote it to recovery consent.
      ? Effect.die(new Error(`A delegated resume of ${flow._tag} cannot cross a remote placement`))
      : remote(binding, flow, (client, operation) =>
        Effect.flatMap(requestCeilings(flow), (capabilityCeilings) =>
          Effect.orDie(
            client[operation.resume]!({
              executionId,
              capabilityCeilings,
              ...(options?.poll === undefined ? {} : { poll: options.poll })
            })
          ))))

/**
 * `interrupt` for a placed flow: here, or the remote engine's interrupt.
 *
 * @category constructors
 * @since 1.0.0
 */
export const placeInterrupt = (
  inner: FlowRuntime.FlowRuntime["Service"]["interrupt"]
): FlowRuntime.FlowRuntime["Service"]["interrupt"] =>
(flow, executionId) =>
  Effect.flatMap(bindingOf(flow), (binding) =>
    binding._tag === "Here"
      ? inner(flow, executionId)
      : remote(binding, flow, (client, operation) => client[operation.interrupt]!({ executionId })))
