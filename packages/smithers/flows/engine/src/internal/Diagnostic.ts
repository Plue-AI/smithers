/**
 * Renders an arbitrary failure value as one bounded, redacted diagnostic
 * string. The engine writes it to the log line that names an undeclared
 * failure, and the flow proxy logs it in place of the defect it dies with, so
 * a secret an implementation error carries never reaches a log file or a
 * remote caller verbatim.
 *
 * @since 1.0.0
 */

import * as Redaction from "@smthrs/journal/Redaction"

/**
 * A body failure rendered for one log line, bounded so an oversized payload
 * cannot flood the log the operator is reading it from.
 *
 * @private
 */
const diagnosticTextLimit = 512

/**
 * How much of one string is read before it is redacted.
 *
 * Redaction runs on the value before the {@link diagnosticTextLimit} bound, so
 * a quoted credential or a private key the bound would cut in half is seen
 * whole. This window only caps the regex work on a hostile multi-megabyte
 * message: everything past it is dropped, never rendered.
 *
 * @private
 */
const redactionWindow = 64 * 1024

/**
 * Whether a value is a proxy, where the runtime can say without asking the
 * proxy: `util.types.isProxy` on Node and Bun. Reading even a descriptor off a
 * proxy runs its trap, which is caller code. A runtime without the check
 * falls back to descriptor reads, whose traps can at most throw into the
 * constant fallback.
 */
const isProxy: (value: object) => boolean = (() => {
  const util = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
    ?.getBuiltinModule?.("node:util") as { types?: { isProxy?: (value: unknown) => boolean } } | undefined
  return util?.types?.isProxy ?? (() => false)
})()

const primitiveDiagnostic = (value: unknown): unknown => {
  switch (typeof value) {
    case "string":
      return value.slice(0, redactionWindow)
    case "number":
      return Number.isFinite(value) ? value : `[${value > 0 ? "+" : "-"}non-finite number]`
    case "boolean":
      return value
    case "undefined":
      return "[undefined]"
    case "bigint":
      return `[bigint:${value.toString().slice(0, 64)}]`
    case "symbol":
      return "[symbol]"
    case "function":
      return "[function]"
    case "object":
      return value === null ? null : undefined
  }
}

const diagnosticKeys = [
  "_tag",
  "code",
  "name",
  "message",
  "value",
  "error",
  "cause",
  "failures",
  "reasons",
  "token",
  "secret",
  "password",
  "apiKey",
  "~effect/Effect/args"
] as const

const projectDiagnostic = (
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  field?: string
): unknown => {
  if (field !== undefined && Redaction.isSensitiveKey(field)) return Redaction.placeholder
  const primitive = primitiveDiagnostic(value)
  if (primitive !== undefined || value === undefined) {
    return primitive
  }
  if (depth === 0) return "[object]"
  const object = value as object
  if (isProxy(object)) return "[proxy]"
  if (seen.has(object)) return "[circular]"
  seen.add(object)
  if (Array.isArray(object)) {
    // Every Array exotic has one non-configurable numeric length data property;
    // reading its descriptor does not invoke a Proxy `get` trap or user code.
    const length = Object.getOwnPropertyDescriptor(object, "length")!.value as number
    const output: Array<unknown> = []
    const limit = Math.min(length, 8)
    for (let index = 0; index < limit; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(object, String(index))
      output.push(
        descriptor !== undefined && "value" in descriptor
          ? projectDiagnostic(descriptor.value, depth - 1, seen)
          : "[missing]"
      )
    }
    if (length > limit) output.push(`[${length - limit} more]`)
    return output
  }
  const output: Record<string, unknown> = {}
  for (const key of diagnosticKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (descriptor === undefined || !("value" in descriptor)) continue
    output[key] = projectDiagnostic(descriptor.value, depth - 1, seen, key)
  }
  return Object.keys(output).length === 0 ? "[object]" : output
}

/** Bounds every string of an already redacted projection. */
const boundDiagnostic = (value: unknown): unknown =>
  typeof value === "string"
    ? value.slice(0, diagnosticTextLimit)
    : Array.isArray(value)
    ? value.map(boundDiagnostic)
    : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).map(([key, field]) => [key, boundDiagnostic(field)]))
    : value

/**
 * Renders only a fixed diagnostic vocabulary from inert own data properties.
 * It never enumerates an arbitrary object, invokes an accessor, calls a user
 * coercion hook, or retains an unbounded value. A hostile proxy can at most
 * make the renderer return the constant fallback.
 *
 * @private
 * @since 1.0.0
 */
export const renderDiagnostic = (value: unknown): string => {
  try {
    // The projection is plain data this module built, so redacting it runs no
    // caller code. It is redacted whole, then bounded, never the other way.
    const redacted = boundDiagnostic(Redaction.redactDiagnostic(projectDiagnostic(value, 5, new WeakSet())))
    return (typeof redacted === "string" ? redacted : JSON.stringify(redacted)).slice(0, 4096)
  } catch {
    return "[unrenderable]"
  }
}
