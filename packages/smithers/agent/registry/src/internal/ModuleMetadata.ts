/**
 * Metadata extraction from a discovered flow module: its description, its
 * declared schemas, and the effect envelope inferred from what it calls.
 *
 * @since 0.1.0
 */

import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { type EffectDeclaration, ModelSelection, type Placement } from "../Descriptor.ts"
import { conservativeEffects, narrowDelegation, projectEffects, unprojectableDelegation } from "./Authority.ts"

/**
 * @since 0.1.0
 * @private
 */
export interface MetadataWarning {
  readonly line?: number
  readonly message: string
}

/**
 * @since 0.1.0
 * @private
 */
export interface Metadata {
  readonly description: string | undefined
  readonly hasInput: boolean
  readonly inputDocument?: Schema.Json
  readonly hasOutput: boolean
  readonly model: Option.Option<ModelSelection>
  readonly flows: ReadonlyArray<string>
  readonly capabilities: ReadonlyArray<string>
  readonly effects: EffectDeclaration
  readonly placement: Option.Option<Placement>
  readonly modelInvocable: boolean
  readonly declaresName: boolean
  /**
   * The name the module declares, when it is a readable string literal.
   *
   * `None` covers both a module that declares none and one whose name is an
   * expression this reader cannot evaluate, which is why {@link declaresName}
   * is a separate answer: a name that is present but unreadable cannot be
   * checked against the path, and a caller that must decide treats it as a
   * name it has to warn about rather than as no name at all.
   */
  readonly declaredName: Option.Option<string>
  readonly warnings: ReadonlyArray<MetadataWarning>
}

interface FlowObject {
  readonly start: number
  readonly end: number
}

/**
 * One lexical token of module source.
 *
 * An identifier's `value` is its name with every `\u` escape decoded, so
 * `requir\u0065` reads as the `require` binding it is. `escaped` marks such
 * a name: an escaped name is never a keyword. A private name keeps its `#`.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @private
 */
export interface Token {
  readonly kind: "identifier" | "number" | "punctuation" | "regex" | "string" | "unparsed"
  readonly value: string
  readonly start: number
  readonly end: number
  readonly escaped?: true
}

const skipQuoted = (source: string, start: number): number => {
  const quote = source[start]
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === "\\") {
      index++
      continue
    }
    if (source[index] === quote) {
      return index
    }
  }
  return source.length - 1
}

const skipLineComment = (source: string, start: number): number => {
  const end = /[\n\r\u2028\u2029]/.exec(source.slice(start + 2))?.index
  return end === undefined ? source.length - 1 : start + 2 + end
}

const skipBlockComment = (source: string, start: number): number => {
  const end = source.indexOf("*/", start + 2)
  return end === -1 ? source.length - 1 : end + 1
}

const skipTrivia = (source: string, start: number): number => {
  let index = start
  while (index < source.length) {
    const character = source[index]!
    const next = source[index + 1]
    if (character === "\uFEFF" || /\s/.test(character)) {
      index++
      continue
    }
    if (character === "/" && next === "/") {
      index = skipLineComment(source, index) + 1
      continue
    }
    if (character === "/" && next === "*") {
      index = skipBlockComment(source, index) + 1
      continue
    }
    return index
  }
  return index
}

/**
 * The keywords a regular expression may follow, rather than a division.
 *
 * `break`, `continue` and `debugger` are here because a `/` after one of them
 * on the same line is a syntax error, so a `/` that follows one can only begin
 * a regular expression on the next line, after automatic semicolon insertion.
 */
const regexPrecedingKeywords = new Set([
  "await",
  "break",
  "case",
  "continue",
  "debugger",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "return",
  "throw",
  "typeof",
  "void",
  "yield"
])

/** The punctuation a regular expression may follow, rather than a division. */
const regexPrecedingPunctuation = new Set(
  ["(", "[", "{", ",", ":", ";", "=", "!", "?", "&", "|", "+", "-", "*", "%", "^", "~", "<", ">"]
)

/** The statements a label may follow. */
const labelKeywords = new Set(["break", "continue"])

/** The statements whose parenthesized head is followed by a statement, never by an operator. */
const conditionKeywords = new Set(["if", "while", "for", "with"])

