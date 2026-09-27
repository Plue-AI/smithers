/**
 * Non-executing migration of literal legacy CLI commands in package scripts.
 * Shell words retain their original spelling; arguments are never evaluated.
 *
 * @since 1.0.0-rc.0
 */

import * as CommandLine from "./CommandLine.ts"

interface Word {
  readonly value: string
  readonly raw: string
  readonly literal: boolean
  readonly start: number
  readonly end: number
}

interface Scan {
  readonly commands: ReadonlyArray<ReadonlyArray<Word>>
  readonly unsafe: boolean
}

/** Only simple-command lists are rewritten; redirections and shell grammar need review. */
const scan = (text: string): Scan => {
  const commands: Array<Array<Word>> = [[]]
  let unsafe = false
  let index = 0
  while (index < text.length) {
    const character = text[index]!
    if (character === " " || character === "\t" || character === "\r") {
      index++
      continue
    }
    if ("\n;&|".includes(character)) {
      commands.push([])
      index++
      continue
    }
    if (character === "#") {
      while (index < text.length && text[index] !== "\n") index++
      continue
    }
    if ("<>()".includes(character)) {
      unsafe = true
      index++
      continue
    }
    const start = index
    let value = ""
    let literal = true
    let quote: "'" | "\"" | undefined
    while (index < text.length) {
      const char = text[index]!
      if (quote === undefined && /[ \t\r\n;&|<>()]/.test(char)) break
      index++
      if (char === quote) {
        quote = undefined
        continue
      }
      if (quote === undefined && (char === "'" || char === "\"")) {
        quote = char
        continue
      }
      if (quote !== "'" && char === "\\") {
        const next = text[index]
        if (next === undefined) {
          unsafe = true
          break
        }
        if (quote === undefined || "$`\"\\\n".includes(next)) {
          index++
          if (next !== "\n") value += next
          continue
        }
      }
      if (quote !== "'" && (char === "$" || char === "`")) literal = false
      if (quote === undefined && "*?[~{}".includes(char)) literal = false
      // Command substitutions and control grammar cannot be treated as simple
      // word boundaries even when they occur inside double quotes.
      if (quote !== "'" && (char === "`" || (char === "$" && text[index] === "("))) unsafe = true
      value += char
    }
    if (quote !== undefined) unsafe = true
    commands[commands.length - 1]!.push({ value, raw: text.slice(start, index), literal, start, end: index })
  }
  const controlWords = new Set([
    "if",
    "then",
    "elif",
    "else",
    "fi",
    "for",
    "while",
    "until",
    "do",
    "done",
    "case",
    "esac",
    "function",
    "{",
    "}",
    "!"
  ])
  return { commands, unsafe: unsafe || commands.some((words) => controlWords.has(words[0]?.value ?? "")) }
}

const isCli = (word: Word | undefined): boolean =>
  word?.literal === true &&
  (/^(?:smithers|smthrs|smithers-orchestrator)$/.test(word.value) ||
    /(?:^|\/)node_modules\/\.bin\/(?:smithers|smthrs)$/.test(word.value))

// Version suffixes are package-runner syntax, not executable names. A dynamic
// suffix is recognized for reporting but never evaluated or guessed at.
const isCliPackage = (word: Word | undefined): boolean =>
  word !== undefined && /^(?:smithers|smthrs|smithers-orchestrator)@/.test(word.value)

const booleanFlags = new Set(["--json", "--quiet", "--detached"])
const valueFlags = new Set(["--input", "--data", "--root", "--remote", "--credential", "--mcp-config", "--backend"])
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/
const manual =
  "Legacy CLI script requires manual mapping to smthrs flow start; unsupported or ambiguous shell/option syntax"

const hasControl = (text: string): boolean => {
  for (const character of text) {
    const code = character.charCodeAt(0)
    if (code < 32 || (code >= 127 && code <= 159)) return true
  }
  return false
}

type Change = { readonly start: number; readonly end: number; readonly text: string }
type CommandResult = { readonly change?: Change; readonly unsupported?: string }

