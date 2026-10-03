/**
 * Shared text paging, numbering, and byte-budget helpers.
 *
 * Every limit here is a display budget, not a policy limit: exceeding one is
 * always disclosed to the model rather than silently applied.
 *
 * @since 1.0.0
 */

/**
 * Default number of lines or entries returned by a paged flow.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_READ_LIMIT = 2_000

/**
 * Maximum number of directory entries or glob paths returned in one call.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_ENTRIES = 1_000

/**
 * Maximum number of grep matches returned in one call.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_GREP_MATCHES = 200

/**
 * Maximum number of Unicode scalar values displayed for a single line.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_LINE_CHARS = 2_000

/**
 * Maximum UTF-8 byte budget for one rendered text payload.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_OUTPUT_BYTES = 60_000

/**
 * Maximum UTF-8 byte budget captured per shell output stream.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_SHELL_OUTPUT_BYTES = 30_000

/**
 * A byte-budgeted rendering of a text value.
 *
 * @category models
 * @since 1.0.0
 */
export interface Truncation {
  readonly text: string
  readonly truncated: boolean
  readonly keptBytes: number
  readonly droppedBytes: number
}

/**
 * One page of source lines.
 *
 * @category models
 * @since 1.0.0
 */
export interface Page {
  readonly lines: ReadonlyArray<string>
  readonly startLine: number
  readonly endLine: number
  readonly totalLines: number
}

const encoder = new TextEncoder()
const fatalDecoder = new TextDecoder("utf-8", { fatal: true })

/**
 * Trims a string to a UTF-8 byte budget without splitting a code point.
 *
 * `keep: "head"` retains the beginning of the value; `keep: "tail"` retains
 * the end, which is what shell output needs because the interesting part of an
 * overflowing stream is almost always its last lines.
 *
 * @category rendering
 * @since 1.0.0
 */
export const truncateBytes = (
  text: string,
  maxBytes: number,
  options: { readonly keep: "head" | "tail" }
): Truncation => {
  const bytes = encoder.encode(text)
  if (bytes.byteLength <= maxBytes) {
    return { text, truncated: false, keptBytes: bytes.byteLength, droppedBytes: 0 }
  }
  let start = options.keep === "head" ? 0 : bytes.byteLength - maxBytes
  let end = options.keep === "head" ? maxBytes : bytes.byteLength
  // TextEncoder produces valid UTF-8. Moving a cut inward reaches a scalar
  // boundary after at most three continuation bytes, so decoding must succeed.
  while (true) {
    try {
      const decoded = fatalDecoder.decode(bytes.subarray(start, end))
      const keptBytes = end - start
      return {
        text: decoded,
        truncated: true,
        keptBytes,
        droppedBytes: bytes.byteLength - keptBytes
      }
    } catch {
      if (options.keep === "head") end--
      else start++
    }
  }
}

/**
 * Splits on LF without counting a terminal LF as a line.
 * Carriage returns remain part of each line, including the CR in CRLF, so
 * joining a page with LF preserves its bytes except for the final LF.
 *
 * @category parsing
 * @since 1.0.0
 */
export const sourceLines = (text: string): ReadonlyArray<string> => {
  const lines = text.length === 0 ? [] : text.split("\n")
  if (text.endsWith("\n")) lines.pop()
  return lines
}

/**
 * Selects a 1-based page of lines from a text value.
 *
 * @category paging
 * @since 1.0.0
 */
export const slice = (
  text: string,
  options: { readonly offset: number; readonly limit: number }
): Page => {
  const lines = sourceLines(text)
  const totalLines = lines.length
  const startLine = Math.max(1, options.offset)
  const endLine = Math.min(totalLines, startLine + Math.max(0, options.limit) - 1)
  return {
    lines: lines.slice(startLine - 1, endLine),
    startLine,
    endLine,
    totalLines
  }
}

/**
 * Renders the disclosure appended whenever output was capped.
 *
 * @category rendering
 * @since 1.0.0
 */
export const notice = (unit: string, shown: number, total: number): string =>
  `Showing ${shown} of ${total} ${unit}; output was truncated.`