/**
 * How {@link tokenize} reads a `/` whose meaning the tokens before it do not
 * settle.
 *
 * Two places are ambiguous to a lexer. A `/` that starts a line after a name,
 * a literal, `)` or `]` is a division in JavaScript, but begins a regular
 * expression after a TypeScript type annotation (`let x: string` then a line
 * starting `/re/`). A `/` after `}` begins a regular expression after a block
 * and is a division after an object literal. `"likely"` reads the first as a
 * division and the second as a regular expression; `"alternate"` reads each
 * the other way. A reader that must not miss code reads both.
 *
 * @category parsing
 * @since 1.0.0
 * @private
 */
export type SlashReading = "likely" | "alternate"

interface Context {
  readonly previous: Token | undefined
  readonly beforePrevious: Token | undefined
  readonly beforeThat: Token | undefined
  /** Whether a line terminator separates the previous token from this one. */
  readonly lineBreak: boolean
  /** Whether the previous token is the `)` closing an `if`, `while`, `for` or `with` head. */
  readonly closesCondition: boolean
  readonly reading: SlashReading
}

/** The context of a module's first token. */
const start: Context = {
  previous: undefined,
  beforePrevious: undefined,
  beforeThat: undefined,
  lineBreak: false,
  closesCondition: false,
  reading: "likely"
}

/** Whether a name token is a property or private name (`a.return`, `#return`) rather than a keyword. */
const isPropertyName = (token: Token, before: Token | undefined): boolean =>
  token.value.startsWith("#") || (before?.kind === "punctuation" && before.value === ".")

const isKeyword = (token: Token | undefined, before: Token | undefined, keywords: ReadonlySet<string>): boolean =>
  token?.kind === "identifier" && token.escaped === undefined && keywords.has(token.value) &&
  !isPropertyName(token, before)

const canStartRegex = (context: Context): boolean => {
  const { beforePrevious, previous } = context
  if (previous === undefined) {
    return true
  }
  const ambiguousAfterOperand = context.lineBreak && context.reading === "alternate"
  if (previous.kind === "identifier") {
    if (isKeyword(previous, beforePrevious, regexPrecedingKeywords)) {
      return true
    }
    // `break label` and `continue label` end their statement: what follows
    // them on the next line starts a new one.
    if (!isPropertyName(previous, beforePrevious) && isKeyword(beforePrevious, context.beforeThat, labelKeywords)) {
      return true
    }
    return ambiguousAfterOperand
  }
  if (previous.kind !== "punctuation") {
    return ambiguousAfterOperand
  }
  // `a++ / b` divides: `++` or `--` directly before a `/` is always postfix.
  if (
    (previous.value === "+" || previous.value === "-") &&
    beforePrevious?.value === previous.value && beforePrevious.end === previous.start
  ) {
    return false
  }
  if (previous.value === ")") {
    return context.closesCondition || ambiguousAfterOperand
  }
  if (previous.value === "]") {
    return ambiguousAfterOperand
  }
  if (previous.value === "}") {
    return context.reading === "likely"
  }
  return regexPrecedingPunctuation.has(previous.value)
}
const skipRegex = (source: string, start: number): number => {
  let inCharacterClass = false
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index]
    if (character === "\\") {
      index++
      continue
    }
    if (character === "[") {
      inCharacterClass = true
      continue
    }
    if (character === "]") {
      inCharacterClass = false
      continue
    }
    if (character === "/" && !inCharacterClass) {
      while (/[A-Za-z]/.test(source[index + 1] ?? "")) {
        index++
      }
      return index
    }
  }
  return source.length - 1
}

const identifierStart = /[\p{ID_Start}$_]/u
const identifierPart = /[\p{ID_Continue}$\u200C\u200D]/u

/**
 * The code point a `\u` escape at `index` names and the index after it, or
 * `undefined` when no escape starts there.
 */
const unicodeEscape = (source: string, index: number): { readonly code: number; readonly end: number } | undefined => {
  if (source[index] !== "\\" || source[index + 1] !== "u") {
    return undefined
  }
  const braced = /^\{([0-9A-Fa-f]{1,6})\}/.exec(source.slice(index + 2, index + 10))
  if (braced !== null) {
    const code = Number.parseInt(braced[1]!, 16)
    return code <= 0x10FFFF ? { code, end: index + 2 + braced[0].length } : undefined
  }
  const fixed = /^[0-9A-Fa-f]{4}/.exec(source.slice(index + 2, index + 6))
  return fixed === null ? undefined : { code: Number.parseInt(fixed[0], 16), end: index + 6 }
}