const rewriteCommand = (
  words: ReadonlyArray<Word>,
  flowName: (path: string) => string
): CommandResult => {
  let index = 0
  while (assignment.test(words[index]?.raw ?? "")) index++
  if (words[index]?.literal && (words[index]!.value === "exec" || words[index]!.value === "env")) {
    const prefix = words[index++]!.value
    // env accepts quoted NAME=value arguments; shell assignment words and
    // exec's executable position do not have the same grammar.
    if (prefix === "env") { while (assignment.test(words[index]?.value ?? "")) index++ }
  }
  const start = index
  let wrapped = false
  if (words[index]?.literal && ["bunx", "npx", "pnpm"].includes(words[index]!.value)) {
    wrapped = true
    const runner = words[index++]!.value
    if (runner === "pnpm") {
      if (!["exec", "dlx"].includes(words[index]?.value ?? "")) return {}
      index++
    }
    while (words[index]?.literal && ["-y", "--yes", "--no-install"].includes(words[index]!.value)) index++
  }
  if (!isCli(words[index])) {
    if (!wrapped) return {}
    const candidate = words[index]
    if (!(candidate?.literal && /^(?:smithers|smthrs|smithers-orchestrator)@[A-Za-z0-9._+-]+$/.test(candidate.value))) {
      return words.slice(index).some((word) => isCli(word) || isCliPackage(word)) ? { unsupported: manual } : {}
    }
  }
  index++
  if (words[index]?.value === "flow" && words[index]?.literal) return {}
  const command = words[index]?.value
  if (command === "up") index++
  else if (command === "workflow" && words[index + 1]?.value === "run") index += 2
  else return { unsupported: "Legacy CLI command requires manual mapping to the 1.0 command tree" }

  const parts: Array<string> = []
  const seen = new Set<string>()
  let flow: string | undefined
  const refuse = (): CommandResult => ({ unsupported: manual })
  for (; index < words.length; index++) {
    const word = words[index]!
    const equals = word.value.indexOf("=")
    let flag = equals === -1 ? word.value : word.value.slice(0, equals)
    let value: Word | undefined
    if (flag === "-d") {
      if (equals !== -1) return refuse()
      const next = words[index + 1]
      // Bare -d in 0.x scripts is detached. The old data alias, when supplied
      // a literal JSON object, is rewritten explicitly to --data instead.
      if (next !== undefined && !next.value.startsWith("-") && (flow !== undefined || next.value.startsWith("{"))) {
        if (!next.literal) return refuse()
        flag = "--input"
      } else flag = "--detached"
    }
    if (booleanFlags.has(flag)) {
      if (equals !== -1 || seen.has(flag) || !word.literal) return refuse()
      seen.add(flag)
      parts.push(flag)
      continue
    }
    if (valueFlags.has(flag)) {
      if (equals !== -1) {
        const decoded = word.value.slice(equals + 1)
        if (!word.raw.startsWith(`${flag}=`) && !word.literal) return refuse()
        value = {
          ...word,
          value: decoded,
          raw: word.raw.startsWith(`${flag}=`) ? word.raw.slice(flag.length + 1) : CommandLine.quote(decoded)
        }
      } else {
        value = words[++index]
        if (value === undefined || value.value.startsWith("--")) return refuse()
      }
      if (value.value === "") return refuse()
      if (flag === "--backend") {
        if (!value.literal || value.value !== "sqlite") return refuse()
        continue
      }
      const mapped = flag === "--input" ? "--data" : flag
      if (seen.has(mapped)) return refuse()
      seen.add(mapped)
      if (mapped === "--data" && value.literal) {
        try {
          const data: unknown = JSON.parse(value.value)
          if (typeof data !== "object" || data === null || Array.isArray(data)) return refuse()
        } catch {
          return refuse()
        }
      }
      parts.push(equals === -1 ? `${mapped} ${value.raw}` : `${mapped}=${value.raw}`)
      continue
    }
    if (word.value.startsWith("-") || flow !== undefined || !word.literal) return refuse()
    const path = word.value.replace(/^(?:\.\/)+/, "")
    if (
      path === "" || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") ||
      hasControl(path)
    ) {
      return refuse()
    }
    flow = flowName(path)
  }
  if (flow === undefined || flow === "" || flow.startsWith("-") || (seen.has("--remote") && seen.has("--detached"))) {
    return refuse()
  }
  return {
    change: {
      start: words[start]!.start,
      end: words[words.length - 1]!.end,
      text: `smthrs flow start ${CommandLine.quote(flow)}${parts.length === 0 ? "" : ` ${parts.join(" ")}`}`
    }
  }
}

/**
 * Rewrites simple legacy invocations atomically per script. Unsupported input
 * is returned byte-for-byte unchanged with a reason for the migration report.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const rewrite = (before: string, flowName: (path: string) => string): {
  readonly after: string
  readonly unsupported?: string
} => {
  const parsed = scan(before)
  if (parsed.unsafe && parsed.commands.some((words) => words.some((word) => isCli(word) || isCliPackage(word)))) {
    return { after: before, unsupported: manual }
  }
  const changes: Array<Change> = []
  for (const words of parsed.commands) {
    const result = rewriteCommand(words, flowName)
    if (result.unsupported !== undefined) return { after: before, unsupported: result.unsupported }
    if (result.change !== undefined) changes.push(result.change)
  }
  let after = before
  for (const change of changes.reverse()) after = after.slice(0, change.start) + change.text + after.slice(change.end)
  return { after }
}
