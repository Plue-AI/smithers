/** File-flow argument parsing for client command adapters.
 * @since 0.1.0
 */

/**
 * `/flow <name>` arguments, as `smthrs up` reads them: a JSON object, other
 * JSON as `{data}`, or `key=value` tokens where a bare token is `true`.
 */
export const parseArgs = (
  text: string
): { readonly input: Record<string, unknown> } | { readonly error: string } => {
  const trimmed = text.trim()
  if (trimmed === "") return { input: {} }
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\"")) {
    try {
      const decoded = JSON.parse(trimmed) as unknown
      return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
        ? { input: decoded as Record<string, unknown> }
        : { input: { data: decoded } }
    } catch {
      return { error: "Invalid JSON" }
    }
  }
  const tokens: Array<string> = []
  let token = ""
  let quote: "'" | "\"" | undefined
  let started = false
  for (let index = 0; index < trimmed.length; index++) {
    const character = trimmed[index]!
    if (character === "\\" && quote !== "'") {
      const next = trimmed[index + 1]
      if (next === undefined) return { error: "Trailing escape" }
      // Preserve ordinary path backslashes; only syntax needs escaping.
      if (next === "\\" || next === "\"" || next === "'" || /\s/.test(next)) {
        token += next
        index++
      } else token += character
      started = true
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined
      else token += character
    } else if (character === "\"" || character === "'") {
      quote = character
      started = true
    } else if (/\s/.test(character)) {
      if (started) tokens.push(token)
      token = ""
      started = false
    } else {
      token += character
      started = true
    }
  }
  if (quote !== undefined) return { error: "Unclosed quote" }
  if (started) tokens.push(token)
  return {
    input: Object.fromEntries(tokens.map((token) => {
      const separator = token.indexOf("=")
      return separator < 1 ? [token, true] : [token.slice(0, separator), token.slice(separator + 1)]
    }))
  }
}