/**
 * The name at `index`, as {@link Token} spells it, or `undefined` when no name
 * starts there. Names are Unicode (`ID_Start`, `ID_Continue`), may carry `\u`
 * escapes, and a private name starts with `#`.
 */
const readName = (source: string, index: number): Token | undefined => {
  let end = index
  let value = ""
  let escaped = false
  if (source[end] === "#") {
    value = "#"
    end++
  }
  for (;;) {
    const escape = unicodeEscape(source, end)
    const code = escape?.code ?? source.codePointAt(end)
    if (code === undefined) {
      break
    }
    const character = String.fromCodePoint(code)
    const first = end === index || (value === "#" && end === index + 1)
    if (!(first ? identifierStart : identifierPart).test(character)) {
      break
    }
    value += character
    if (escape === undefined) {
      end += character.length
    } else {
      escaped = true
      end = escape.end
    }
  }
  if (value === "" || value === "#") {
    return undefined
  }
  return { kind: "identifier", value, start: index, end, ...(escaped ? { escaped: true as const } : {}) }
}

const nextToken = (source: string, start: number, context: (index: number) => Context): Token | undefined => {
  const index = skipTrivia(source, start)
  if (index >= source.length) {
    return undefined
  }

  const character = source[index]!
  const name = readName(source, index)
  if (name !== undefined) {
    return name
  }
  if (/[0-9]/.test(character)) {
    let end = index + 1
    while (/[A-Za-z0-9_.]/.test(source[end] ?? "")) {
      end++
    }
    return { kind: "number", value: source.slice(index, end), start: index, end }
  }
  if (character === "\"" || character === "'" || character === "`") {
    const end = skipQuoted(source, index) + 1
    return { kind: "string", value: source.slice(index, end), start: index, end }
  }
  if (character === "/" && canStartRegex(context(index))) {
    const end = skipRegex(source, index) + 1
    return { kind: "regex", value: source.slice(index, end), start: index, end }
  }

  return { kind: "punctuation", value: character, start: index, end: index + 1 }
}

/** Reads template text only; executable substitutions are tokenized by the caller. */
const templateChunk = (source: string, start: number, opening: boolean) => {
  for (let index = start + (opening ? 1 : 0); index < source.length; index++) {
    if (source[index] === "\\") {
      index++
    } else if (source[index] === "`") {
      return { end: index + 1, interpolation: false, closed: true }
    } else if (source[index] === "$" && source[index + 1] === "{") {
      return { end: index + 2, interpolation: true, closed: false }
    }
  }
  return { end: source.length, interpolation: false, closed: false }
}

/**
 * Splits module source into tokens, skipping strings, comments, and regular
 * expressions.
 *
 * Exported so {@link module:ModuleClosure} reads import specifiers with the
 * same lexer this module reads declarations with. A second scanner would be a
 * second answer to "is this `import` real code or a word inside a comment",
 * and the two would drift. `reading` says how a `/` the tokens cannot settle
 * is read; see {@link SlashReading}.
 *
 * @category parsing
 * @since 1.0.0-rc.0
 * @private
 */
