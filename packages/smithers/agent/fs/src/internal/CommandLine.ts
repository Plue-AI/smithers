/**
 * Shell-independent, bounded parsing for the agent command surface.
 *
 * @private
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import { FsError } from "../FsError.ts"
import * as Boundary from "./Boundary.ts"

/**
 * Maximum UTF-8 bytes accepted in one command string.
 *
 * @private
 * @since 0.1.0
 */
export const maximumCommandBytes = 64 * 1024

/**
 * Maximum tokens accepted in one command string.
 *
 * @private
 * @since 0.1.0
 */
export const maximumCommandTokens = 4_096

/**
 * Maximum UTF-16 length accepted in one token.
 *
 * @private
 * @since 0.1.0
 */
export const maximumTokenLength = 16_384

/**
 * Positional and named values extracted from an argv tail.
 *
 * @private
 * @since 0.1.0
 */
export interface ParsedFlags {
  readonly args: ReadonlyArray<string>
  readonly options: Readonly<Record<string, unknown>>
}

const encoder = new TextEncoder()
const flagName = /^[A-Za-z][A-Za-z0-9-]{0,127}$/
const reservedNames = new Set(["__proto__", "constructor", "prototype"])

const parseError = (description: string, path?: string): FsError =>
  new FsError({ code: "parse_failed", method: "CommandLine", description, path })

const resourceLimit = (description: string): FsError =>
  new FsError({ code: "resource_limit", method: "CommandLine.lex", description })

/**
 * Splits a command string into argv without invoking a shell.
 *
 * Quotes and backslashes only affect tokenization. Shell syntax, including
 * substitutions and variable references, remains literal text. Single quotes
 * are literal, so a backslash inside them is an ordinary character; unquoted
 * and double-quoted text honour backslash escapes.
 *
 * @private
 * @since 0.1.0
 */
export const lex = (commandString: string): Effect.Effect<ReadonlyArray<string>, FsError> =>
  Effect.suspend(() => {
    if (
      typeof commandString !== "string" || !Boundary.isWellFormedText(commandString) ||
      encoder.encode(commandString).byteLength > maximumCommandBytes
    ) {
      return Effect.fail(resourceLimit(`A command may contain at most ${maximumCommandBytes} UTF-8 bytes`))
    }
    const argv: Array<string> = []
    let current = ""
    let quote: "single" | "double" | undefined
    let started = false
    let escaping = false

    const push = (): FsError | undefined => {
      if (current.length > maximumTokenLength) {
        return resourceLimit(`A command token may contain at most ${maximumTokenLength} characters`)
      }
      argv.push(current)
      return argv.length > maximumCommandTokens
        ? resourceLimit(`A command may contain at most ${maximumCommandTokens} tokens`)
        : undefined
    }

    for (const character of commandString) {
      // Single quotes suppress escaping, as in every POSIX shell, so a Windows
      // path or a regular expression survives `'...'` unchanged.
      if (quote === "single") {
        if (character === "'") quote = undefined
        else current += character
        continue
      }
      if (escaping) {
        current += character
        started = true
        escaping = false
        continue
      }
      if (character === "\\") {
        escaping = true
        started = true
        continue
      }
      if (quote === "double") {
        if (character === "\"") quote = undefined
        else current += character
        continue
      }
      if (character === "'") {
        quote = "single"
        started = true
      } else if (character === "\"") {
        quote = "double"
        started = true
      } else if (/\s/.test(character)) {
        if (started) {
          const failure = push()
          if (failure) return Effect.fail(failure)
          current = ""
          started = false
        }
      } else {
        current += character
        started = true
      }
    }

    if (escaping) current += "\\"
    if (quote !== undefined) return Effect.fail(parseError("The command contains an unterminated quote"))
    if (started) {
      const failure = push()
      if (failure) return Effect.fail(failure)
    }
    return Effect.succeed(Object.freeze(argv))
  })

const validFlagName = (name: string): boolean => flagName.test(name) && !reservedNames.has(name)

const append = (options: Record<string, unknown>, name: string, value: unknown): FsError | undefined => {
  if (!validFlagName(name)) return parseError("The command contains an invalid option name", `$.options.${name}`)
  const current = Object.hasOwn(options, name) ? options[name] : undefined
  options[name] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value]
}

/**
 * Parses long options from an argv tail using a small deterministic grammar.
 *
 * @private
 * @since 0.1.0
 */
export const parseFlags = (input: ReadonlyArray<string>): Effect.Effect<ParsedFlags, FsError> =>
  Effect.suspend(() => {
    const captured = Boundary.stringArray(input, {
      maxItems: maximumCommandTokens,
      maxLength: maximumTokenLength,
      allowEmpty: true
    })
    if (!captured.ok) return Effect.fail(resourceLimit("The command arguments exceed their resource bounds"))

    const args: Array<string> = []
    const options: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    let endOfFlags = false
    for (let index = 0; index < captured.value.length; index++) {
      const value = captured.value[index]!
      if (endOfFlags) {
        args.push(value)
        continue
      }
      if (value === "--") {
        endOfFlags = true
        continue
      }
      if (!value.startsWith("--")) {
        args.push(value)
        continue
      }

      const flag = value.slice(2)
      if (flag.startsWith("no-") && !flag.includes("=")) {
        const failure = append(options, flag.slice(3), false)
        if (failure) return Effect.fail(failure)
        continue
      }
      const equals = flag.indexOf("=")
      if (equals !== -1) {
        const failure = append(options, flag.slice(0, equals), flag.slice(equals + 1))
        if (failure) return Effect.fail(failure)
        continue
      }
      const next = captured.value[index + 1]
      if (next !== undefined && !next.startsWith("--")) {
        const failure = append(options, flag, next)
        if (failure) return Effect.fail(failure)
        index += 1
      } else {
        const failure = append(options, flag, true)
        if (failure) return Effect.fail(failure)
      }
    }

    for (const [name, value] of Object.entries(options)) {
      if (Array.isArray(value)) options[name] = Object.freeze(value)
    }
    return Effect.succeed(Object.freeze({
      args: Object.freeze(args),
      options: Object.freeze(options)
    }))
  })
