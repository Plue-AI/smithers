/**
 * The validation and matching rules every Search implementation shares.
 *
 * Both peers shipped here match globs through {@link includedByGlobs} and
 * canonicalize them through {@link canonicalGlob}, so the two implementations
 * cannot drift on what a pattern means, and an external peer binding its own
 * `Search` builds on the same functions. {@link unsatisfiableNotice} is the
 * shared explanation for empty answers caused by impossible globs or ignore
 * exclusions.
 *
 * @since 1.0.0
 */

import type * as Path from "@smthrs/kernel/Path"
import { Effect } from "effect"
import type * as FileSystem from "effect/FileSystem"
import * as LinearRegex from "./internal/LinearRegex.ts"
import { escapeRegex, invalidPattern, rejectionPrefix } from "./internal/SearchContract.ts"
import * as Walk from "./internal/Walk.ts"
import type * as StdError from "./StdError.ts"

/**
 * Validates Smithers Ripgrep ASCII v1. It is deliberately the intersection of
 * Rust regex and JavaScript RegExp: ASCII patterns, captures, alternation,
 * ASCII character classes and ordinary quantifiers. Lookaround,
 * backreferences, named/inline groups, Unicode/shorthand classes and control
 * escapes are rejected before either implementation runs. Patterns are
 * limited to 4096 bytes, counted repetitions to 1000, group nesting to 128
 * and expanded state machines to 8192 states. Both peers share this
 * compilation boundary; portable matching never backtracks over input.
 *
 * @category validation
 * @since 1.0.0
 */
export const validatePattern = (pattern: string, fixedStrings: boolean): StdError.StdError | undefined => {
  if (pattern.length > 4096) return invalidPattern(pattern, "patterns must not exceed 4096 bytes")
  if (!/^[\x20-\x7e]*$/.test(pattern)) return invalidPattern(pattern, "patterns must contain printable ASCII only")
  if (fixedStrings) return undefined
  if (pattern.includes("(?")) return invalidPattern(pattern, "special groups and lookaround are not supported")
  let inClass = false
  let classCharacters = 0
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    if (character === "\\") {
      const escaped = pattern[index + 1]
      if (escaped === undefined || /[A-Za-z0-9]/.test(escaped)) {
        return invalidPattern(pattern, "backreferences, shorthand classes and encoded escapes are not supported")
      }
      index++
      if (inClass) classCharacters++
      continue
    }
    if (character === "[" && inClass) {
      return invalidPattern(pattern, "nested and named character classes are not supported")
    }
    if (character === "[") {
      inClass = true
      classCharacters = 0
      continue
    }
    if (character === "{" && !inClass) {
      const closing = pattern.indexOf("}", index + 1)
      if (closing >= 0) {
        const counts = pattern.slice(index + 1, closing).split(",").filter((value) => value.length > 0)
        if (counts.some((value) => /^\d+$/.test(value) && Number(value) > 1000)) {
          return invalidPattern(pattern, "repetition counts above 1000 are not supported")
        }
      }
    }
    if (character === "]" && inClass) {
      if (classCharacters === 0 || (classCharacters === 1 && pattern[index - 1] === "^")) {
        return invalidPattern(pattern, "empty character classes are not supported")
      }
      inClass = false
      continue
    }
    if (inClass) {
      if (
        (character === "&" && pattern[index + 1] === "&") ||
        (character === "-" && pattern[index + 1] === "-") ||
        (character === "~" && pattern[index + 1] === "~")
      ) {
        return invalidPattern(pattern, "character-class set operations are not supported")
      }
      classCharacters++
    }
  }
  try {
    new RegExp(pattern, "u")
  } catch (error) {
    return invalidPattern(pattern, malformed(pattern) ?? engineReason(error))
  }
  try {
    LinearRegex.compile(pattern, false)
    return undefined
  } catch (error) {
    return invalidPattern(pattern, error instanceof Error ? error.message : "pattern compilation exceeds its budget")
  }
}

const countedRepetition = /^\{\d+(,\d*)?\}/

/**
 * Names the first construct that keeps `pattern` from parsing, with its
 * 1-based column and the escape that makes it literal.
 *
 * A caller told only that a pattern is unsupported guesses at which character
 * broke it; `Rule({` reads as a literal search to its author and as an unclosed
 * group plus a count with no digits to the parser. Only the syntax errors a
 * search author commonly makes are named here; anything else falls back to the
 * engine's own reason.
 */