export const tokenize = (source: string, reading: SlashReading = "likely"): ReadonlyArray<Token> => {
  const tokens: Array<Token> = []
  // One entry per open `(`: whether it opens an `if`, `while`, `for` or `with` head.
  const heads: Array<boolean> = []
  let closesCondition = false
  let offset = 0
  // Iterative frames bound nesting without recursing on authored source.
  const templates: Array<{ expression: boolean; braces: number }> = []
  const context = (index: number): Context => {
    const previous = tokens.at(-1)
    return {
      previous,
      beforePrevious: tokens.at(-2),
      beforeThat: tokens.at(-3),
      lineBreak: previous !== undefined && /[\n\r\u2028\u2029]/.test(source.slice(previous.end, index)),
      closesCondition,
      reading
    }
  }
  while (offset < source.length) {
    const frame = templates.at(-1)
    const start = frame?.expression === false ? offset : skipTrivia(source, offset)
    if (frame?.expression === false || source[start] === "`") {
      const opening = frame?.expression !== false
      const chunk = templateChunk(source, start, opening)
      if ((!chunk.closed && !chunk.interpolation) || (opening && chunk.interpolation && templates.length >= 64)) {
        tokens.push({ kind: "unparsed", value: source.slice(start), start, end: source.length })
        return tokens
      }
      tokens.push({ kind: "string", value: source.slice(start, chunk.end), start, end: chunk.end })
      if (chunk.interpolation) {
        if (opening) templates.push({ expression: true, braces: 0 })
        else frame.expression = true
        // A substitution starts an expression, so `/.../` here is a regexp.
        tokens.push({ kind: "punctuation", value: "(", start: chunk.end - 2, end: chunk.end })
        heads.push(false)
      } else if (!opening) {
        templates.pop()
      }
      closesCondition = false
      offset = chunk.end
      continue
    }
    const token = nextToken(source, offset, context)
    if (token === undefined) {
      break
    }
    closesCondition = false
    if (frame?.expression && token.kind === "punctuation") {
      if (token.value === "{") frame.braces++
      else if (token.value === "}") {
        if (frame.braces === 0) {
          frame.expression = false
          heads.pop()
          tokens.push({ ...token, value: ")" })
          offset = token.end
          continue
        }
        frame.braces--
      }
    }
    if (token.kind === "punctuation" && token.value === "(") {
      heads.push(isKeyword(tokens.at(-1), tokens.at(-2), conditionKeywords))
    } else if (token.kind === "punctuation" && token.value === ")") {
      closesCondition = heads.pop() === true
    }
    tokens.push(token)
    offset = token.end
  }
  if (templates.length > 0) tokens.push({ kind: "unparsed", value: "", start: offset, end: offset })
  return tokens
}

const findFlowObject = (source: string): FlowObject | undefined => {
  const tokens = tokenize(source)
  for (let index = 0; index <= tokens.length - 6; index++) {
    if (
      tokens[index]?.value !== "export" ||
      tokens[index + 1]?.value !== "default" ||
      tokens[index + 2]?.value !== "Flow" ||
      tokens[index + 3]?.value !== "." ||
      tokens[index + 4]?.value !== "make" ||
      tokens[index + 5]?.value !== "("
    ) {
      continue
    }

    let parentheses = 1
    for (let argumentIndex = index + 6; argumentIndex < tokens.length; argumentIndex++) {
      const token = tokens[argumentIndex]
      if (token?.value === "(") {
        parentheses++
        continue
      }
      if (token?.value === ")") {
        parentheses--
        if (parentheses === 0) {
          break
        }
        continue
      }
      if (token?.value !== "{" || parentheses !== 1) {
        continue
      }

      let braces = 1
      for (let objectIndex = argumentIndex + 1; objectIndex < tokens.length; objectIndex++) {
        const objectToken = tokens[objectIndex]
        if (objectToken?.value === "{") {
          braces++
        } else if (objectToken?.value === "}") {
          braces--
          if (braces === 0) {
            return { start: token.start, end: objectToken.start }
          }
        }
      }
      return undefined
    }
  }
  return undefined
}

const placementFromSource = (source: string): Option.Option<Placement> => {
  const token = nextToken(source, 0, () => start)
  const directive = token?.kind === "string" ? stringLiteral(token.value) : undefined
  switch (directive) {
    case "use client":
      return Option.some("client")
    case "use server":
      return Option.some("local")
    case "use local":
      return Option.some("local")
    case "use sandbox":
      return Option.some("sandbox")
    case "use remote":
      return Option.some("remote")
    default:
      return Option.none()
  }
}

/**
 * Returns whether the default flow declaration is complete in a source prefix.
 * @category predicates
 *
 * @since 0.1.0
 * @private
 */
export const isComplete = (source: string): boolean => findFlowObject(source) !== undefined

const splitTopLevel = (source: string): ReadonlyArray<string> => {
  const parts: Array<string> = []
  let start = 0
  let braces = 0
  let brackets = 0
  let parentheses = 0

  for (const token of tokenize(source)) {
    switch (token.value) {
      case "{":
        braces++
        break
      case "}":
        braces--
        break
      case "[":
        brackets++
        break
      case "]":
        brackets--
        break
      case "(":
        parentheses++
        break
      case ")":
        parentheses--
        break
      case ",":
        if (braces === 0 && brackets === 0 && parentheses === 0) {
          parts.push(source.slice(start, token.start))
          start = token.end
        }
        break
    }
  }
  parts.push(source.slice(start))
  return parts
}

