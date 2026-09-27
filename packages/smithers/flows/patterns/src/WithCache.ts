/**
 * Engine step-key cache decoration.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import * as CachePolicy from "@smthrs/plan/CachePolicy"
import * as Node from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"
import * as Decorate from "./internal/Decorate.ts"
import * as Pattern from "./Pattern.ts"
import { PatternError } from "./PatternError.ts"

/**
 * How far a recorded sealed result may travel.
 *
 * `shared` is the content-addressed default: the step key names the inputs and
 * the environment, so any run that would have produced the same bytes may
 * reuse the row. `run` and `flow` narrow that on purpose, for a step whose
 * result is only meaningful inside one execution or inside one flow.
 *
 * The three levels are the old `run | workflow | global` policy named after the
 * current concepts. This is `@smthrs/plan`'s `CachePolicy.CacheScope`, the same
 * vocabulary `@smthrs/flow` publishes as `CacheEnvironment.CacheScope` and the
 * engine reads at dispatch.
 *
 * @category models
 * @since 0.1.0
 */
export type Scope = CachePolicy.CacheScope

/**
 * The cache policy a wrapper declares: how long a recorded result may be
 * served, how far it may travel, and which revision of the body produced it.
 *
 * Every field is optional and every default is the pre-policy behavior: no age
 * bound, the reach the composition already granted, and no extra revision in
 * the key. All three are declaration identity: a wrapper that declares a
 * different policy is a different declaration, so a plan cannot silently reuse
 * a row recorded under another one.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * Milliseconds a recorded result stays servable, counted from when it was
   * recorded. Must be a positive safe integer. Once lowered onto an action,
   * the engine dispatches again past it and journals the expiry.
   */
  readonly ttlMs?: number | undefined
  /** How far the recorded result may travel. */
  readonly scope?: Scope | undefined
  /**
   * The caller's revision of the wrapped body. Changing it is how a caller
   * invalidates rows whose inputs did not change but whose meaning did. Must
   * contain nonblank text.
   */
  readonly version?: string | undefined
}

/**
 * The durable half of {@link Options}: the two fields the engine acts on at
 * dispatch. `version` is absent because it is declaration identity, not a
 * dispatch instruction: it changes the key the step is addressed by and
 * nothing else.
 *
 * This is `@smthrs/plan`'s `CachePolicy.CachePolicy`, the one policy model, so
 * a field added for the engine reaches this declaration surface too.
 *
 * @category models
 * @since 0.1.0
 */
export type Policy = CachePolicy.CachePolicy

/**
 * Annotation key carrying a declaration's {@link Policy}.
 *
 * It is `@smthrs/plan`'s `CachePolicy.CachePolicyAnnotation`, the same object
 * `@smthrs/flow` publishes as `CacheEnvironment.CachePolicyAnnotation` and
 * `@smthrs/engine-store` reads the policy by at dispatch, identified by
 * `"@smthrs/flow/Action/CachePolicy"`. A host must lower the flow bag onto an
 * action, as the registry bridge does for default-exported flows.
 *
 * @category annotations
 * @since 0.1.0
 */
export const CachePolicyAnnotation = CachePolicy.CachePolicyAnnotation

/**
 * The policy an annotation bag carries, or `undefined` when it carries none.
 *
 * @category getters
 * @since 0.1.0
 */
export const policyOf = CachePolicy.cachePolicyOf

/**
 * The durable fields of a declared policy, or `undefined` when the caller
 * declared neither. An options object carrying only `version` annotates
 * nothing, because there is nothing for the engine to do with it beyond the
 * key it already changed.
 *
 * @since 0.1.0
 * @private
 */
const durable = (options: Options): Policy | undefined =>
  options.ttlMs === undefined && options.scope === undefined ? undefined : {
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.scope === undefined ? {} : { scope: options.scope })
  }

/**
 * The declared fields, in a fixed order, as `field=value` pairs. Fixed so two
 * callers writing the same policy in a different object order declare the same
 * wrapper.
 *
 * @since 0.1.0
 * @private
 */
const declaredFields = (options: Options): ReadonlyArray<string> => {
  const fields: Array<string> = []
  if (options.ttlMs !== undefined) fields.push(`ttlMs=${options.ttlMs}`)
  if (options.scope !== undefined) fields.push(`scope=${options.scope}`)
  if (options.version !== undefined) fields.push(`version=${options.version}`)
  return fields
}

/**
 * The captured policy, carrying only the fields the caller declared, so an
 * undeclared policy captures exactly what it captured before the policy
 * existed.
 *
 * @since 0.1.0
 * @private
 */
const captured = (options: Options): Readonly<Record<string, unknown>> => ({
  ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  ...(options.scope === undefined ? {} : { scope: options.scope }),
  ...(options.version === undefined ? {} : { version: options.version })
})

