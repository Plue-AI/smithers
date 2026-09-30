/**
 * The authority a flow request carries, and the rule that decides whether a
 * request may join, poll, or resume an execution admitted under other
 * authority. Both engines and remote placement share them (#2852).
 *
 * @since 1.0.0
 */

import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { Flow } from "@smthrs/flow"
import * as Effect from "effect/Effect"

/**
 * The authority a request for `flow` carries: the caller's ceiling narrowed by
 * the flow's own declaration, exactly what admission persists.
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