const findTopLevelColon = (source: string): number | undefined => {
  let braces = 0
  let brackets = 0
  let parentheses = 0
  for (const token of tokenize(source)) {
    switch (token.value) {
      case "{":
        braces++
        break
      case "}":
        braces--
        break
      case "[":
        brackets++
        break
      case "]":
        brackets--
        break
      case "(":
        parentheses++
        break
      case ")":
        parentheses--
        break
      case ":":
        if (braces === 0 && brackets === 0 && parentheses === 0) {
          return token.start
        }
        break
    }
  }
  return undefined
}

const trimTrivia = (source: string): string => {
  const tokens = tokenize(source)
  return tokens.length === 0 ? "" : source.slice(tokens[0]!.start, tokens.at(-1)!.end)
}

const propertyKey = (source: string): string | undefined => {
  const tokens = tokenize(source)
  if (tokens.length !== 1) return undefined
  const token = tokens[0]!
  if (token.kind === "string" && ["\"", "'"].includes(token.value[0]!)) return token.value.slice(1, -1)
  return token.kind === "identifier" && token.escaped !== true ? token.value : undefined
}

const propertiesFrom = (
  source: string
): {
  readonly values: ReadonlyMap<string, string>
  readonly offsets: ReadonlyMap<string, number>
  readonly unprojectableOffset: number | undefined
  readonly hasUnprojectableMembers: boolean
} => {
  const properties = new Map<string, string>()
  const offsets = new Map<string, number>()
  let unprojectableOffset: number | undefined
  let offset = 0
  let hasUnprojectableMembers = false
  for (const part of splitTopLevel(source)) {
    const start = offset + skipTrivia(part, 0)
    offset += part.length + 1
    const trimmed = trimTrivia(part)
    if (trimmed === "") {
      continue
    }
    if (trimmed.startsWith("...")) {
      hasUnprojectableMembers = true
      unprojectableOffset ??= start
      continue
    }
    const colon = findTopLevelColon(trimmed)
    if (colon === undefined) {
      const key = propertyKey(trimmed)
      if (key !== undefined) {
        properties.set(key, key)
        offsets.set(key, start)
      } else {
        hasUnprojectableMembers = true
        unprojectableOffset ??= start
      }
      continue
    }
    const key = propertyKey(trimmed.slice(0, colon))
    if (key !== undefined) {
      properties.set(key, trimTrivia(trimmed.slice(colon + 1)))
      offsets.set(key, start)
    } else {
      hasUnprojectableMembers = true
      unprojectableOffset ??= start
    }
  }
  return { values: properties, offsets, unprojectableOffset, hasUnprojectableMembers }
}

const decodeEscapes = (value: string): string =>
  value.replace(
    /\\(u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|n|r|t|b|f|v|0|\\|"|'|`)/g,
    (_match, sequence: string) => {
      switch (sequence) {
        case "n":
          return "\n"
        case "r":
          return "\r"
        case "t":
          return "\t"
        case "b":
          return "\b"
        case "f":
          return "\f"
        case "v":
          return "\v"
        case "0":
          return "\0"
        case "\\":
          return "\\"
        case "\"":
          return "\""
        case "'":
          return "'"
        case "`":
          return "`"
        default: {
          const hexadecimal = sequence.startsWith("u{") ? sequence.slice(2, -1) : sequence.slice(1)
          const codePoint = Number.parseInt(hexadecimal, 16)
          return codePoint > 0x10ffff ? `\\${sequence}` : String.fromCodePoint(codePoint)
        }
      }
    }
  )

/**
 * The value of a quoted literal, or `undefined` for anything else — an
 * unterminated quote, or a template carrying a substitution, whose value is
 * not decidable without running the module.
 *
 * @category parsing
 * @since 1.0.0-rc.0
 * @private
 */
export const stringLiteral = (source: string | undefined): string | undefined => {
  if (source === undefined) {
    return undefined
  }
  const tokens = tokenize(source)
  if (tokens.length !== 1 || tokens[0]!.kind !== "string") return undefined
  const trimmed = tokens[0]!.value
  const quote = trimmed[0]
  if (
    (quote !== "\"" && quote !== "'" && quote !== "`") ||
    trimmed.at(-1) !== quote ||
    (quote === "`" && trimmed.includes("${"))
  ) {
    return undefined
  }
  return decodeEscapes(trimmed.slice(1, -1))
}

const stringArray = (source: string | undefined): ReadonlyArray<string> | undefined => {
  if (source === undefined) {
    return undefined
  }
  const trimmed = trimTrivia(source)
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return undefined
  }
  const parts = splitTopLevel(trimmed.slice(1, -1)).filter((part) => trimTrivia(part) !== "")
  const values = parts.map(stringLiteral)
  return values.every((value): value is string => value !== undefined) ? values : undefined
}

