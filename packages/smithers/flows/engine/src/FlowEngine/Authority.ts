/**
 * The authority a flow request carries, and the rule that decides whether a
 * request may join, poll, or resume an execution admitted under other
 * authority. Both engines and remote placement share them (#2852).
 *
 * @since 1.0.0
 */

import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { Flow, type FlowRuntime } from "@smthrs/flow"
import * as Effect from "effect/Effect"

/**
 * The authority a request for `flow` carries: the caller's ceiling narrowed by
 * the flow's own declaration, exactly what admission persists. Behind
 * {@link bindHostCeiling} the caller's ceiling already includes the engine's
 * own host ceiling.
 *
 * @category accessors
 * @since 1.0.0
 */
export const requestedAuthority = (flow: Flow.Any): Effect.Effect<CapabilitySet.CapabilitySet["groups"]> =>
  Effect.map(
    Flow.attenuateCapabilities(Flow.capabilityCeilings(flow.annotations))(CapabilitySet.current),
    (set) => set.groups
  )

/**
 * Whether a request under `requested` authority (see
 * {@link requestedAuthority}) may join, poll, or resume an execution admitted
 * under `admitted`. Each of those answers or advances what the admitted
 * authority produces, so that authority must be provably within what the
 * caller could have run itself. A wider caller may join a narrower run; a
 * narrower caller never reads or drives what a wider run produced.
 *
 * `admitted` is the authority the execution recorded when it was admitted,
 * never narrowed by the flow's current declaration: a declaration narrowed
 * since then must not make an old, wider result readable.
 *
 * @category predicates
 * @since 1.0.0
 */
export const joinable = (
  admitted: CapabilitySet.CapabilitySet["groups"],
  requested: CapabilitySet.CapabilitySet["groups"]
): boolean => CapabilitySet.within(CapabilitySet.fromGroups(admitted), CapabilitySet.fromGroups(requested))

/**
 * Binds `service` to `host`, the capability ceiling its engine was constructed
 * under: every `execute`, `poll`, and `resume` runs under that ceiling
 * intersected with the caller's. Admission therefore records, and a join,
 * poll, or resume therefore compares, the host ceiling as well as the
 * caller's and the flow's, so a caller in a wider context never stores or
 * reads authority wider than the engine's host allows, and a replacement
 * engine built under a narrower host refuses a wider admitted run.
 *
 * @category combinators
 * @since 1.0.0
 */
export const bindHostCeiling = <Service extends FlowRuntime.FlowRuntime["Service"]>(
  host: CapabilitySet.CapabilitySet,
  service: Service
): Service => {
  const bound = CapabilitySet.attenuateGroups(host.groups)
  const execute: FlowRuntime.FlowRuntime["Service"]["execute"] = (flow, options) =>
    bound(service.execute(flow, options))
  const poll: FlowRuntime.FlowRuntime["Service"]["poll"] = (flow, executionId) => bound(service.poll(flow, executionId))
  const resume: FlowRuntime.FlowRuntime["Service"]["resume"] = (flow, executionId, options) =>
    bound(service.resume(flow, executionId, options))
  return { ...service, execute, poll, resume }
}
