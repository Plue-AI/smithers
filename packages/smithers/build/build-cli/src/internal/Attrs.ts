/**
 * The attr-walking helper `PackageIndex` and `PackageExec` had copy-defined.
 *
 * Both modules read the same declaration objects and both must reach the same
 * answer: the index computes a target's declared edges from it, the executor
 * computes the same target's plan from it. Two copies drifting apart would let
 * the graph a run schedules disagree with the graph the index reports.
 *
 * @since 0.1.0
 */

import * as Target from "@smthrs/targets/Target"

/**
 * Every target reachable inside one attr value, in encounter order.
 *
 * The walk reads own data descriptors only and refuses a class instance, so a
 * declaration cannot run user code by being inspected. A cycle is bounded by
 * the visited set. A target reached twice through two paths appears twice;
 * callers that want each target once collect into a `Set`.
 *
 * @category attrs
 * @since 0.1.0
 */
export const collectTargets = (value: unknown): ReadonlyArray<Target.AnyTarget> => {
  const found: Array<Target.AnyTarget> = []
  const seen = new Set<object>()
  const walk = (current: unknown): void => {
    if (Target.isTarget(current)) {
      found.push(current)
      return
    }
    if (typeof current !== "object" || current === null || seen.has(current)) return
    seen.add(current)
    if (Array.isArray(current)) {
      for (const entry of current) walk(entry)
      return
    }
    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== null) return
    for (const key of Object.getOwnPropertyNames(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor !== undefined && "value" in descriptor) walk(descriptor.value)
    }
  }
  walk(value)
  return found
}
