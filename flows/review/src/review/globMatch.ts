function expandBraces(pattern: string): Array<string> {
  const open = pattern.indexOf("{")
  if (open < 0) return [pattern]
  const close = pattern.indexOf("}", open + 1)
  if (close < 0) return [pattern]
  const prefix = pattern.slice(0, open)
  const suffix = pattern.slice(close + 1)
  return pattern
    .slice(open + 1, close)
    .split(",")
    .flatMap((option) => expandBraces(prefix + option + suffix))
}

function escapeRegex(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
}

function globToRegExp(pattern: string) {
  let out = "^"
  for (let i = 0; i < pattern.length;) {
    if (pattern.slice(i, i + 3) === "**/") {
      out += "(?:.*/)?"
      i += 3
      continue
    }
    if (pattern.slice(i, i + 2) === "**") {
      out += ".*"
      i += 2
      continue
    }
    if (pattern[i] === "*") {
      out += "[^/]*"
      i += 1
      continue
    }
    out += escapeRegex(pattern[i]!)
    i += 1
  }
  out += "$"
  return new RegExp(out)
}

/**
 * Matches a path against one include or exclude glob, brace expansion
 * included.
 *
 * @since 1.0.0
 * @category predicates
 */
export function globMatch(pattern: string, path: string) {
  return expandBraces(pattern).some((expanded) => globToRegExp(expanded).test(path))
}
