/**
 * Side-effect-free rendering of values that cross a failure boundary.
 *
 * A rejected promise may carry any JavaScript value. Calling `String` on an
 * object, reading an accessor-backed `message`, or inspecting a Proxy can run
 * arbitrary user code while the original failure is being reported. These
 * helpers accept only primitives and own data properties, bound the resulting
 * text, and otherwise use a caller-owned fallback.
 *
 * @since 0.1.0
 */

import * as NodeUtil from "node:util/types"

/**
 * Maximum UTF-16 code units admitted into one rendered failure.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maximumMessageCodeUnits = 64 * 1024

const bounded = (message: string, fallback: string): string => {
  const wellFormed = message.isWellFormed() ? message : message.toWellFormed()
  if (wellFormed === "") return fallback
  return wellFormed.length <= maximumMessageCodeUnits
    ? wellFormed
    : `${wellFormed.slice(0, maximumMessageCodeUnits - 3)}...`
}

/**
 * Renders a rejected value without invoking object-owned behavior.
 *
 * @category rendering
 * @since 0.1.0
 * @slop
 */
export const message = (cause: unknown, fallback = "operation failed"): string => {
  if (typeof cause === "string") return bounded(cause, fallback)
  if (
    typeof cause === "number" ||
    typeof cause === "bigint" ||
    typeof cause === "boolean" ||
    typeof cause === "symbol"
  ) return bounded(String(cause), fallback)
  if ((typeof cause !== "object" && typeof cause !== "function") || cause === null || NodeUtil.isProxy(cause)) {
    return fallback
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(cause, "message")
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? bounded(descriptor.value, fallback)
      : fallback
  } catch {
    return fallback
  }
}

/**
 * Renders a rejected value, reading an accessor-backed `message` when a native
 * Error carries none as an own data property.
 *
 * {@link message} never runs code the rejected value owns, which is the right
 * posture at a boundary that hands back an arbitrary value. It also renders
 * nothing for the errors Effect raises: `SchemaError` and the `Data.TaggedError`
 * family define `message` as a prototype accessor, so a failure carrying a full
 * decode diagnostic rendered as the caller's fallback and the reason was lost.
 *
 * A target failure is produced by code this CLI already evaluates and runs, so
 * this renderer invokes that accessor. It admits only a string, bounds the
 * result exactly as {@link message} does, refuses a Proxy, and answers with the
 * fallback if the accessor throws.
 *
 * @category rendering
 * @since 0.1.0
 * @slop
 */
export const describe = (cause: unknown, fallback = "operation failed"): string => {
  const rendered = message(cause, "")
  if (rendered !== "") return rendered
  if (!NodeUtil.isNativeError(cause) || NodeUtil.isProxy(cause)) return fallback
  try {
    const text: unknown = cause.message
    return typeof text === "string" ? bounded(text, fallback) : fallback
  } catch {
    return fallback
  }
}

/**
 * The one sentence an operator sees for a failure build-cli did not design.
 *
 * @category constants
 * @since 1.0.0
 */
export const unknownFailure = "Something went wrong on our side. Not your fault."

const ownString = (value: object, key: string): string | undefined => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a rejection carries a sentence build-cli designed: a tagged error,
 * or a plain `Error` this CLI threw. Runtime bugs (`TypeError` and friends),
 * Node system errors, and non-Error values are not.
 */
const designed = (cause: unknown): cause is Error => {
  if (!NodeUtil.isNativeError(cause) || NodeUtil.isProxy(cause)) return false
  if (ownString(cause, "_tag") !== undefined) return true
  return Object.getPrototypeOf(cause) === Error.prototype && ownString(cause, "syscall") === undefined
}

/**
 * Renders a failure for the CLI operator: a designed sentence as written,
 * anything else as {@link unknownFailure}. `verbose` appends the raw message,
 * never a stack.
 *
 * @category rendering
 * @since 1.0.0
 */
export const present = (cause: unknown, options: { readonly verbose: boolean }): string => {
  if (designed(cause)) {
    const rendered = describe(cause, "")
    if (rendered !== "") return rendered
  }
  if (!options.verbose) return unknownFailure
  const detail = describe(cause, "")
  return detail === "" ? unknownFailure : `${unknownFailure}\n${detail}`
}

/**
 * Converts an arbitrary rejection into an Error whose message is safe to read.
 * Standard Errors with a bounded own data message retain their original stack.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const error = (cause: unknown, fallback = "operation failed"): Error => {
  if (typeof cause === "object" && cause !== null && !NodeUtil.isProxy(cause)) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(cause, "message")
      if (
        NodeUtil.isNativeError(cause) &&
        descriptor !== undefined &&
        "value" in descriptor &&
        typeof descriptor.value === "string" &&
        descriptor.value !== "" &&
        descriptor.value.isWellFormed() &&
        descriptor.value.length <= maximumMessageCodeUnits
      ) return cause
    } catch {
      // Wrap below with the caller-owned fallback.
    }
  }
  return new Error(message(cause, fallback), { cause })
}
