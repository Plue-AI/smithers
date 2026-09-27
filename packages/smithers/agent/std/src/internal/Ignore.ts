/**
 * Root-scoped gitignore rules, compiled once per visited directory.
 *
 * @since 1.0.0
 */

import { escapeRegex } from "./SearchContract.ts"

interface Rule {
  readonly expression: RegExp
  readonly directoryOnly: boolean
  readonly negated: boolean
  readonly byPath: boolean
}

/**
 * Rules belonging to one visited directory.
 *
 * @private
 * @since 1.0.0
 */
export interface Scope {
  readonly directory: string
  readonly rules: ReadonlyArray<Rule>
}

// Like the search glob contract, rg's globset matches UTF-8 bytes, not code points.
const bytes = (value: string): string =>
  /[^\x20-\x7e]/.test(value)
    ? Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join("")
    : value

// The caller-glob subset cannot parse ignore files: escapes and classes are
// intentionally refused there. Keep their richer grammar here, including rg's
// brace alternatives. Invalid lines are skipped without discarding valid rules.
const expression = (pattern: string): RegExp => {
  let source = ""
  const groups: Array<{ prefix: string; alternatives: Array<string> }> = []
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!
    if (character === "\\") {
      if (++index === pattern.length) throw new Error("dangling escape")
      source += escapeRegex(pattern[index]!)
    } else if (character === "[") {
      let end = index + 1
      const negated = pattern[end] === "!" || pattern[end] === "^"
      if (negated) end++
      if (pattern[end] === "]") end++
      end = pattern.indexOf("]", end)
      if (end < 0) source += "\\["
      else {
        const content = pattern.slice(index + (negated ? 2 : 1), end)
        source += `[${negated ? "^" : ""}${content.replace(/[\\[\]^]/g, "\\$&")}]`
        index = end
      }
    } else if (character === "{") {
      groups.push({ prefix: source, alternatives: [] })
      source = ""
    } else if (character === "," && groups.length > 0) {
      groups[groups.length - 1]!.alternatives.push(source)
      source = ""
    } else if (character === "}") {
      const group = groups.pop()
      if (group === undefined) throw new Error("unopened alternatives")
      const alternatives = [...group.alternatives, source].filter((part) => part.length > 0)
      source = group.prefix + (alternatives.length > 0 ? `(?:${alternatives.join("|")})` : "")
    } else if (
      character === "*" && pattern[index + 1] === "*" &&
      (index === 0 || "/{,".includes(pattern[index - 1]!)) &&
      (pattern[index + 2] === undefined || "/},".includes(pattern[index + 2]!))
    ) {
      source += pattern[index + 2] === "/" ? "(?:.*/)?" : ".*"
      index += pattern[index + 2] === "/" ? 2 : 1
    } else if (character === "*") source += "[^/]*"
    else if (character === "?") source += "[^/]"
    else source += escapeRegex(character)
  }
  if (groups.length > 0) throw new Error("unclosed alternatives")
  return new RegExp(`^(?:${source})$`)
}

/**
 * Parses gitignore lines without widening the caller-glob grammar.
 *
 * @private
 * @since 1.0.0
 */
export const parse = (directory: string, content: string): Scope => {
  const rules: Array<Rule> = []
  for (let line of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (line.startsWith("#")) continue
    // Match rg's gitignore parser: an escaped final space preserves whitespace.
    if (!line.endsWith("\\ ")) line = line.trimEnd()
    if (line.length === 0) continue
    const negated = line.startsWith("!")
    if (negated) line = line.slice(1)
    const rooted = line.startsWith("/")
    if (rooted) line = line.slice(1)
    const directoryOnly = line.endsWith("/")
    if (directoryOnly) line = line.slice(0, -1).replace(/\\$/, "")
    const byPath = rooted || line.includes("/")
    try {
      rules.push({ expression: expression(bytes(line)), negated, directoryOnly, byPath })
    } catch {
      // rg --no-messages also tolerates malformed rules and unreadable files.
    }
  }
  return { directory, rules }
}

/**
 * Tests an entry before descent; deeper scopes and later rules take priority.
 *
 * @private
 * @since 1.0.0
 */
export const ignored = (
  scopes: ReadonlyArray<Scope>,
  candidate: string,
  basename: string,
  directory: boolean,
  relative: (from: string, to: string) => string
): boolean => {
  // The nearest ignore file wins; within a file, the last matching line wins.
  for (let scopeIndex = scopes.length - 1; scopeIndex >= 0; scopeIndex--) {
    const scope = scopes[scopeIndex]!
    const scoped = bytes(relative(scope.directory, candidate))
    for (let index = scope.rules.length - 1; index >= 0; index--) {
      const rule = scope.rules[index]!
      if (rule.directoryOnly && !directory) continue
      if (rule.expression.test(rule.byPath ? scoped : bytes(basename))) return !rule.negated
    }
  }
  return false
}