const validate = (options: Options): void => {
  if (
    options.ttlMs !== undefined &&
    (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1)
  ) {
    throw new PatternError({
      code: "invalid_decorator",
      message: `withCache ttlMs must be a positive safe integer, received ${options.ttlMs}`
    })
  }
  if (options.scope !== undefined && !Schema.is(CachePolicy.CacheScope)(options.scope)) {
    throw new PatternError({
      code: "invalid_decorator",
      message: `withCache scope must be run, flow, or shared, received ${String(options.scope)}`
    })
  }
  if (options.version !== undefined && options.version.trim() === "") {
    throw new PatternError({
      code: "invalid_decorator",
      message: "withCache version must name a revision, not blank text"
    })
  }
}

const declaration = (inner: Flow.Any, options: Options): Flow.Any => {
  validate(options)
  const effects = Decorate.envelopeOf(inner)
  if (
    effects === undefined ||
    effects.mode !== "hermetic" ||
    (effects.tier !== undefined && effects.tier !== "sealed")
  ) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "withCache requires an explicitly hermetic, sealed flow"
    })
  }
  const fields = declaredFields(options)
  const wrapper = Flow.make(
    `withCache(${Decorate.displayName(inner)}${fields.length === 0 ? "" : `, ${fields.join(", ")}`})`,
    {
      ...(inner.description === undefined ? {} : { description: inner.description }),
      payload: inner.payloadSchema,
      success: inner.successSchema,
      error: inner.errorSchema,
      capabilities: Decorate.capabilitiesOf(inner),
      effects,
      body: Node.capture(captured(options), (payload: unknown) => Decorate.call(inner, payload))
    }
  ) as unknown as Flow.Any
  const policy = durable(options)
  // Captured fields establish declaration identity. The flow annotation is
  // metadata for a host to lower onto an action, as the registry bridge does.
  return policy === undefined ? wrapper : Decorate.annotate(wrapper, CachePolicyAnnotation, policy)
}

/**
 * Builds a cache decorator for an explicitly hermetic flow with a sealed or
 * omitted effects tier. A pure body without declared effects is insufficient.
 * Use with `Pattern.decorate` or `Pattern.decorateAll`.
 *
 * All options are optional. `ttlMs` must be a positive safe integer and
 * `version` a nonblank string; `scope` is `run`, `flow`, or `shared`. Invalid
 * effects, TTL, scope, or version throw {@link PatternError} with code
 * `invalid_decorator` synchronously when the returned decorator is applied.
 * `make` snapshots options at construction and validates them on application.
 *
 * Declared fields enter the wrapper's name and captured key material. The
 * {@link CachePolicyAnnotation} bag carries `ttlMs` and `scope`; `version`
 * affects identity only. Composition preserves the bag, with outer values
 * overriding inner ones. The `@smthrs/registry` bridge lowers a module's
 * default-exported flow bag onto an action. Ordinary nested core calls do not
 * propagate it: the durable engine reads the action-level policy set by
 * `CacheEnvironment.withCache` from `@smthrs/flow`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options = {}): Pattern.Decorator => {
  // The decorator is applied later than this call, so it reads this snapshot
  // and never the caller's options again.
  const snapshot: Options = { ttlMs: options.ttlMs, scope: options.scope, version: options.version }
  return (inner) => declaration(inner, snapshot)
}

/**
 * Wraps an explicitly hermetic flow in a sealed cache declaration.
 *
 * The input must declare hermetic effects with a sealed or omitted tier, even
 * for a pure body. Every option is optional; `ttlMs` must be a positive safe
 * integer, `version` a nonblank string, and `scope` `run`, `flow`, or `shared`.
 * Invalid effects, TTL, scope, or version throw {@link PatternError} with code
 * `invalid_decorator` synchronously.
 *
 * Declared fields enter identity. The {@link CachePolicyAnnotation} bag also
 * carries `ttlMs` and `scope` for a host to lower, as `@smthrs/registry` does
 * for a module's default-exported flow. Ordinary nested core calls do not
 * propagate the bag. The durable engine reads the action-level policy set by
 * `CacheEnvironment.withCache` from `@smthrs/flow`. This wrapper allocates no
 * cache and performs no expiry checks; `version` changes identity only.
 *
 * @example
 * ```ts
 * import * as Flow from "@smthrs/flow/Flow"
 * import { WithCache } from "@smthrs/patterns"
 * import * as Node from "@smthrs/plan/Node"
 * import * as Schema from "effect/Schema"
 *
 * const echo = Flow.make("echo", {
 *   payload: { input: Schema.String },
 *   success: Schema.String,
 *   effects: {
 *     reads: [], writes: [], mode: "hermetic", onConflict: "serialize"
 *   },
 *   body: ({ input }) => Node.succeed(input)
 * })
 *
 * // The registry bridge lowers this default export's policy onto an action.
 * export default WithCache.withCache(echo, { ttlMs: 60_000, version: "v1" })
 * ```
 *
 * @category combinators
 * @since 0.1.0
 */
export const withCache = (inner: Flow.Any, options?: Options | undefined): Flow.Any =>
  Decorate.seal(Pattern.decorate(inner, make(options)))