const malformed = (pattern: string): string | undefined => {
  const open: Array<number> = []
  let repeatable = false
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!
    const at = `"${character}" at column ${index + 1}`
    if (character === "\\") {
      index++
      repeatable = true
      continue
    }
    if (character === "[") {
      let end = index + 1
      if (pattern[end] === "^") end++
      if (pattern[end] === "]") end++
      while (end < pattern.length && pattern[end] !== "]") end += pattern[end] === "\\" ? 2 : 1
      if (end >= pattern.length) return `${at} is never closed; write \\[ for a literal bracket`
      index = end
      repeatable = true
      continue
    }
    if (character === "(") {
      open.push(index)
      repeatable = false
      continue
    }
    if (character === ")") {
      if (open.pop() === undefined) return `${at} closes nothing; write \\) for a literal parenthesis`
      repeatable = true
      continue
    }
    if (character === "{") {
      const count = countedRepetition.exec(pattern.slice(index))
      if (count === null) return `${at} is not a repetition count; write \\{ for a literal brace`
      if (!repeatable) return `${at} repeats nothing; write \\{ for a literal brace`
      index += count[0].length - 1
      continue
    }
    if (character === "}" || character === "]") {
      return `${at} closes nothing; write \\${character} for a literal ${character === "}" ? "brace" : "bracket"}`
    }
    if (character === "*" || character === "+" || character === "?") {
      if (!repeatable) return `${at} repeats nothing; write \\${character} for a literal ${character}`
      continue
    }
    repeatable = character !== "|" && character !== "^" && character !== "$"
  }
  const unclosed = open.at(-1)
  return unclosed === undefined
    ? undefined
    : `"(" at column ${unclosed + 1} is never closed; write \\( for a literal parenthesis`
}

/** The JavaScript engine's reason, without its prefix or its echo of the pattern. */
const engineReason = (error: unknown): string => {
  const message = error instanceof Error ? error.message : ""
  const reason = message.replace(/^Invalid regular expression: (\/.*\/[a-z]*: )?/, "").trim()
  return reason === "" ? "invalid Smithers Ripgrep ASCII v1 expression" : `invalid expression: ${reason}`
}

/**
 * Whether `error` is a pattern or glob rejection this contract wrote.
 *
 * Those messages are host-authored and name the construct that broke, so a
 * caller may show them to a model. A peer's `invalid_pattern` built from
 * `rg`'s stderr is not one of them and stays private.
 *
 * @category validation
 * @since 1.0.0
 */
export const isContractRejection = (error: StdError.StdError): boolean =>
  error.code === "invalid_pattern" && error.message.startsWith(`${rejectionPrefix}"`)

/**
 * Validates the portable `-g` grammar before either peer sees it.
 *
 * @category validation
 * @since 1.0.0
 */
export const validateGlob = (glob: string): StdError.StdError | undefined => {
  const pattern = glob.startsWith("!") ? glob.slice(1) : glob
  // `rg` drops the trailing spaces and then ignores a glob that is left blank,
  // which filters nothing at all. Rejecting it keeps a typo from silently
  // widening the search instead of narrowing it.
  if (pattern.replace(/ +$/, "").length === 0) return invalidPattern(glob, "glob patterns must not be empty")
  if (!/^[\x20-\x7e]*$/.test(pattern)) return invalidPattern(glob, "globs must contain printable ASCII only")
  if (pattern.includes("\\") || pattern.includes("[") || pattern.includes("]")) {
    return invalidPattern(glob, "glob escapes and character classes are not supported")
  }
  let inBrace = false
  let alternatives = 1
  let expansionCount = 1
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    if (character === "{") {
      if (inBrace) return invalidPattern(glob, "nested brace alternatives are not supported")
      inBrace = true
      alternatives = 1
    } else if (character === "," && inBrace) {
      alternatives++
    } else if (character === "}") {
      if (!inBrace || alternatives < 2) return invalidPattern(glob, "braces must contain alternatives")
      inBrace = false
      expansionCount *= alternatives
      if (expansionCount > 256) return invalidPattern(glob, "glob brace expansion exceeds 256 patterns")
    }
  }
  if (inBrace) return invalidPattern(glob, "glob braces must be balanced")
  return undefined
}

/**
 * Compiles a pattern after common validation.
 *
 * @category matching
 * @since 1.0.0
 */
export const expression = (pattern: string, fixedStrings: boolean, insensitive: boolean): RegExp => {
  const input = fixedStrings ? escapeRegex(pattern) : pattern
  let source = ""
  let inClass = false
  for (let index = 0; index < input.length; index++) {
    const character = input[index]
    if (character === "\\") {
      source += `${character}${input[index + 1] ?? ""}`
      index++
    } else if (character === "[") {
      inClass = true
      source += character
    } else if (character === "]" && inClass) {
      inClass = false
      source += character
    } else if (!inClass && character === ".") {
      source += "[^\\n]"
    } else if (!inClass && character === "$") {
      source += "(?![\\s\\S])"
    } else {
      source += character
    }
  }
  return new RegExp(source, insensitive ? "iu" : "u")
}

