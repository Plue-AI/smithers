/*
 * Size limits for outgoing turns and function_call_output items are applied in
 * controller/turns.ts. Full tool results remain in the store.
 * Transcript preparation remains in that controller. The unused summary and
 * compaction-slice API was removed; requests drop older messages with a notice
 * instead of using a stored compaction summary.
 */
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"

/**
 * The backend turn route's body cap (packages/backend middleware.MaxRequestBodySize,
 * 1 MiB), less framing headroom.
 */
export const MAX_TURN_REQUEST_BYTES = 1024 * 1024 - 4 * 1024
/** A single tool result must not consume most of the next request. */
export const MAX_TOOL_RESULT_BYTES = 16 * 1024
export const MAX_TOOL_RESULT_LINES = 1_000

const encoder = new TextEncoder()

export const utf8Bytes = (text: string): number => encoder.encode(text).byteLength

export const turnRequestBytes = (request: StartAgentTurnRequest): number => utf8Bytes(JSON.stringify(request))

const byteSafePrefix = (text: string, maxBytes: number): string => {
  if (maxBytes <= 0) return ""
  const bytes = encoder.encode(text)
  if (bytes.byteLength <= maxBytes) return text
  return new TextDecoder().decode(bytes.slice(0, maxBytes))
}

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

/**
 * The line that stands where dropped history was.
 *
 * Never silent: a model that is missing the start of a conversation must know
 * it is missing it, or it will answer confidently about words it never saw.
 */
export const droppedHistoryNotice = (dropped: number): string =>
  `[${dropped} earlier message${dropped === 1 ? "" : "s"} in this conversation ${
    dropped === 1 ? "was" : "were"
  } dropped to fit this turn's size limit. If the user refers to something from before, say you may no longer have it rather than guessing.]`

export interface BoundedTurnRequest {
  readonly request: StartAgentTurnRequest
  /** How many messages were dropped from the head, zero when the turn already fit. */
  readonly dropped: number
}

/**
 * Bound one turn request to the boundary's body limit (§4.13).
 *
 * The client re-sent the whole transcript on every turn, so seven long answers
 * pushed `POST /api/agent/turn` past the upstream body limit and the
 * conversation was then permanently dead: every later turn failed the same
 * way, and `/clear` could not recover it because `/clear` runs a model turn of
 * its own and hit the same wall. The only escape was clearing the origin's
 * storage from outside the app.
 *
 * So the oldest messages are dropped until the request fits, and a notice
 * takes their place. `keepTail` is the count of trailing messages that must
 * survive — the user's own prompt, and the function_call/function_call_output
 * pairs of a tool leg, which are meaningless split apart.
 */
export const boundTurnRequest = (
  full: StartAgentTurnRequest,
  keepTail = 1,
  maxBytes = MAX_TURN_REQUEST_BYTES
): BoundedTurnRequest => {
  const request = full
  const messages = request.messages
  const floor = Math.min(Math.max(keepTail, 1), messages.length)
  if (messages.length <= floor) return { request, dropped: 0 }
  const candidateOf = (dropped: number): StartAgentTurnRequest => ({
    ...request,
    messages: [{ role: "user", content: droppedHistoryNotice(dropped) }, ...messages.slice(dropped)]
  })
  /*
   * Measure each message once. A candidate's body is the request with an
   * empty message list, plus every kept item, plus one comma per boundary:
   * the notice, then the surviving suffix. Suffix sums make each candidate a
   * constant-time question, so a long history costs one pass, not one full
   * re-serialization per dropped message.
   */
  const envelopeBytes = turnRequestBytes({ ...request, messages: [] })
  const suffixBytes = new Array<number>(messages.length + 1).fill(0)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    suffixBytes[index] = (suffixBytes[index + 1] ?? 0) + utf8Bytes(JSON.stringify(messages[index]))
  }
  const requestBytes = envelopeBytes + (suffixBytes[0] ?? 0) + messages.length - 1
  if (requestBytes <= maxBytes) return { request, dropped: 0 }
  const candidateBytes = (dropped: number): number => {
    const kept = messages.length - dropped
    const notice = utf8Bytes(JSON.stringify({ role: "user", content: droppedHistoryNotice(dropped) }))
    return envelopeBytes + notice + (suffixBytes[dropped] ?? 0) + kept
  }
  let dropped = 0
  while (messages.length - dropped > floor) {
    dropped += 1
    if (candidateBytes(dropped) <= maxBytes) return { request: candidateOf(dropped), dropped }
  }
  // Even the tail alone is over the limit: the seam refuses it honestly, and
  // dropping the user's own words to hide that would be the worse answer.
  return { request: dropped === 0 ? request : candidateOf(dropped), dropped }
}
