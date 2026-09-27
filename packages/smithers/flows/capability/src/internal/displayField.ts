/**
 * Display escaping and truncation shared by `formatError` and
 * `toPlatformError`.
 *
 * @since 0.1.0
 */

import { maxDisplayFieldLength } from "../maxDisplayFieldLength.ts"

const truncationMarker = "…[truncated]"

const displayChunk = (unit: string): string => {
  if (unit === "\n") {
    return "\\n"
  }
  if (unit === "\r") {
    return "\\r"
  }
  if (unit === "\t") {
    return "\\t"
  }
  // Encode each UTF-16 code unit so astral format characters also use
  // complete \uXXXX escapes, kept together by displayField's chunk budget.
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(unit)
    ? unit.split("").map((part) => `\\u${part.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`).join("")
    : unit
}

/**
 * @since 0.1.0
 * @private
 */
export const displayField = (value: string): string => {
  const chunks: Array<string> = []
  let length = 0
  let truncated = false
  for (const unit of value) {
    const chunk = displayChunk(unit)
    if (length + chunk.length > maxDisplayFieldLength) {
      truncated = true
      break
    }
    chunks.push(chunk)
    length += chunk.length
  }
  if (!truncated) {
    return chunks.join("")
  }
  const contentLength = maxDisplayFieldLength - truncationMarker.length
  while (length > contentLength) {
    length -= chunks.pop()!.length
  }
  return `${chunks.join("")}${truncationMarker}`
}