const booleanLiteral = (source: string | undefined): boolean | undefined =>
  source === undefined
    ? undefined
    : trimTrivia(source) === "true"
    ? true
    : trimTrivia(source) === "false"
    ? false
    : undefined

const objectProperties = (
  source: string | undefined
): ReturnType<typeof propertiesFrom> | undefined => {
  if (source === undefined) {
    return undefined
  }
  const tokens = tokenize(source)
  const openingIndex = tokens.findIndex((token) => token.value === "{")
  const opening = tokens[openingIndex]
  if (opening === undefined) {
    return undefined
  }
  let depth = 1
  for (let index = openingIndex + 1; index < tokens.length; index++) {
    const token = tokens[index]
    if (token?.value === "{") {
      depth++
    } else if (token?.value === "}") {
      depth--
      if (depth === 0) {
        return propertiesFrom(source.slice(opening.end, token.start))
      }
    }
  }
}

const effectDeclaration = (
  source: string | undefined,
  capabilities: ReadonlyArray<string>,
  warnings: Array<MetadataWarning>
): EffectDeclaration => {
  const properties = objectProperties(source)
  const unreadable = source !== undefined &&
    (properties === undefined || properties.hasUnprojectableMembers)
  if (unreadable) {
    warnings.push({
      message: properties === undefined
        ? "Effects must be a statically projectable object literal; using conservative effects"
        : "Effects contain an object spread or computed member; using conservative effects"
    })
  }
  const paths = (key: "reads" | "writes"): ReadonlyArray<string> | "unreadable" | undefined => {
    if (properties?.values.has(key) !== true) return undefined
    return stringArray(properties.values.get(key)) ?? "unreadable"
  }
  const literal = (key: "mode" | "onConflict" | "tier"): string | undefined => {
    if (properties?.values.has(key) !== true) return undefined
    return stringLiteral(properties.values.get(key)) ?? "unreadable"
  }
  const projection = projectEffects({
    capabilities,
    declaration: source === undefined
      ? undefined
      : unreadable
      ? "unreadable"
      : {
        reads: paths("reads"),
        writes: paths("writes"),
        mode: literal("mode"),
        onConflict: literal("onConflict"),
        tier: literal("tier")
      }
  })
  let reportedPolicy = false
  for (const problem of projection.problems) {
    switch (problem._tag) {
      case "unreadableDeclaration":
        break
      case "unreadableMember":
        warnings.push({
          message: `Effects ${problem.member} must be a string-literal array; using the conservative wildcard`
        })
        break
      case "invalidMode":
      case "invalidOnConflict":
        if (!reportedPolicy) {
          reportedPolicy = true
          warnings.push({
            message: "Effects mode and conflict policy must be string literals; using conservative effects"
          })
        }
        break
      case "invalidTier":
        warnings.push({
          message: "Effects tier must be a sealed, compensable, or irreversible string literal; using irreversible"
        })
        break
      case "underClassifiedTier":
        warnings.push({
          message: `Effect tier ${problem.declared} under-classifies declared authority; using ${problem.projected}`
        })
        break
    }
  }
  return projection.effects
}

