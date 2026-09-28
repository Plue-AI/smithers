/**
 * The one control-character rule every trust boundary in this package shares.
 *
 * A control character in a name corrupts a Markdown report and a CI log line:
 * a newline lets the value print its own line, which on GitHub Actions is a
 * workflow command the runner executes, an ESC or a C1 CSI (U+009B) sequence
 * rewrites the visible log, and a Unicode bidirectional control reorders what
 * a reader sees. Values an author declares (suite and case names, baseline
 * suites and records) are rejected where they enter the system; values a
 * target returns at runtime (step keys, failure messages) are flattened
 * instead, so a broken target stays a readable failure rather than a rejected
 * run.
 *
 * The rule covers C0 controls (U+0000 through U+001F), DEL (U+007F), C1
 * controls (U+0080 through U+009F), and the bidirectional controls U+061C,
 * U+200E, U+200F, U+202A through U+202E, and U+2066 through U+2069.
 *
 * @since 0.1.0
 */

/**
 * Whether one code point falls under the control-character rule.
 *
 * @since 0.1.0
 * @private
 */
export const isControlCodePoint = (code: number): boolean =>
  code < 0x20 ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x061c ||
  code === 0x200e ||
  code === 0x200f ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069)

/**
 * Names the first control character in `value`, or `undefined` when there is
 * none.
 *
 * @since 0.1.0
 * @private
 */
export const controlCharacter = (value: string): string | undefined => {
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (isControlCodePoint(code)) return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`
  }
  return undefined
}

/**
 * Replaces every control character with a space, the way a report cell does,
 * so a hostile string cannot emit its own log line, terminal escape, or
 * reordered text.
 *
 * @since 0.1.0
 * @private
 */
export const flattenControlCharacters = (value: string): string => {
  if (controlCharacter(value) === undefined) return value
  let flattened = ""
  for (const character of value) {
    flattened += isControlCodePoint(character.codePointAt(0)!) ? " " : character
  }
  return flattened
}
