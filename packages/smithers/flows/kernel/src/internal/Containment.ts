/**
 * Trusted composition metadata shared by contained and permission-aware spawners.
 * @since 1.0.0
 */

import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

// The registry key also works when a service crosses the ESM/CJS projections.
// This declares a trusted lifecycle contract; it cannot prove a supplied
// lifecycle is honest or turn process containment into a security sandbox.
const key = Symbol.for("@smthrs/kernel/ContainedSpawner/Lifecycle/v1")

/**
 * Reads only an own data property, without invoking an accessor.
 * @private
 * @since 1.0.0
 */
export const isContained = (spawner: ChildProcessSpawner["Service"]): boolean =>
  Object.getOwnPropertyDescriptor(spawner, key)?.value === true

/**
 * Marks a newly constructed service without copying through object spreads.
 * @private
 * @since 1.0.0
 */
export const mark = (spawner: ChildProcessSpawner["Service"]): ChildProcessSpawner["Service"] =>
  Object.defineProperty(spawner, key, { value: true, enumerable: false, writable: false, configurable: false })

/**
 * Preserves the declaration on a wrapper that delegates its process lifetime.
 * @private
 * @since 1.0.0
 */
export const inherit = (
  source: ChildProcessSpawner["Service"],
  wrapper: ChildProcessSpawner["Service"]
): ChildProcessSpawner["Service"] => isContained(source) ? mark(wrapper) : wrapper