// Only imported, unshadowed namespace reads can identify a trusted schema.
// This is a conservative projection over the metadata lexer, never an import
// of repository code. Any other use of the binding makes its identity opaque.
const schemaNamespaces = (source: string): ReadonlySet<string> => {
  const tokens = tokenize(source)
  const imported = new Map<string, number>()
  const importTokens = new Set<number>()
  let depth = 0
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.value === "import" && token.escaped !== true && depth === 0) {
      let end = index + 1
      while (end < tokens.length && tokens[end]!.value !== "from" && tokens[end]!.value !== ";") end++
      const module = stringLiteral(tokens[end + 1]?.value)
      if (module === "effect" || module === "effect/Schema") {
        const specifiers = tokens.slice(index + 1, end)
        const bindings: Array<string> = []
        if (
          module === "effect/Schema" && specifiers.length === 3 &&
          specifiers[0]?.value === "*" && specifiers[1]?.value === "as" &&
          specifiers[2]?.kind === "identifier" && specifiers[2].escaped !== true
        ) {
          bindings.push(specifiers[2].value)
        } else if (module === "effect" && specifiers[0]?.value === "{" && specifiers.at(-1)?.value === "}") {
          for (let part = 1; part < specifiers.length - 1; part++) {
            if (
              specifiers[part]?.value !== "Schema" || specifiers[part]?.escaped === true ||
              !["{", ","].includes(specifiers[part - 1]!.value)
            ) continue
            const alias = specifiers[part + 1]?.value === "as" ? specifiers[part + 2] : specifiers[part]
            const after = specifiers[part + 1]?.value === "as" ? part + 3 : part + 1
            if (
              alias?.kind === "identifier" && alias.escaped !== true &&
              [",", "}"].includes(specifiers[after]!.value)
            ) {
              bindings.push(alias.value)
            }
          }
        }
        for (const binding of bindings) {
          imported.set(binding, (imported.get(binding) ?? 0) + 1)
          for (let part = index; part <= end + 1; part++) importTokens.add(part)
        }
      }
    }
    if (["{", "(", "["].includes(token.value)) depth++
    if (["}", ")", "]"].includes(token.value)) depth--
  }
  const trusted = new Set<string>()
  for (const [name, count] of imported) {
    if (count !== 1) continue
    const safe = tokens.every((token, index) => {
      if (token.kind !== "identifier" || token.value !== name || importTokens.has(index)) return true
      // A declaration, argument, assignment, computed access or alias escapes
      // the namespace identity. Member mutation is also refused.
      return token.escaped !== true &&
        !["delete", "+", "-", "("].includes(tokens[index - 1]?.value ?? "") &&
        tokens[index + 1]?.value === "." &&
        tokens[index + 2]?.kind === "identifier" &&
        [",", "}", "]", ")", ";", "("].includes(tokens[index + 3]?.value ?? "")
    })
    if (safe) trusted.add(name)
  }
  return trusted
}

const payloadDocument = (source: string, payload: string | undefined): Schema.Json | undefined => {
  if (payload === undefined) return undefined
  const tokens = tokenize(payload)
  if (tokens[0]?.value !== "{" || tokens.at(-1)?.value !== "}") return undefined
  let depth = 0
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]!.value === "{") depth++
    if (tokens[index]!.value === "}" && --depth === 0 && index !== tokens.length - 1) return undefined
  }
  const properties = propertiesFrom(payload.slice(tokens[0].end, tokens.at(-1)!.start))
  if (properties.hasUnprojectableMembers) return undefined
  const namespaces = schemaNamespaces(source)
  const primitives = { String: Schema.String, Number: Schema.Number, Boolean: Schema.Boolean, Null: Schema.Null }
  const fields: Record<string, Schema.Top> = Object.create(null)
  for (const [key, value] of properties.values) {
    const expression = tokenize(value)
    if (
      key === "__proto__" || key.includes("\\") || expression.length !== 3 ||
      !namespaces.has(expression[0]!.value) || expression[1]?.value !== "." ||
      !Object.hasOwn(primitives, expression[2]!.value)
    ) return undefined
    fields[key] = primitives[expression[2]!.value as keyof typeof primitives]
  }
  return Schema.decodeUnknownSync(Schema.Json)(Schema.toJsonSchemaDocument(Schema.Struct(fields)))
}

/**
 * Statically reads the metadata carried by the default `Flow.make` value
 * without evaluating the module.
 * @category parsing
 *
 * @since 0.1.0
 * @private
 */
