/**
 * Serializable values with which one flow round can settle.
 *
 * Engine handoff semantics are intentionally separate. These values contain
 * only the completed value, the next flow invocation, or the durable waiting
 * classification described by `docs/concepts/trampoline-rounds.md`.
 *
 * @since 0.1.0
 */

import type { CapabilityPattern } from "@smthrs/capability/Capability"
import * as Node from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"
import { WaitingAnnotation } from "../FlowRuntime/WaitingAnnotation.ts"
import { OutcomeNodeTypeId, OutcomeValueTypeId } from "../internal/OutcomeMarker.ts"

const outcomeNode = <A extends Outcome>(value: A): Node.Node<Node.Succeed<A>> => {
  const node = Node.succeed(value)
  Object.defineProperty(node.ast, OutcomeNodeTypeId, {
    configurable: false,
    enumerable: false,
    value: value._tag,
    writable: false
  })
  return node
}

/**
 * A completed trampoline lineage value.
 *
 * @category models
 * @since 0.1.0
 */
export interface Done<A> {
  readonly _tag: "Done"
  /**
   * The completed value in its author-facing form. The engine encodes it with
   * the settling flow's success schema at the settlement boundary; callers do
   * not pre-encode values passed to {@link done}.
   */
  readonly value: A
}

/**
 * A serializable invocation of the next flow round.
 *
 * @category models
 * @since 0.1.0
 */
export interface To<Payload> {
  readonly _tag: "To"
  readonly flow: string
  readonly capabilityCeilings?: ReadonlyArray<ReadonlyArray<CapabilityPattern>>
  /**
   * The next round's payload in its author-facing form. The engine encodes it
   * with the target flow's payload schema at settlement, before persisting the
   * handoff; callers do not pre-encode values passed to `Flow.to`.
   */
  readonly payload: Payload
}

/**
 * A request to durably park the current flow round.
 *
 * @category models
 * @since 0.1.0
 */
export interface Park {
  readonly _tag: "Park"
  readonly reason: WaitingAnnotation
}

/**
 * The three pure-data settlements a trampoline round can produce.
 *
 * @category models
 * @since 0.1.0
 */
export type Outcome<A = unknown, Payload = unknown> = Done<A> | To<Payload> | Park

/**
 * Schema for completed trampoline lineage values.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Done = Schema.Struct({
  _tag: Schema.tag("Done"),
  value: Schema.Unknown
})

/**
 * Schema for next-round flow invocations.
 *
 * @category schemas
 * @since 0.1.0
 */
export const To = Schema.Struct({
  _tag: Schema.tag("To"),
  flow: Schema.String,
  payload: Schema.Unknown
})

/**
 * Schema for durable trampoline parking requests.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Park = Schema.Struct({
  _tag: Schema.tag("Park"),
  reason: WaitingAnnotation
})

/**
 * Schema for every pure-data trampoline settlement.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Outcome = Schema.Union([Done, To, Park])

/**
 * Constructs a completed trampoline lineage value using Node.succeed's JSON
 * projection. Pass a planned reference to retain an upstream domain value.
 *
 * @category constructors
 * @since 0.1.0
 */
export const done = <A>(value: A): Node.Node<Node.Succeed<Done<A>>> => outcomeNode<Done<A>>({ _tag: "Done", value })

/**
 * Constructs a durable parking request using the runtime waiting vocabulary.
 *
 * The two forms describe the same wait. The record is the whole waiting
 * vocabulary, and is what a park with a deadline needs; the positional form is
 * the common case — a reason and the token a wake handler matches against —
 * written the way an author says it out loud, `Flow.park("approval", requestId)`.
 * A positional call with no token omits the field rather than parking under an
 * empty one.
 *
 * @category constructors
 * @since 0.1.0
 */
export const park: {
  (reason: WaitingAnnotation): Node.Node<Park>
  (reason: string, token?: string | undefined): Node.Node<Park>
} = (reason: WaitingAnnotation | string, token?: string | undefined): Node.Node<Park> =>
  outcomeNode({
    _tag: "Park",
    reason: typeof reason !== "string"
      ? reason
      : token === undefined
      ? { reason }
      : { reason, token }
  })

/**
 * Whether a settled body value is one of the three trampoline settlements.
 *
 * A body's root node may settle with anything its author wrote; only these
 * three values authored through {@link done}, a flow's `to` method, or
 * {@link park} ask the engine for a settlement other than "this value is the
 * answer". Shape alone is deliberately insufficient: ordinary success data
 * may legally contain the same `_tag` fields. Graph construction carries a
 * non-enumerable marker from the explicit authoring node to its hydrated
 * value, and encoded outcome records remain plain data until decoded by the
 * runtime surface that owns them.
 *
 * @category refinements
 * @since 0.1.0
 */
export const isOutcome = (value: unknown): value is Outcome => {
  if (typeof value !== "object" || value === null) return false
  const marker = Object.getOwnPropertyDescriptor(value, OutcomeValueTypeId)
  if (marker === undefined || !("value" in marker)) return false
  const tag = Object.getOwnPropertyDescriptor(value, "_tag")
  return tag !== undefined && "value" in tag && marker.value === tag.value && Schema.is(Outcome)(value)
}