const expandBraces = (pattern: string): ReadonlyArray<string> => {
  const opening = pattern.indexOf("{")
  if (opening < 0) return [pattern]
  const closing = pattern.indexOf("}", opening + 1)
  if (closing < 0) return [pattern]
  const alternatives = pattern.slice(opening + 1, closing).split(",")
  if (alternatives.length < 2) return [pattern]
  return alternatives.flatMap((alternative) =>
    expandBraces(
      `${pattern.slice(0, opening)}${alternative}${pattern.slice(closing + 1)}`
    )
  )
}

const globExpression = (pattern: string): RegExp => {
  let source = ""
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    const next = pattern[index + 1]
    if (
      character === "*" && next === "*" &&
      (index === 0 || pattern[index - 1] === "/") &&
      (pattern[index + 2] === undefined || pattern[index + 2] === "/")
    ) {
      source += pattern[index + 2] === "/" ? "(?:.*/)?" : ".*"
      index += pattern[index + 2] === "/" ? 2 : 1
    } else if (character === "*") source += "[^/]*"
    else if (character === "?") source += "[^/]"
    else source += character?.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&") ?? ""
  }
  return new RegExp(`^${source}$`)
}

const outsidePrintableAscii = /[^\x20-\x7e]/

// Printable ASCII is its own UTF-8 encoding, and paths are overwhelmingly
// printable ASCII, so the encoder only runs for the paths that need it.
const utf8ByteString = (value: string): string =>
  outsidePrintableAscii.test(value)
    ? Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join("")
    : value

/**
 * Rewrites a glob into the one spelling both peers match against.
 *
 * `.` is never a path component either peer can produce, so a leading `./` and
 * every interior `/./` would silently make a pattern unmatchable. Both are
 * folded into the root anchor, which is what a caller writing `./src/**` means.
 * Trailing spaces are dropped because `rg` reads `-g` by gitignore's rules and
 * drops them too, so `"a.ts "` finds `a.ts` in the native peer and has to find
 * it in the in-process one. A leading `!` is preserved so exclusion globs
 * canonicalize the same way.
 *
 * @category matching
 * @since 1.0.0
 */
export const canonicalGlob = (glob: string): string => {
  const excluded = glob.startsWith("!")
  const pattern = excluded ? glob.slice(1) : glob
  const canonical = pattern.replace(/ +$/, "").replace(/\/\.(?=\/)/g, "").replace(/^\.\//, "/")
  return excluded ? `!${canonical}` : canonical
}

interface CompiledGlob {
  readonly byPath: boolean
  readonly expression: RegExp
}

const compiled = new Map<string, ReadonlyArray<CompiledGlob>>()

/**
 * Compiles one glob into its alternatives, once per distinct pattern.
 *
 * The in-process peer asks whether a pattern matches for every candidate file
 * in the walk, so canonicalizing, brace expanding and compiling the pattern
 * inside that loop makes the work quadratic in the tree. A pattern compiles to
 * the same matchers every time, so the compilation is cached; the cache is
 * bounded because callers, not the tree, supply the patterns.
 */
const compileGlob = (pattern: string): ReadonlyArray<CompiledGlob> => {
  const cached = compiled.get(pattern)
  if (cached !== undefined) return cached
  const matchers = expandBraces(canonicalGlob(pattern)).map((expanded) => {
    const rooted = expanded.startsWith("/")
    const normalized = rooted ? expanded.slice(1) : expanded
    return { byPath: rooted || normalized.includes("/"), expression: globExpression(normalized) }
  })
  if (compiled.size >= 256) compiled.clear()
  compiled.set(pattern, matchers)
  return matchers
}

/**
 * Matches the supported `-g` subset against a root-relative candidate path.
 *
 * A pattern without `/` matches the basename at any depth. Every other pattern
 * is matched against the candidate's path relative to the search root, anchored
 * at the root, whether or not it carries the optional leading `/`.
 *
 * @category matching
 * @since 1.0.0
 */
export const matchesGlob = (pattern: string, relative: string, basename: string): boolean =>
  compileGlob(pattern).some((matcher) => matcher.expression.test(utf8ByteString(matcher.byPath ? relative : basename)))

/**
 * Applies ripgrep `-g` ordering: positive globs include and `!` globs exclude.
 *
 * @category matching
 * @since 1.0.0
 */
export const includedByGlobs = (globs: ReadonlyArray<string>, relative: string, basename: string): boolean => {
  const positives = globs.filter((glob) => !glob.startsWith("!"))
  let included = positives.length === 0
  for (const glob of globs) {
    const excluded = glob.startsWith("!")
    if (matchesGlob(excluded ? glob.slice(1) : glob, relative, basename)) included = !excluded
  }
  return included
}

const wildcard = /[*?{}]/

const literalDirectory = (pattern: string): ReadonlyArray<string> => {
  if (!pattern.includes("/")) return []
  const segments = pattern.replace(/^\//, "").split("/").filter((segment) => segment.length > 0)
  const wildcardAt = segments.findIndex((segment) => wildcard.test(segment))
  return wildcardAt < 0 ? segments.slice(0, -1) : segments.slice(0, wildcardAt)
}

const rootRelativeSuffix = (pattern: string, root: string, path: Path.Path): string | undefined => {
  const anchored = pattern.replace(/^\/+/, "")
  const patternRoot = path.sep === "\\" ? root.replaceAll("\\", "/") : root
  const stem = patternRoot.replace(/^\/+/, "").replace(/\/+$/, "")
  return stem.length > 0 && anchored.startsWith(`${stem}/`) ? anchored.slice(stem.length + 1) : undefined
}

const unsatisfiedReason = (
  options: {
    readonly fileSystem: FileSystem.FileSystem
    readonly path: Path.Path
    readonly root: string
    readonly hidden: boolean
  },
  pattern: string
): Effect.Effect<string | undefined> =>
  Effect.gen(function*() {
    const reasons: Array<string> = []
    for (const alternative of expandBraces(pattern)) {
      const segments = literalDirectory(alternative)
      if (segments.length === 0) return undefined
      const skipped = segments.find((segment) => Walk.skippedDirectories.has(segment))
      if (skipped !== undefined) {
        reasons.push(`${skipped} is never descended into; name it as the search root to look inside it`)
        continue
      }
      if (!options.hidden && segments.some((segment) => segment.startsWith("."))) {
        reasons.push("hidden paths are excluded unless hidden is true")
        continue
      }
      const directory = segments.join("/")
      const present = yield* options.fileSystem.stat(options.path.join(options.root, directory)).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false)
      )
      if (present) return undefined
      reasons.push(`there is no ${directory} directory there`)
    }
    return reasons[0]
  })

