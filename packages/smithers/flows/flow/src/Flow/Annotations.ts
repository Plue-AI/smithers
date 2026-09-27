// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Execution policies attached to flow definitions through Effect context.
 *
 * @since 0.1.0
 */

import * as PlanEffects from "@smthrs/plan/Effects"
import * as PlanPlacement from "@smthrs/plan/Placement"
import * as Plan from "@smthrs/plan/Plan"
import * as Context from "effect/Context"
import { constFalse, constTrue } from "effect/Function"

/**
 * Declared filesystem effects: the plan node effect contract itself.
 *
 * This is `@smthrs/plan`'s `Plan.NodeEffects`, not a copy of it. The two were
 * field-for-field identical structs in two packages, which meant a change to
 * one silently stopped `Plan.compile` decoding what this package wrote.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Effects = Plan.NodeEffects

/**
 * The value form of {@link Effects}.
 *
 * @category models
 * @since 0.1.0
 */
export type Effects = Plan.NodeEffects

/**
 * A directive naming where a node runs, carried unchanged until planning.
 *
 * This is `@smthrs/plan`'s `Placement.Placement`, the one typed model. It was
 * `Schema.Unknown` here while `@smthrs/core` held a four-variant enum of the
 * same thing, which made every crossing a cast.
 *
 * @category models
 * @since 0.1.0
 */
export type PlacementDirective = PlanPlacement.Placement

/**
 * Capability names a flow may require, defaulting to none.
 *
 * @category annotations
 * @since 0.1.0
 */
export const Capabilities = Context.Reference<ReadonlyArray<string>>(
  "@smthrs/flow/Flow/Capabilities",
  { defaultValue: () => [] }
)

/**
 * Required annotation key for a flow's declared filesystem effects.
 *
 * @category annotations
 * @since 0.1.0
 */
export const EffectsDeclaration = Context.Service<Effects>("@smthrs/flow/Flow/EffectsDeclaration")

/**
 * The effect AUTHORITY a flow declares: the ceiling every step spliced beneath
 * it must stay inside.
 *
 * This is the one envelope model, `@smthrs/plan/Effects`, which `@smthrs/core`
 * re-exports and `@smthrs/patterns` intersects against. It answers a different
 * question from {@link EffectsDeclaration}: that one says which FILES a node
 * touches, so a plan can order writers and a sandbox can enforce a boundary at
 * run time, while this one says how much a flow is ALLOWED to touch, so
 * {@link module:Graph.build} can refuse a composition that claims more than its
 * caller granted.
 *
 * `Flow.make`'s `effects` option writes it, which is what makes it readable by
 * a catalog that projects a declaration without importing this module.
 *
 * @category annotations
 * @since 0.1.0
 */
export const EffectEnvelope = PlanEffects.Envelope

/**
 * Required annotation key for a flow's schema-encodable placement directive.
 *
 * @category annotations
 * @since 0.1.0
 */
export const Placement = PlanPlacement.Annotation

/**
 * Captures defects for a flow and includes them in the result of the flow or its actions.
 *
 * **Details**
 *
 * By default, this annotation is set to `true`, meaning defects are captured.
 *
 * @category annotations
 * @since 0.1.0
 */
export const CaptureDefects = Context.Reference<boolean>(
  "@smthrs/flow/Flow/CaptureDefects",
  {
    defaultValue: constTrue
  }
)

/**
 * Whether a catalog may offer this flow to a model, defaulting to yes.
 *
 * It answers a different question from {@link Capabilities}: that one says how
 * much a flow is allowed to touch, this one says whether a model is shown the
 * flow at all. A flow whose actions only one host implements is discoverable
 * everywhere its file is, and teaching it to an agent running somewhere else
 * offers a call that has no implementation to reach.
 *
 * `Flow.make`'s `modelInvocable` option writes it, which is what makes it
 * readable by a catalog that projects a declaration from source text without
 * importing this module, exactly as `capabilities` and `effects` are.
 *
 * @category annotations
 * @since 0.1.0
 */
export const ModelInvocable = Context.Reference<boolean>(
  "@smthrs/flow/Flow/ModelInvocable",
  {
    defaultValue: constTrue
  }
)

/**
 * Marks a flow to suspend when it encounters any error.
 *
 * **Details**
 *
 * The suspended execution can later be resumed with the flow's `resume` method, for example `MyFlow.resume(executionId)`.
 *
 * @category annotations
 * @since 0.1.0
 */
export const SuspendOnFailure = Context.Reference<boolean>(
  "@smthrs/flow/Flow/SuspendOnFailure",
  {
    defaultValue: constFalse
  }
)
