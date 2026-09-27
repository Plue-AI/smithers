/**
 * The segments a compaction may replace.
 *
 * A window's system and instruction segments are what the next turn is still
 * addressed to, so only the conversational kinds are eligible. `ContextWindow`
 * selects the prefix and `Compaction` declares one against the same selection;
 * two spellings of this filter that drifted would let a declared prefix name
 * segments the window would never replace.
 *
 * @since 1.0.0-rc.0
 * @private
 */

import type * as ContextWindow from "../ContextWindow.ts"

/**
 * The tokens the compaction trigger leaves free below the context window.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const defaultReserve = 16_000

/**
 * The tokens of recent segments a compaction keeps whole.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const defaultKeepRecent = 20_000

/**
 * The transcript, summary and steering segments of a window, in order.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const compactable = (
  segments: ReadonlyArray<ContextWindow.Segment>
): ReadonlyArray<ContextWindow.Segment> =>
  segments.filter((segment) =>
    segment.kind === "transcript" || segment.kind === "summary" || segment.kind === "steering"
  )

/**
 * The boundaries a cut may not fall on: every boundary between a tool call
 * and its result, when the two sit in different segments of `segments`.
 * Boundary `b` lies between `segments[b - 1]` and `segments[b]`.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const pairBoundaries = (segments: ReadonlyArray<ContextWindow.Segment>): ReadonlySet<number> => {
  const calls = new Map<string, number>()
  const results = new Map<string, number>()
  for (const [index, segment] of segments.entries()) {
    for (const item of segment.content) {
      if ("role" in item && item.role === "assistant") {
        for (const part of item.content) {
          if (part.type === "tool-call") calls.set(part.id, index)
        }
      } else if ("role" in item && item.role === "tool") {
        for (const part of item.content) results.set(part.toolCallId, index)
      }
    }
  }
  const unsafe = new Set<number>()
  for (const [callId, callIndex] of calls) {
    const resultIndex = results.get(callId)
    if (resultIndex === undefined) continue
    const first = Math.min(callIndex, resultIndex)
    const last = Math.max(callIndex, resultIndex)
    for (let boundary = first + 1; boundary <= last; boundary++) unsafe.add(boundary)
  }
  return unsafe
}
