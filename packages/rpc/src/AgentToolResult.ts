/**
 * Bounds on what one agent tool result spends of the next model request,
 * shared by every tool loop.
 * @since 1.0.0
 */

/**
 * A single tool result must not consume most of the next request.
 * @since 1.0.0
 * @category constants
 */
export const MAX_TOOL_RESULT_BYTES = 16 * 1024

/**
 * The most lines one tool result keeps.
 * @since 1.0.0
 * @category constants
 */
export const MAX_TOOL_RESULT_LINES = 1_000

/**
 * The most model legs one agent turn runs; a turn still calling tools after them ends at the tool limit.
 * @since 1.0.0
 * @category constants
 */
export const MAX_TOOL_LEGS = 8

const encoder = new TextEncoder()

/**
 * The UTF-8 byte length of a string.
 * @since 1.0.0
 * @category utilities
 */
export const utf8Bytes = (text: string): number => encoder.encode(text).byteLength

const byteSafePrefix = (text: string, maxBytes: number): string => {
  if (maxBytes <= 0) return ""
  const bytes = encoder.encode(text)
  if (bytes.byteLength <= maxBytes) return text
  return new TextDecoder().decode(bytes.slice(0, maxBytes))
}

/**
 * A tool result as the model receives it, with the size of the whole.
 * @since 1.0.0
 * @category models
 */
export interface BoundedToolResult {
  readonly modelOutput: string
  readonly truncated: boolean
  readonly totalBytes: number
  readonly totalLines: number
}

/**
 * Bound opaque tool output by both lines and UTF-8 bytes. Keep the head because
 * command results put their status/discriminator first, and append an explicit
 * marker so the model can never mistake partial evidence for the full result.
 * @since 1.0.0
 * @category utilities
 */
export const boundToolResult = (
  result: string,
  maxBytes = MAX_TOOL_RESULT_BYTES,
  maxLines = MAX_TOOL_RESULT_LINES
): BoundedToolResult => {
  const totalBytes = utf8Bytes(result)
  const lines = result.split("\n")
  const totalLines = lines.length
  if (totalBytes <= maxBytes && totalLines <= maxLines) {
    return { modelOutput: result, truncated: false, totalBytes, totalLines }
  }
  const marker = `\n\n[Tool result truncated: ${totalBytes} bytes, ${totalLines} lines total.]`
  const contentBudget = Math.max(0, maxBytes - utf8Bytes(marker))
  const lineLimited = lines.slice(0, maxLines).join("\n")
  const prefix = byteSafePrefix(lineLimited, contentBudget).replace(/\uFFFD$/u, "")
  return {
    modelOutput: `${prefix}${marker}`,
    truncated: true,
    totalBytes,
    totalLines
  }
}
