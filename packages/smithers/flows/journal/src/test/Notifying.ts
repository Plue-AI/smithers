/**
 * Effect-native analogue of Bazel Skyframe's `NotifyingHelper` and
 * `NotifyingInMemoryGraph`: wrap a record-of-Effect-methods service so a listener hook fires around
 * every operation. The hook runs in the calling fiber, so a hook that dies,
 * interrupts, or awaits a `Latch` injects crashes, fence loss, and exact
 * sequencing at any durable transition point, the mechanism that makes
 * interstitial interleaving bugs testable at all.
 *
 * Deliberately NOT ported from Skyframe: `DeterministicHelper`'s
 * deterministic-scheduler machinery, `ChainedFunction`, and `TrackingAwaiter`.
 * Effect already gives us deterministic fibers, `TestClock`, `Latch`, and
 * failure propagation across fiber joins, so those helpers have no residue
 * here.
 *
 * @since 0.1.0
 */

import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/**
 * Whether the hook is firing before or after the delegated operation.
 * Skyframe's `NotifyingHelper.Order`, minus its `BEFORE_AND_AFTER` (pass the
 * same hook body for both firings instead).
 *
 * @category models
 * @since 0.1.0
 */
export type Order = "before" | "after"

/**
 * Listener invoked around every delegated operation. `op` is the service
 * method name (Skyframe's `EventType`, but open-world), `args` the call
 * arguments. Express crash injection as `Effect.die` or `Effect.interrupt`
 * inside the hook, the hook's type stays `Effect<void>` so the wrapped
 * service is structurally identical to the real one.
 *
 * The `after` firing only happens when the operation succeeds; a failed
 * operation already is the interesting event.
 *
 * @category models
 * @since 0.1.0
 */
export type Hook = (
  op: string,
  order: Order,
  args: ReadonlyArray<unknown>
) => Effect.Effect<void>

/**
 * Wraps a service so `hook(op, "before" | "after", args)` fires around every
 * Effect-valued operation, delegating to the real implementation in between.
 *
 * Generic over any record-of-Effect-methods service (`Journal`, `CacheStore`,
 * `AttemptStore`, `RunStore`, ...): Effect-returning methods and plain Effect
 * properties are hooked; non-Effect members (e.g. `Stream`-returning methods)
 * delegate untouched.
 *
 * @category constructors
 * @since 0.1.0
 */
export const wrap = <S extends object>(service: S, hook: Hook): S => {
  const wrapped: Record<string, unknown> = {}
  for (const key of Object.keys(service)) {
    const value = (service as Record<string, unknown>)[key]
    if (Effect.isEffect(value)) {
      wrapped[key] = hook(key, "before", []).pipe(
        Effect.andThen(value as Effect.Effect<unknown, unknown, unknown>),
        Effect.tap(() => hook(key, "after", []))
      )
    } else if (typeof value === "function") {
      const method = value as (...args: Array<unknown>) => unknown
      wrapped[key] = (...args: Array<unknown>) => {
        const result = method.apply(service, args)
        return Effect.isEffect(result)
          ? hook(key, "before", args).pipe(
            Effect.andThen(result as Effect.Effect<unknown, unknown, unknown>),
            Effect.tap(() => hook(key, "after", args))
          )
          : result
      }
    } else {
      wrapped[key] = value
    }
  }
  return wrapped as S
}

/**
 * Layer form of {@link wrap}: reads the real service from the environment and
 * re-provides the notifying wrapper under the same key, so an existing stack
 * gains a listener without touching its construction.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = <Id, S extends object>(
  tag: Context.Key<Id, S>,
  hook: Hook
): Layer.Layer<Id, never, Id> => Layer.effect(tag)(Effect.map(tag, (service) => wrap(service, hook)))
