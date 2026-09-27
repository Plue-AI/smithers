/**
 * Honest shortening.
 *
 * Every place this harness puts bytes in front of a model is bounded, and every
 * one of those bounds used to be spelled the same way: slice, append `…`, move
 * on. A model reading that cannot tell a value that ends in an ellipsis from a
 * value that was cut, cannot tell how much it lost, and — the expensive part —
 * cannot tell how to get the rest back, so it buys the same bytes again. Three
 * of the five most expensive instances of the r90 wave spent real money
 * re-fetching a region the run had already rendered and silently clipped
 * (`pydata__xarray-7229` $0.76, `sphinx-doc__sphinx-8721` $0.36,
 * `pytest-dev__pytest-6197` $0.19).
 *
 * So a shortened value states three things: that it was shortened, how many
 * bytes are missing, and the id that brings them back. The id is a sentence the
 * caller supplies, because only the caller knows whether the thing is a state
 * key (`render`), a settled call (`recall`), or something the model must fetch
 * again.
 *
 * @since 0.1.0
 * @private
 * @slop
 */

import * as bytes from "./bytes.ts"

/**
 * The first `limit` UTF-8 bytes of `text`, stopping before a code point that
 * would cross the bound.
 *
 * UTF-8 bytes and UTF-16 indexes do not share boundaries for multibyte text, so
 * a cut may keep fewer bytes than the caller offered. Every bound here is a
 * ceiling: giving bytes back is allowed; taking one is not. Walking by code
 * point also subsumes the surrogate-pair guarantee — no half of an astral
 * character can survive on either side of a cut.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const headSlice = (text: string, limit: number): string => bytes.headSlice(text, limit)

/**
 * The last `limit` UTF-8 bytes of `text`, starting on a code-point boundary.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const tailSlice = (text: string, limit: number): string => bytes.tailSlice(text, limit)

/**
 * Shortens an already-shortened text from the middle, counting against the
 * whole it came from.
 *
 * A value can be bounded twice: once where the host copies it out of the
 * sandbox, and again where the frame apportions its print budget across the
 * statements that share it. Counting the second reduction against what survived
 * the first would report a value as smaller than it is — the exact dishonesty
 * this module exists to abolish — so `whole` is stated by the caller, which is
 * the only place that still knows it, and the notice always names the original
 * size.
 *
 * `text` must be the head and tail of the original, in order: every reduction
 * here keeps both ends, so slicing the ends of a reduced value is the same as
 * slicing the ends of the value it came from.
 *
 * The count is what the two ends actually left behind rather than `whole -
 * limit`, because a cut that stopped before a multibyte code point can keep
 * fewer bytes than the limit allowed and the notice names the real number.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const middleFrom = (text: string, whole: number, limit: number, recall: string): string => {
  if (whole <= limit) return text
  const edge = Math.floor(limit / 2)
  const head = headSlice(text, edge)
  const tail = tailSlice(text, edge)
  return `${head}\n… ${
    whole - bytes.size(head) - bytes.size(tail)
  } of ${whole} bytes elided from the middle. ${recall} …\n${tail}`
}

/**
 * The most one {@link middleFrom} notice can cost, for a value of this size.
 *
 * A caller apportioning one budget across several values has to reserve the
 * notices before it can hand out the rest, or it hands out bytes the notices
 * then take back and something downstream cuts the notice in half. The bound is
 * exact: the dropped count is never larger than the whole, so the notice for a
 * value shortened to nothing is the longest notice that value can produce.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const noticeCost = (whole: number, recall: string): number => bytes.size(middleFrom("", whole, 0, recall))

/**
 * Shortens text from the middle, keeping both ends.
 *
 * The two ends are where a file excerpt, a diff, or a test log identifies
 * itself; the middle is where the repetition is. `recall` is the sentence that
 * says how to see what was dropped.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const middle = (text: string, limit: number, recall: string): string =>
  middleFrom(text, bytes.size(text), limit, recall)

/**
 * Shortens text from the end, keeping the head.
 *
 * Used for the one-line summaries a ledger prints, where the head is the whole
 * of what identifies the line and the tail is detail.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const head = (text: string, limit: number, recall: string): string => {
  const whole = bytes.size(text)
  if (whole <= limit) return text
  const kept = headSlice(text, limit)
  return `${kept}… [+${whole - bytes.size(kept)}b, ${recall}]`
}
