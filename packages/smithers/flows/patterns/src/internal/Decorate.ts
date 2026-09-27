/**
 * What a decorator reads off a `@smthrs/flow` declaration, and how it
 * re-declares one.
 *
 * A decorator is the one thing in this package that does not merely CALL a
 * member: it takes a whole declaration apart and states a new one with the same
 * schemas and a narrowed authority. `@smthrs/core` carried a flow's capability
 * ceiling and effect envelope as literal fields, so reading them was a property
 * access; `@smthrs/flow` carries both in the annotation bag, under the keys
 * `Graph.build` itself consults. This module is where that difference lives, so
 * `Pattern`, `WithApproval`, `WithCache` and `WithRetry` state a wrapper the
 * same way.
 *
 * The envelope algebra it narrows with is `Compose`'s, which is
 * `@smthrs/plan/Effects`: a decorator that narrows a wrapped flow's authority
 * here and a `Graph.build` that refuses a widening composition read the same
 * declaration through the same rule.
 *
 * @since 1.0.0
 * @private
 */

import * as Flow from "@smthrs/flow/Flow"
import * as Effects from "@smthrs/plan/Effects"
import * as Node from "@smthrs/plan/Node"
import * as Context from "effect/Context"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import { PatternError } from "../PatternError.ts"
import * as Compose from "./Compose.ts"
import type { Member } from "./Member.ts"
import { call as callMember } from "./Member.ts"

/**
 * Records one call to a whole declaration.
 *
 * `Flow.Any` is the type-erased flow shape, which states the schemas and the
 * annotation bag but not `.call`, so the crossing is the one `Member` already
 * owns.
 *
 * @since 1.0.0
 * @private
 */
export const call = <R>(flow: Flow.Any, payload: unknown): Node.Node<unknown, unknown, R> =>
  callMember(flow as unknown as Member<R>, payload)

/**
 * The capability ceiling a declaration states.
 *
 * `Flow.Capabilities` is a reference whose default is the empty array, so an
 * undeclared ceiling reads as no capabilities rather than as absent. That is
 * the same read `flow/src/Graph.ts` performs on a call target.
 *
 * @since 1.0.0
 * @private
 */
export const capabilitiesOf = (flow: Flow.Any): ReadonlyArray<string> =>
  Context.get(flow.annotations, Flow.Capabilities)

/**
 * The effect envelope a declaration states, or `undefined` when it states
 * none.
 *
 * @since 1.0.0
 * @private
 */
export const envelopeOf = (flow: Flow.Any): Effects.Declaration | undefined =>
  Option.getOrUndefined(Context.getOption(flow.annotations, Flow.EffectEnvelope))

/**
 * The name a composed declaration reads off the flow it wraps.
 *
 * A tag is required of every `@smthrs/flow` declaration, so the empty string is
 * the one remaining way to have no name, and a flow called "" would compose
 * into `withRetry(, attempts=2)`.
 *
 * @since 1.0.0
 * @private
 */
export const displayName = (flow: Flow.Any): string => flow._tag.length === 0 ? "anonymous" : flow._tag

/**
 * Whether a supplied declaration may stand in for a declared input and output
 * pair.
 *
 * @since 1.0.0
 * @private
 */
export const schemasCompatible = (
  input: Schema.Top,
  output: Schema.Top,
  flow: Flow.Any
): SchemaCompatibilityIssue | undefined =>
  Compose.declaredSchemasCompatible(input, output, { input: flow.payloadSchema, output: flow.successSchema })

/**
 * What {@link schemasCompatible} reports when a declaration does not fit.
 *
 * @since 1.0.0
 * @private
 */
export type SchemaCompatibilityIssue = Exclude<ReturnType<typeof Compose.declaredSchemasCompatible>, undefined>

/** A declaration's own annotating half, which `Flow.Any` does not state. */
interface Annotatable {
  readonly annotate: <I, S>(key: Context.Key<I, S>, value: S) => Flow.Any
}

/**
 * Adds one annotation to a declaration without disturbing the rest of it.
 *
 * @since 1.0.0
 * @private
 */
export const annotate = <I, S>(flow: Flow.Any, key: Context.Key<I, S>, value: S): Flow.Any =>
  (flow as unknown as Annotatable).annotate(key, value)

/**
 * The annotation bag a wrapper starts from: both inner bags, with the supplied
 * outer declaration taking precedence.
 *
 * The capability ceiling and the effect envelope are entries in this bag rather
 * than fields beside it, so the wrapper's own narrowed authority is applied
 * ON TOP, by `Flow.make`'s `capabilities` and `effects` literals: a plain merge
 * would hand the wrapper back the authority it just narrowed. A wrapper that
 * narrows to no envelope at all drops the key, because an inherited envelope
 * would be authority the wrapper never declared.
 */
const wrapperAnnotations = (
  template: Flow.Any,
  supplied: Flow.Any,
  envelope: Effects.Declaration | undefined
): Context.Context<never> => {
  const merged = Context.merge(template.annotations, supplied.annotations)
  return envelope === undefined ? Context.omit(Flow.EffectEnvelope)(merged) : merged
}

/**
 * Re-declares a decorated flow under the wrapped flow's schemas and the
 * narrowed authority ceiling.
 *
 * @since 1.0.0
 * @private
 */
export const redeclare = (
  template: Flow.Any,
  supplied: Flow.Any,
  name: string
): Flow.Any => {
  const expected = envelopeOf(template)
  const actual = envelopeOf(supplied)
  if (actual !== undefined && (expected === undefined || !Effects.narrow(expected, actual).ok)) {
    throw new PatternError({
      code: "envelope_conflict",
      message: `Decorator "${name}" widens the wrapped flow's declared effect envelope`
    })
  }
  const envelope = Compose.intersectEffects(expected, actual).declaration
  return Flow.make(name, {
    ...(supplied.description === undefined ? {} : { description: supplied.description }),
    payload: template.payloadSchema,
    success: template.successSchema,
    error: template.errorSchema,
    capabilities: Compose.intersectCapabilities(capabilitiesOf(template), capabilitiesOf(supplied)),
    ...(envelope === undefined ? {} : { effects: envelope }),
    annotations: wrapperAnnotations(template, supplied, envelope),
    body: Node.capture({ name }, (payload: unknown) =>
      Node.andThen(
        Node.succeed({ _tag: "Decorator", name }),
        call<unknown>(supplied, payload)
      ))
  })
}

/**
 * States the wrapped declaration hermetic and sealed.
 *
 * A flow that declared no envelope gets the closed one, and a flow that
 * declared one keeps its paths under `Effects.sealed`.
 *
 * @since 1.0.0
 * @private
 */
export const seal = (flow: Flow.Any): Flow.Any => {
  const envelope = envelopeOf(flow)
  return annotate(
    flow,
    Flow.EffectEnvelope,
    envelope === undefined
      ? Effects.make({ reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" })
      : Effects.sealed(envelope)
  )
}
