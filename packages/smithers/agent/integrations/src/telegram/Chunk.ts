/**
 * Message chunking at Telegram's hard `sendMessage` limit.
 *
 * Telegram rejects a message over 4096 characters outright, so long output has
 * to be split. Splitting at the limit alone cuts words in half; this splits at
 * the last paragraph break, line break, sentence end, or word boundary that
 * fits, and cuts mid-word only when a single unbroken run is longer than the
 * limit.
 *
 * A cut never lands inside a UTF-16 surrogate pair. The limit is measured in
 * code units, because that is what Telegram counts, but a boundary that would
 * separate the halves of an astral character steps back one unit: the
 * alternative is two chunks that both render as a replacement character, which
 * is what happens to any message over the limit whose boundary falls on an
 * emoji.
 *
 * @since 1.0.0
 */

import { SmithersError } from "@smthrs/errors/SmithersError"

/**
 * Telegram's maximum `sendMessage` text length.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_MESSAGE_LENGTH = 4096

/**
 * How many characters to take into the current chunk, or `-1` when no
 * acceptable boundary exists and the caller must cut at the limit.
 *
 * A boundary inside the first tenth of the window is rejected: one early
 * period would otherwise produce a chunk of three words followed by a chunk of
 * four thousand characters.
 */
const findSplitIndex = (text: string, limit: number): number => {
  const window = text.slice(0, limit + 1)
  const minIndex = Math.floor(limit / 10)
  const paragraph = window.lastIndexOf("\n\n")
  if (paragraph > minIndex) return paragraph
  const line = window.lastIndexOf("\n")
  if (line > minIndex) return line
  let sentence = -1
  for (const match of window.matchAll(/[.!?]["')\]]?\s/g)) {
    const end = match.index + match[0].length
    if (end <= limit) sentence = end
  }
  if (sentence > minIndex) return sentence
  const space = window.lastIndexOf(" ")
  if (space > minIndex) return space
  return -1
}

/** Whether cutting `text` at `index` would split a surrogate pair. */
const splitsSurrogatePair = (text: string, index: number): boolean => {
  // `chunk` calls this only while `1 <= index < text.length`.
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)
  return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF
}

/**
 * Splits `text` into chunks of at most `maxLength` characters.
 *
 * Chunks are trimmed of the whitespace they were split on, and an empty chunk
 * is never emitted. Every chunk is at least one character long, so the walk
 * always terminates. The one case that exceeds `maxLength` is a `maxLength` of
 * 1 meeting an astral character, which is two code units and is kept whole.
 *
 * Throws a `SmithersError` with code `INVALID_INPUT` when `maxLength` is not
 * an integer between 1 and {@link MAX_MESSAGE_LENGTH}. A limit of zero used to
 * spin forever: the loop condition stayed true, no character was consumed, and
 * the event loop never yielded again.
 *
 * @category constructors
 * @since 1.0.0
 */
export const chunk = (text: string, maxLength: number = MAX_MESSAGE_LENGTH): ReadonlyArray<string> => {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > MAX_MESSAGE_LENGTH) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Telegram chunk maxLength must be an integer between 1 and ${MAX_MESSAGE_LENGTH}.`,
      { maxLength }
    )
  }
  const chunks: Array<string> = []
  if (text.length === 0) return chunks
  let remaining = text
  while (remaining.length > maxLength) {
    const splitAt = findSplitIndex(remaining, maxLength)
    let take = splitAt > 0 ? splitAt : maxLength
    // Never leave a lone high surrogate at the end of one chunk and a lone low
    // surrogate at the start of the next: Telegram renders both as replacement
    // characters. Stepping back keeps the pair whole; at a limit of one, where
    // there is nothing to step back to, step forward instead, so the walk
    // always consumes at least one code unit.
    if (splitsSurrogatePair(remaining, take)) take = take > 1 ? take - 1 : take + 1
    const piece = remaining.slice(0, take).replace(/\s+$/, "")
    if (piece.length > 0) chunks.push(piece)
    remaining = remaining.slice(take).replace(/^\s+/, "")
  }
  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}