export const parse = (source: string): Metadata => {
  const flowObject = findFlowObject(source)
  const warnings: Array<MetadataWarning> = []
  if (flowObject === undefined) {
    return {
      description: undefined,
      hasInput: false,
      hasOutput: false,
      model: Option.none(),
      flows: [],
      capabilities: ["*"],
      effects: conservativeEffects,
      placement: placementFromSource(source),
      modelInvocable: true,
      declaresName: false,
      declaredName: Option.none(),
      warnings: [{ message: "Could not statically read the default Flow.make declaration" }]
    }
  }

  const parsedProperties = propertiesFrom(source.slice(flowObject.start + 1, flowObject.end))
  const properties = parsedProperties.values
  const lineAt = (offset: number): number =>
    source.slice(0, flowObject.start + 1 + offset).split(/\r\n|[\n\r\u2028\u2029]/).length
  const inputDocument = parsedProperties.hasUnprojectableMembers
    ? undefined
    : payloadDocument(source, properties.get("payload"))
  if (properties.has("payload") && inputDocument === undefined && !parsedProperties.hasUnprojectableMembers) {
    warnings.push({ message: "Payload schema cannot be projected statically; retaining its module locator" })
  }
  const capabilitiesSource = properties.get("capabilities")
  const literalCapabilities = capabilitiesSource === undefined ? [] : stringArray(capabilitiesSource)
  const flowsSource = properties.get("flows")
  const literalFlows = stringArray(flowsSource)
  const hasUnprojectableFlows = flowsSource !== undefined && (literalFlows === undefined || literalFlows.length > 0)
  const delegation = hasUnprojectableFlows ? unprojectableDelegation() : undefined
  if (literalCapabilities === undefined) {
    warnings.push({
      message: "Capabilities must be a string-literal array for discovery; using the conservative wildcard",
      line: lineAt(parsedProperties.offsets.get("capabilities")!)
    })
  }
  // A delegating flow that declares a readable capability list narrows the
  // delegate grant to it; only an undeclared list keeps the wildcard.
  const narrowsDelegation = hasUnprojectableFlows &&
    capabilitiesSource !== undefined &&
    literalCapabilities !== undefined &&
    !parsedProperties.hasUnprojectableMembers
  if (hasUnprojectableFlows && !narrowsDelegation) {
    warnings.push({
      message: "Flow authority cannot be projected statically; using the conservative wildcard",
      line: lineAt(parsedProperties.offsets.get("flows")!)
    })
  }
  if (parsedProperties.hasUnprojectableMembers) {
    warnings.push({
      message:
        "Object spread or computed properties make schemas and authority unprojectable; using conservative projections",
      line: lineAt(parsedProperties.unprojectableOffset!)
    })
  }
  const capabilities = narrowsDelegation && delegation !== undefined
    ? narrowDelegation(delegation.capabilities, literalCapabilities)
    : literalCapabilities === undefined ||
        hasUnprojectableFlows ||
        parsedProperties.hasUnprojectableMembers
    ? delegation?.capabilities ?? ["*"]
    : literalCapabilities

  const effects = effectDeclaration(properties.get("effects"), capabilities, warnings)

  const modelInvocableSource = properties.get("modelInvocable")
  const disableModelInvocationSource = properties.get("disableModelInvocation")
  const modelInvocable = booleanLiteral(modelInvocableSource)
    ?? booleanLiteral(disableModelInvocationSource) !== true
  if (
    (modelInvocableSource !== undefined && booleanLiteral(modelInvocableSource) === undefined) ||
    (disableModelInvocationSource !== undefined && booleanLiteral(disableModelInvocationSource) === undefined)
  ) {
    warnings.push({ message: "Model invocation visibility must be declared as a boolean literal for discovery" })
  }

  const modelSource = properties.get("model")
  const model = stringLiteral(modelSource) ?? stringArray(modelSource)

  return {
    description: stringLiteral(properties.get("description")),
    // Two declarations name the same two schemas. `@smthrs/core` calls them
    // `input` and `output`; `@smthrs/flow`, which a `flows/<name>/flow.ts`
    // default-exports, calls them `payload` and `success`. Discovery reads the
    // file without importing it, so it reads both spellings rather than
    // reporting a flow that declares a payload as one that takes no input.
    hasInput: properties.has("input") || properties.has("payload") || parsedProperties.hasUnprojectableMembers,
    ...inputDocument === undefined ? {} : { inputDocument },
    hasOutput: properties.has("output") || properties.has("success") || parsedProperties.hasUnprojectableMembers,
    model: Schema.is(ModelSelection)(model) ? Option.some(model) : Option.none(),
    flows: literalFlows ?? [],
    capabilities,
    effects,
    placement: placementFromSource(source),
    modelInvocable,
    declaresName: properties.has("name"),
    declaredName: Option.fromUndefinedOr(stringLiteral(properties.get("name"))),
    warnings
  }
}
