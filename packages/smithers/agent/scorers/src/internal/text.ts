/**
 * UTF-8 byte measurement and truncation for the durable observation path.
 *
 * Every string this package persists carries a documented byte bound, so the
 * measurement has to be the one the bound is written in: `String.length`
 * counts UTF-16 units and disagrees with the stored size for any non-ASCII
 * text.
 *
 * @since 0.1.0
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Returns the UTF-8 byte length of `text`.
 *
 * @category measuring
 * @since 0.1.0
 */
export const byteLength = (text: string): number => encoder.encode(text).length

/**
 * Truncates `text` to at most `maxBytes` UTF-8 bytes.
 *
 * `TextEncoder.encodeInto` stops on a code-point boundary, so the result is
 * always well-formed: a truncated surrogate pair or multi-byte sequence would
 * be stored as replacement characters and read back as corruption.
 *
 * @category converting
 * @since 0.1.0
 */
export const truncate = (text: string, maxBytes: number): string => {
  const buffer = new Uint8Array(maxBytes)
  const { read, written } = encoder.encodeInto(text, buffer)
  return read === text.length ? text : decoder.decode(buffer.subarray(0, written))
}
