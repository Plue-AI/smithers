/**
 * Completion-aware, replacement-safe ownership of live fibers.
 * @since 1.0.0
 */

import type * as Fiber from "effect/Fiber"

/**
 * A completed predecessor must never unregister its replacement.
 * @category registration
 * @since 1.0.0
 */
export const register = <K>(
  fibers: Map<K, Fiber.Fiber<unknown, unknown>>,
  key: K,
  fiber: Fiber.Fiber<unknown, unknown>
): void => {
  fibers.set(key, fiber)
  fiber.addObserver(() => {
    if (fibers.get(key) === fiber) fibers.delete(key)
  })
}
