/**
 * Faithful port of Codex CLI output truncation.
 *
 * Mirrors `codex-rs/utils/string/src/truncate.rs` and
 * `codex-rs/utils/output-truncation/src/lib.rs`: middle truncation on UTF-8
 * boundaries with a `…{n} tokens truncated…` marker and a 4-bytes-per-token
 * estimate, so ChatGPT-family models see the exact shapes they were
 * posttrained on.
 *
 * @since 1.0.0
 */

const APPROX_BYTES_PER_TOKEN = 4

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * UTF-8 byte length of a string.
 *
 * @since 1.0.0
 * @private
 */
export const byteLength = (text: string): number => encoder.encode(text).byteLength

/**
 * Approximate token count: ceil(utf8Bytes / 4).
 *
 * @since 1.0.0
 * @private
 */
export const approxTokenCount = (text: string): number =>
  Math.floor((byteLength(text) + APPROX_BYTES_PER_TOKEN - 1) / APPROX_BYTES_PER_TOKEN)

/**
 * Approximate byte budget for a token budget.
 *
 * @since 1.0.0
 * @private
 */
export const approxBytesForTokens = (tokens: number): number => tokens * APPROX_BYTES_PER_TOKEN

/**
 * Approximate tokens represented by a byte count: ceil(bytes / 4).
 *
 * @since 1.0.0
 * @private
 */
export const approxTokensFromByteCount = (bytes: number): number =>
  Math.floor((bytes + APPROX_BYTES_PER_TOKEN - 1) / APPROX_BYTES_PER_TOKEN)

const formatTruncationMarker = (useTokens: boolean, removedCount: number): string =>
  useTokens ? `…${removedCount} tokens truncated…` : `…${removedCount} chars truncated…`

interface Split {
  readonly removedChars: number
  readonly before: string
  readonly after: string
}

/** A UTF-8 continuation byte is `10xxxxxx`; every other byte starts a character. */
const isContinuation = (byte: number): boolean => (byte & 0b1100_0000) === 0b1000_0000

/** The last character boundary at or before `offset`. */
const boundaryAtOrBefore = (bytes: Uint8Array, offset: number): number => {
  let at = Math.min(offset, bytes.byteLength)
  while (at > 0 && at < bytes.byteLength && isContinuation(bytes[at]!)) at--
  return at
}

/** The first character boundary at or after `offset`. */
const boundaryAtOrAfter = (bytes: Uint8Array, offset: number): number => {
  let at = Math.max(offset, 0)
  while (at < bytes.byteLength && isContinuation(bytes[at]!)) at++
  return at
}

/**
 * Splits `s` into the head that fits `beginningBytes` and the tail that fits
 * `endBytes`, both cut on UTF-8 character boundaries, and counts the characters
 * dropped between them.
 *
 * The boundaries are read off the encoded bytes rather than by re-encoding one
 * character at a time: a per-character `TextEncoder.encode` costs about two
 * microseconds, which is nineteen seconds for the eight megabytes a bounded
 * capture can hand this function.
 */
const splitString = (s: string, beginningBytes: number, endBytes: number): Split => {
  const bytes = encoder.encode(s)
  const tailStartTarget = Math.max(bytes.byteLength - endBytes, 0)
  const prefixEnd = boundaryAtOrBefore(bytes, beginningBytes)
  const suffixStart = boundaryAtOrAfter(bytes, Math.max(tailStartTarget, prefixEnd))
  let removedChars = 0
  for (let at = prefixEnd; at < suffixStart; at++) if (!isContinuation(bytes[at]!)) removedChars++
  return {
    removedChars,
    before: decoder.decode(bytes.subarray(0, prefixEnd)),
    after: decoder.decode(bytes.subarray(suffixStart))
  }
}

const truncateWithByteEstimate = (s: string, maxBytes: number, useTokens: boolean): string => {
  if (s === "") return ""
  const totalBytes = byteLength(s)
  if (maxBytes === 0) {
    return formatTruncationMarker(useTokens, useTokens ? approxTokensFromByteCount(totalBytes) : [...s].length)
  }
  if (totalBytes <= maxBytes) return s
  const leftBudget = Math.floor(maxBytes / 2)
  const rightBudget = maxBytes - leftBudget
  const { after, before, removedChars } = splitString(s, leftBudget, rightBudget)
  const marker = formatTruncationMarker(
    useTokens,
    useTokens ? approxTokensFromByteCount(Math.max(totalBytes - maxBytes, 0)) : removedChars
  )
  return `${before}${marker}${after}`
}

/**
 * Middle-truncate to a byte budget with a char-count marker.
 *
 * @since 1.0.0
 * @private
 */
export const truncateMiddleChars = (s: string, maxBytes: number): string => truncateWithByteEstimate(s, maxBytes, false)

/**
 * Middle-truncate to an approximate token budget, preserving the beginning
 * and end. Returns the possibly truncated string and the original token
 * count when truncation occurred.
 *
 * @since 1.0.0
 * @private
 */
export const truncateMiddleWithTokenBudget = (
  s: string,
  maxTokens: number
): { readonly text: string; readonly originalTokenCount: number | undefined } => {
  if (s === "") return { text: "", originalTokenCount: undefined }
  if (maxTokens > 0 && byteLength(s) <= approxBytesForTokens(maxTokens)) {
    return { text: s, originalTokenCount: undefined }
  }
  const truncated = truncateWithByteEstimate(s, approxBytesForTokens(maxTokens), true)
  if (truncated === s) return { text: s, originalTokenCount: undefined }
  return { text: truncated, originalTokenCount: approxTokenCount(s) }
}

const countLines = (content: string): number => {
  if (content === "") return 0
  const parts = content.split("\n")
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length
}

/**
 * Codex `format_exec_output_for_model`: exit code, wall time, optional line
 * count disclosure, then the (possibly middle-truncated) output.
 *
 * @since 1.0.0
 * @private
 */
export const formatExecOutputForModel = (options: {
  readonly output: string
  readonly exitCode: number
  readonly durationSeconds: number
  readonly maxOutputTokens: number
  readonly timedOutAfterMs?: number | undefined
}): string => {
  const content = options.timedOutAfterMs === undefined
    ? options.output
    : `command timed out after ${options.timedOutAfterMs} milliseconds\n${options.output}`
  const durationSeconds = Math.round(options.durationSeconds * 10) / 10
  const totalLines = countLines(content)
  const formatted = truncateMiddleWithTokenBudget(content, options.maxOutputTokens).text
  const sections = [
    `Exit code: ${options.exitCode}`,
    `Wall time: ${durationSeconds} seconds`
  ]
  if (totalLines !== countLines(formatted)) sections.push(`Total output lines: ${totalLines}`)
  sections.push("Output:")
  sections.push(formatted)
  return sections.join("\n")
}
