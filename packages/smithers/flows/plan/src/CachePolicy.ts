/**
 * The caller-declared cache policy: how far a recorded sealed result may
 * travel, and how long it stays servable.
 *
 * This is the ONE cache-policy model. `@smthrs/flow` publishes it as
 * `CacheEnvironment.CachePolicy` and the engine reads it off a dispatched
 * action; `@smthrs/patterns` declares it over a flow as `WithCache.Policy`. It
 * used to be two declarations in those two packages, tied together by nothing
 * but a re-typed identifier string, so a field added on one side was invisible
 * to the other. It lives here because `@smthrs/plan` is the package both
 * already depend on.
 *
 * The annotation key still reads `"@smthrs/flow/Action/CachePolicy"`.
 * `@smthrs/engine-store`'s `ActionPersistence` reads the policy off stored and
 * dispatched actions by that identifier, so retagging it would make every
 * policy already written invisible at dispatch. The identifier is a wire
 * value, not a location.
 *
 * @since 1.0.0-rc.0
 */

import * as Context from "effect/Context"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * How far a recorded sealed result may travel.
 *
 * `shared` is the content-addressed default: the key names the inputs and the
 * environment, so any run on any host that would have produced the same bytes
 * may reuse the row. `run` and `flow` narrow that on purpose — a step whose
 * result is only meaningful inside one execution, or inside one flow, folds
 * that identity into its key so a sibling never reads it.
 *
 * The old scope vocabulary was `run | workflow | global`; `flow` and `shared`
 * are the same three levels named after the current concepts.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const CacheScope = Schema.Literals(["run", "flow", "shared"])

/**
 * The value form of {@link CacheScope}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type CacheScope = typeof CacheScope.Type

/**
 * A positive whole number of milliseconds.
 *
 * @private
 * @since 1.0.0-rc.0
 */
const PositiveMillis = Schema.Int.check(Schema.isGreaterThan(0))

/**
 * The caller's declaration about the decay and the reach of a sealed result.
 *
 * `ttlMs` bounds the age of a row the engine may serve: past it the dispatch
 * executes again and journals `cache-expired`, so the refusal is durable
 * evidence a replay reads rather than a fresh clock reading. `scope` decides
 * what the key names besides the inputs.
 *
 * Both fields are optional and both defaults are the pre-policy behavior: no
 * age bound, and the reach the composition's cache environment already
 * granted.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const CachePolicy = Schema.Struct({
  ttlMs: Schema.optionalKey(PositiveMillis),
  scope: Schema.optionalKey(CacheScope)
})

/**
 * The value form of {@link CachePolicy}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type CachePolicy = typeof CachePolicy.Type

/**
 * Annotation key carrying a declaration's {@link CachePolicy}.
 *
 * It is an annotation, not a field on the declaration, for the same reason
 * placement and effects are: the policy is data that travels with the
 * declaration and is read by whoever executes it, and adding it changes no
 * existing call site.
 *
 * @category annotations
 * @since 1.0.0-rc.0
 */
export const CachePolicyAnnotation = Context.Service<CachePolicy>("@smthrs/flow/Action/CachePolicy")

/**
 * Reads the cache policy an annotation bag carries, or `undefined` when it
 * carries none.
 *
 * @category getters
 * @since 1.0.0-rc.0
 */
export const cachePolicyOf = (annotations: Context.Context<never>): CachePolicy | undefined =>
  Option.getOrUndefined(Context.getOption(annotations, CachePolicyAnnotation))

/**
 * Attaches a cache policy to a declaration that can carry annotations.
 *
 * The declaration is not mutated: `annotate` answers a new one carrying the
 * policy, which is what a plan captures. It is written against the `annotate`
 * method rather than against an action or a flow type so the one declaration
 * serves both, which is what `@smthrs/flow` publishes as
 * `CacheEnvironment.withCache`.
 *
 * @example
 * ```ts
 * import { CachePolicy } from "@smthrs/plan"
 * import { Action } from "@smthrs/flow"
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 *
 * const compile = CachePolicy.annotate(
 *   Action.make({
 *     name: "build/compile",
 *     success: Schema.String,
 *     tier: "sealed",
 *     execute: Effect.succeed("dist/server.js")
 *   }),
 *   { ttlMs: 60_000, scope: "shared" }
 * )
 * ```
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const annotate = <A extends { annotate: (key: typeof CachePolicyAnnotation, value: CachePolicy) => A }>(
  declaration: A,
  policy: CachePolicy
): A => declaration.annotate(CachePolicyAnnotation, policy)
