/**
 * Typed immutable annotations attached to flow graph values.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
 *
 * @since 0.0.0
 */

import * as PlanEffects from "@smthrs/plan/Effects"
import * as PlanPlacement from "@smthrs/plan/Placement"
import { Context, type Option } from "effect"

/**
 * The empty annotation bag.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const empty: Context.Context<never> = Context.empty()

/**
 * Adds or replaces one annotation without changing the original context.
 *
 * @category adders
 * @since 0.0.0
 * @slop
 */
export const add = Context.add

/**
 * Merges parent and child annotation bags. Child values override parent values
 * for matching keys.
 *
 * @category combining
 * @since 0.0.0
 * @slop
 */
export const merge = (parent: Context.Context<never>, child: Context.Context<never>): Context.Context<never> =>
  Context.merge(parent, child)

/**
 * Safely retrieves an annotation. An absent service key returns `Option.none()`;
 * a `Context.Reference` key supplies its declared default.
 *
 * @category getters
 * @since 0.0.0
 * @slop
 */
export const getOption = <I, S>(context: Context.Context<never>, key: Context.Key<I, S>): Option.Option<S> =>
  Context.getOption(context, key)

/**
 * Annotation key for a node's placement directive.
 *
 * This is `@smthrs/plan`'s `Placement.Annotation`, the ONE key, which
 * `@smthrs/flow` also publishes as `Flow.Placement`. While the two packages
 * each declared a key with its own value type, crossing between them cost a
 * cast in `@smthrs/registry`.
 *
 * @category annotations
 * @since 0.0.0
 * @slop
 */
export const Placement = PlanPlacement.Annotation

/**
 * Annotation key for a flow or node effect declaration.
 *
 * This is `@smthrs/plan`'s `Effects.Envelope`, the ONE key, which
 * `@smthrs/flow` also publishes as `Flow.EffectEnvelope`. While the two
 * packages each declared their own key a flow annotated for one graph builder
 * was invisible to the other.
 *
 * @category annotations
 * @since 0.0.0
 * @slop
 */
export const Effects = PlanEffects.Envelope

/**
 * Annotation key for a node's scheduling priority.
 *
 * The value is a signed integer that orders ready work: a scheduler runs a
 * higher number before a lower one. Priority is a scheduling hint, never part
 * of step identity, so raising it never invalidates a cached step.
 *
 * @category annotations
 * @since 0.1.0
 * @slop
 */
export const Priority = Context.Service<number>("flows/core/Annotations/Priority")
