// Deep reviewed and polished by a human on 2026-08-10.

/**
 * The environment description folded into every cross-run cache key.
 *
 * A cached result is only reusable on a host that would have produced the same
 * bytes, so the key has to name the environment as well as the inputs — the
 * platform, the toolchain, and the capability groups in force. Bazel's action
 * key does the same thing for the same reason.
 *
 * It is a *complete* value on purpose: an environment a composition cannot
 * fully describe is one whose cache hits cannot be justified, and the engine
 * executes rather than guessing at the missing part.
 *
 * @since 0.1.0
 */

import * as PlanCachePolicy from "@smthrs/plan/CachePolicy"
import * as Schema from "effect/Schema"

/**
 * Validates named capability groups.
 *
 * @private
 * @since 0.1.0
 */
const Capabilities = Schema.Record(Schema.String, Schema.Array(Schema.NonEmptyString)).check(
  Schema.makeFilter((capabilities) =>
    Object.keys(capabilities).every((name) => name.length > 0) || "Capability names must not be empty"
  )
)

/**
 * Complete runtime environment included in every cross-run cache key.
 *
 * If a composition cannot provide this complete value, the engine executes
 * normally but does not derive a cross-run cache key.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheEnvironment = typeof CacheEnvironment.Type

/**
 * Schema for the complete runtime environment included in cache keys.
 *
 * @category models
 * @since 0.1.0
 */
export const CacheEnvironment = Schema.Struct({
  /** Ordered semantic runtime layers, including versions and configuration. */
  layers: Schema.Array(Schema.NonEmptyString),
  /** Complete effective capability groups. */
  capabilities: Capabilities
})

/**
 * How far a recorded sealed result may travel.
 *
 * `shared` is the content-addressed default: the key names the inputs and the
 * environment, so any run on any host that would have produced the same bytes
 * may reuse the row. `run` and `flow` narrow that on purpose — a step whose
 * result is only meaningful inside one execution, or inside one flow, folds
 * that identity into its key so a sibling never reads it.
 *
 * This is `@smthrs/plan`'s `CachePolicy.CacheScope`, the one scope vocabulary
 * `@smthrs/patterns` also declares its policy with.
 *
 * @category models
 * @since 0.1.0
 */
export const CacheScope = PlanCachePolicy.CacheScope

/**
 * How far a recorded sealed result may travel.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheScope = PlanCachePolicy.CacheScope

/**
 * The caller's declaration about the decay and the reach of a sealed action's
 * recorded result.
 *
 * `ttlMs` bounds the age of a row the engine may serve: past it the dispatch
 * executes again and journals `cache-expired`, so the refusal is durable
 * evidence a replay reads rather than a fresh clock reading. `scope` decides
 * what the key names besides the inputs.
 *
 * This is `@smthrs/plan`'s `CachePolicy.CachePolicy`, the one policy schema.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CachePolicy = PlanCachePolicy.CachePolicy

/**
 * The caller's declaration about the decay and the reach of a sealed action's
 * recorded result.
 *
 * @category models
 * @since 0.1.0
 */
export type CachePolicy = PlanCachePolicy.CachePolicy

/**
 * Annotation key carrying a declaration's {@link CachePolicy}.
 *
 * It is an annotation, not a field on the action, for the same reason
 * placement and effects are: the policy is data that travels with the
 * declaration and is read by whoever executes it, and adding it changes no
 * existing call site.
 *
 * It is `@smthrs/plan`'s `CachePolicy.CachePolicyAnnotation` itself, the same
 * object `@smthrs/patterns` annotates a flow with, identified by
 * `"@smthrs/flow/Action/CachePolicy"`.
 *
 * @category annotations
 * @since 0.1.0
 */
export const CachePolicyAnnotation = PlanCachePolicy.CachePolicyAnnotation

/**
 * Reads the cache policy an annotation bag carries, or `undefined` when it
 * carries none.
 *
 * @category getters
 * @since 0.1.0
 */
export const cachePolicyOf = PlanCachePolicy.cachePolicyOf

/**
 * Declares a cache policy on an action.
 *
 * This is the form the engine honors today: `@smthrs/engine-store` reads
 * {@link CachePolicyAnnotation} off the dispatched action, bounds the age of
 * the row it may serve by `ttlMs`, and narrows the address that row is stored
 * under from `scope`. `@smthrs/patterns`' `WithCache` declares the same policy
 * over a `@smthrs/core` flow under the same annotation key, for the
 * declaration surface, so a policy written by either is read by the engine.
 *
 * The action is not mutated. `annotate` returns a new declaration carrying the
 * policy, which is what a plan captures.
 *
 * It is `@smthrs/plan`'s `CachePolicy.annotate` under this package's name for
 * it.
 *
 * @example
 * ```ts
 * import { Action } from "@smthrs/flow"
 * import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 *
 * const compile = CacheEnvironment.withCache(
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
 * @since 0.1.0
 */
export const withCache = PlanCachePolicy.annotate