/**
 * Explains the positive globs that no file under the root could ever match.
 *
 * A search that returns nothing is ambiguous: the tree may hold no match, or
 * the pattern may be unsatisfiable — an absolute path written where a
 * root-relative one belongs, a directory that does not exist, a skipped
 * directory, a hidden path with `hidden` left false. Callers attach the result
 * to `notice` when they produced no entries. Ignore exclusions name the
 * `noIgnore: true` escape hatch, while impossible globs explain the correction.
 * This keeps the cases
 * distinguishable. Exclusion globs are ignored: excluding what is not there
 * changes nothing.
 *
 * @category diagnostics
 * @since 1.0.0
 */
export const unsatisfiableNotice = (options: {
  readonly fileSystem: FileSystem.FileSystem
  readonly path: Path.Path
  readonly root: string
  readonly globs: ReadonlyArray<string>
  readonly noIgnore?: boolean | undefined
  readonly ignored?: boolean | undefined
  readonly hidden: boolean
}): Effect.Effect<string | undefined> =>
  Effect.gen(function*() {
    // Globs filter a walk. A root that names one file is searched whatever the
    // globs say — `rg` always searches a path given on the command line — so
    // there is no unsatisfiable pattern to report and no directory to stat.
    const walkable = yield* options.fileSystem.stat(options.root).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false)
    )
    if (!walkable) return undefined
    const sentences: Array<string> = []
    for (const glob of options.globs) {
      if (glob.startsWith("!")) continue
      const canonical = canonicalGlob(glob)
      const reason = yield* unsatisfiedReason(options, canonical)
      if (reason === undefined) continue
      const suffix = rootRelativeSuffix(canonical, options.root, options.path)
      sentences.push(
        `No file under ${options.root} can match "${glob}": ${
          suffix === undefined
            ? reason
            : `glob patterns are relative to the search root, so use "${suffix}" instead`
        }.`
      )
    }
    // An impossible glob cannot be repaired by opting out of ignores.
    if (sentences.length > 0 && sentences.length === options.globs.filter((glob) => !glob.startsWith("!")).length) {
      return sentences.join(" ")
    }
    const included = (relative: string, basename: string) => includedByGlobs(options.globs, relative, basename)
    const ignored = options.noIgnore ? false : options.ignored ??
      (yield* Walk.files(options.fileSystem, options.path, options.root, options.hidden, false, included).pipe(
        Effect.map((walked) => walked.ignored),
        Effect.orElseSucceed(() => false)
      ))
    if (ignored) {
      sentences.push("No results; ignore files excluded paths. Retry with noIgnore: true to include them.")
    }
    return sentences.length === 0 ? undefined : sentences.join(" ")
  })
