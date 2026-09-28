/**
 * The provider-neutral machine ceilings.
 *
 * @since 0.1.0
 */

/**
 * The CPU, memory, and lifetime ceilings of a provisioned machine.
 *
 * `cpus` is a CPU count and may be fractional where the provider allows it;
 * `memoryMib` is a memory ceiling in MiB; `timeoutSecs` is the machine's
 * maximum lifetime in seconds, counted from creation, after which the provider
 * stops or destroys it. An idle timeout is not a lifetime and never satisfies
 * `timeoutSecs`.
 *
 * A provider forwards each ceiling to its own mechanism or refuses it when
 * `make` is called, before any machine exists; it never accepts a ceiling it
 * cannot enforce.
 *
 * @category models
 * @since 0.1.0
 */
export interface ResourceLimits {
  readonly cpus?: number | undefined
  readonly memoryMib?: number | undefined
  readonly timeoutSecs?: number | undefined
}

/**
 * Checks that every set ceiling is a positive finite number, and that
 * `memoryMib` and `timeoutSecs` are whole, throwing otherwise, and returns the
 * limits.
 *
 * @category validation
 * @since 0.1.0
 */
export const validateResourceLimits = (provider: string, limits: ResourceLimits): ResourceLimits => {
  if (typeof limits !== "object" || limits === null) {
    throw new TypeError(`${provider}: limits must be { cpus?, memoryMib?, timeoutSecs? }`)
  }
  const positive = (name: keyof ResourceLimits, whole: boolean) => {
    const value = limits[name]
    if (value === undefined) return
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (whole && !Number.isInteger(value))) {
      throw new TypeError(
        `${provider}: limits.${name} must be a positive ${whole ? "integer" : "number"}: ${String(value)}`
      )
    }
  }
  positive("cpus", false)
  positive("memoryMib", true)
  positive("timeoutSecs", true)
  return limits
}

/**
 * Refuses the named ceilings, for a provider that cannot enforce them, and
 * validates the rest.
 *
 * @category validation
 * @since 0.1.0
 */
export const refuseResourceLimits = (
  provider: string,
  limits: ResourceLimits | undefined,
  refused: ReadonlyArray<keyof ResourceLimits>,
  reason: string
): ResourceLimits | undefined => {
  if (limits === undefined) return undefined
  validateResourceLimits(provider, limits)
  for (const name of refused) {
    if (limits[name] !== undefined) {
      throw new TypeError(`${provider}: cannot enforce limits.${name}; ${reason}`)
    }
  }
  return limits
}
