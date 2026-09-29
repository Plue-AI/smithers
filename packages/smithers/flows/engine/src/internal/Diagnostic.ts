/**
 * Renders an arbitrary failure value as one bounded, redacted diagnostic
 * string. The engine writes it to the log line that names an undeclared
 * failure, and the flow proxy logs it in place of the defect it dies with, so
 * a secret an implementation error carries never reaches a log file or a
 * remote caller verbatim.
 *
 * @since 1.0.0
 */

/**
 * A body failure rendered for one log line, bounded so an oversized payload
 * cannot flood the log the operator is reading it from.
 *
 * @private
 */
const diagnosticTextLimit = 512

/**
 * Field names whose value is a credential, in a message (`name=value`,
 * `"name":"value"`) or as an own property of a rendered failure.
 *
 * @private
 */
const secretName = "token|secret|password|api[-_]?key|credential|private[-_]?key"

const secretField = new RegExp(secretName, "i")

// Consume complete quoted values, including escaped JSON strings. If the
// bounded diagnostic ends inside a quote, redact through the end of the text.
const redactCredentialValues = (text: string): string => {
  const keys = new RegExp(`(?:${secretName})["'\\\\]*\\s*[=:]\\s*`, "gi")
  let output = ""
  let position = 0
  for (let match = keys.exec(text); match !== null; match = keys.exec(text)) {
    let start = keys.lastIndex
    const escaped = text[start] === "\\" && (text[start + 1] === '"' || text[start + 1] === "'")
    if (escaped) start++
    const quote = text[start] === '"' || text[start] === "'" ? text[start] : undefined
    let end = start
    if (quote !== undefined) {
      end++
      while (end < text.length) {
        if (text[end] === quote) {
          let slashes = 0
          for (let i = end - 1; i > start && text[i] === "\\"; i--) slashes++
          if (slashes % 4 === (escaped ? 1 : 0)) break
        }
        end++
      }
      if (end < text.length) end++
    } else {
      while (end < text.length && !/[\s,;"'\\]/.test(text[end]!)) end++
    }
    output += text.slice(position, keys.lastIndex) + (escaped ? "\\" : "") +
      (quote ?? "") + "[REDACTED]" +
      (quote !== undefined && text[end - 1] === quote ? (escaped ? "\\" : "") + quote : "")
    position = end
    keys.lastIndex = end
  }
  return output + text.slice(position)
}

const sanitizeDiagnosticText = (value: string): string =>
  redactCredentialValues(value.slice(0, diagnosticTextLimit)
    // An authorization or cookie header value is a credential whatever its
    // scheme (`Basic`, `Token`, a cookie list), so the rest of the header is
    // dropped up to the end of the line or the quote that closes it.
    .replace(
      /((?:proxy-)?authorization|(?:set-)?cookies?)(["'\\]*\s*[=:]\s*["'\\]*)[^\r\n"'\\]+/gi,
      "$1$2[REDACTED]"
    )
    .replace(/((?:bearer|basic)\s+)[^\s,;"'\\]+/gi, "$1[REDACTED]")
    // A request URL carries credentials as userinfo or as a signed query.
    .replace(/(\/\/)[^/@\s"'\\]+@/g, "$1[REDACTED]@")
    .replace(/([?&][\w.-]*(?:key|sig|signature|auth|credential)=)[^&#\s"'\\]+/gi, "$1[REDACTED]")
  )

const primitiveDiagnostic = (value: unknown): unknown => {
  switch (typeof value) {
    case "string":
      return sanitizeDiagnosticText(value)
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
  if (field !== undefined && secretField.test(field)) return "[REDACTED]"
  const primitive = primitiveDiagnostic(value)
  if (primitive !== undefined || value === undefined) {
    return primitive
  }
  if (depth === 0) return "[object]"
  const object = value as object
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
    const projected = projectDiagnostic(value, 5, new WeakSet())
    return (typeof projected === "string" ? projected : JSON.stringify(projected)).slice(0, 4096)
  } catch {
    return "[unrenderable]"
  }
}
