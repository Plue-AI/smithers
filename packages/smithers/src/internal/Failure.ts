/**
 * What a failure that carries no sentence still owes an operator.
 *
 * Every `@smthrs/control` failure is a `Schema.TaggedError` whose data lives in
 * named fields. Some override `message` with a sentence — `NoMatchingWait`
 * does, and says why: "every other renderer in the tree prints `message`, so a
 * refusal with none is a refusal with no reason". The rest have none, and the
 * executable's reporter printed the class name and a bare colon for them:
 * `smthrs resume` against a run another process owns answered the whole line
 * `ClaimLost: `, which names neither the run nor the stable `code` a script
 * must be able to grep for.
 *
 * It lives here rather than in `cli/LegacyBin.ts` because importing that module runs the
 * command line: the reporter itself can only be exercised through a real
 * process, and this is the part of it that has an answer to check.
 *
 * @since 1.0.0
 */

import * as Redaction from "@smthrs/journal/Redaction"
import { stripVTControlCharacters } from "node:util"

/**
 * One line of untrusted text made inert for a terminal: ANSI escape sequences
 * are removed, and every remaining control or format code point becomes a
 * space, so journaled model or cell text cannot move the cursor, clear the
 * screen, or set the window title.
 *
 * @category getters
 * @since 1.0.0
 */
export const terminalSafe = (text: string): string => stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, " ")

/**
 * Multi-line untrusted text made inert for a terminal: like `terminalSafe`,
 * but line feeds and tabs survive and a CRLF becomes a line feed.
 *
 * @category getters
 * @since 1.0.0
 */
export const terminalSafeLines = (text: string): string =>
  stripVTControlCharacters(text).replace(/\r\n/g, "\n").replace(/(?![\n\t])[\p{Cc}\p{Cf}]/gu, "")

/**
 * The most specific recorded cause, including older nested Error stacks.
 * @category getters
 * @since 1.0.0
 */
export const causeLine = (cause: string): string => {
  const safe = String(Redaction.redact(stripVTControlCharacters(cause)))
  let line = safe.split(/\r?\n/, 1)[0] ?? ""
  // New lifecycle records lead with the typed code. Older records only carry
  // an Error stack, whose innermost cause still explains the failed run.
  if (!/^[a-z][a-z0-9_]*: /.test(line)) {
    for (const nested of safe.matchAll(/^\s*\[cause\]:\s*([^\r\n]+)/gm)) line = nested[1]!
  }
  return terminalSafe(line).trim().slice(0, 1024)
}

/**
 * How much of one field a refusal line may spend, before the rest is cut.
 *
 * @category constants
 * @since 1.0.0
 */
export const fieldValueLimit = 256

/**
 * The refusal detail a failure's own fields state.
 *
 * The constant contract code leads, then every scalar field by name, each
 * bounded so one large field — an `InvalidInput` issue, say — cannot flood a
 * terminal. Structured fields are left out: a plan envelope is not a refusal
 * reason, and it is in the run's journal either way. An error carrying neither
 * a code nor a scalar field answers the empty string, which is what the
 * reporter printed for it before.
 *
 * @category getters
 * @since 1.0.0
 */
export const fields = (error: Error): string => {
  const own = error as unknown as Readonly<Record<string, unknown>>
  const scalar = (value: unknown): string | undefined =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? [...String(value)].slice(0, fieldValueLimit).join("")
      : undefined
  const code = typeof own["code"] === "string" ? [own["code"]] : []
  const named = Object.keys(own).flatMap((key) => {
    if (key === "_tag" || key === "code") return []
    const value = scalar(own[key])
    return value === undefined ? [] : [`${key}=${value}`]
  })
  return [...code, ...named].join(" ")
}

/**
 * The sentence an operator reads for one failure: its own, or its fields.
 *
 * @category getters
 * @since 1.0.0
 */
export const sentence = (error: Error): string => error.message === "" ? fields(error) : error.message

/**
 * The sentence an operator reads for a failure nobody designed a sentence
 * for. It is `UNKNOWN_FAILURE.sentence` from `@smthrs/rpc/UserFailure`, which
 * this published package cannot depend on; `test/Failure.test.ts` keeps the
 * two equal.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const unknownSentence = "Something went wrong on our side. Not your fault."

/**
 * Whether a thrown value is a tagged error: an `Error` with a string `_tag`,
 * which every `Schema.TaggedError` and `Data.TaggedError` is.
 *
 * @category refinements
 * @since 1.0.0-rc.1
 */
export const isTagged = (error: unknown): error is Error & { readonly _tag: string } => {
  try {
    return error instanceof Error && typeof (error as { readonly _tag?: unknown })._tag === "string"
  } catch {
    return false
  }
}

const ownValue = (value: object, key: string): unknown => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a thrown value carries a sentence someone wrote for an operator: a
 * tagged failure, or a plain `Error` this CLI threw on purpose. A runtime bug
 * (`TypeError` and friends), a Node system error, and a non-Error value do
 * not. The plain-`Error` allowance is transitional: those throws are being
 * converted to tagged refusals (#2813).
 *
 * @category refinements
 * @since 1.0.0-rc.1
 */
export const isDesigned = (error: unknown): error is Error => {
  try {
    if (isTagged(error)) return true
    return error instanceof Error && Object.getPrototypeOf(error) === Error.prototype &&
      ownValue(error, "syscall") === undefined && ownValue(error, "errno") === undefined
  } catch {
    return false
  }
}

/**
 * The one sentence an operator reads for any thrown value: a designed
 * failure's own sentence, and `unknownSentence` for everything else. A raw
 * runtime message, a stack, or `String(error)` is never the sentence; it is
 * detail, printed only for `--verbose` through `operatorDetail`.
 *
 * @category getters
 * @since 1.0.0-rc.1
 */
export const operatorSentence = (error: unknown): string => {
  if (!isDesigned(error)) {
    // A decoded refusal can arrive as a plain `{ _tag, message }` record.
    const tag = typeof error === "object" && error !== null ? ownValue(error, "_tag") : undefined
    const message = typeof error === "object" && error !== null ? ownValue(error, "message") : undefined
    return typeof tag === "string" && typeof message === "string" && message !== ""
      ? terminalSafe(message)
      : unknownSentence
  }
  const stated = sentence(error)
  return stated === "" ? unknownSentence : stated
}

/**
 * The name an operator reads for a failure: the last segment of a tagged
 * failure's `_tag` (`NoMatchingWait`, not `/control/NoMatchingWait`), or the
 * error's `name`.
 *
 * @category getters
 * @since 1.0.0-rc.1
 */
export const displayName = (error: Error): string => {
  const tag = (error as { readonly _tag?: unknown })._tag
  return typeof tag === "string" && tag.length > 0 ? tag.slice(tag.lastIndexOf("/") + 1) : error.name
}

/**
 * The stderr line for a failure the CLI reports itself: `Name: sentence` for a
 * designed failure, `unknownSentence` otherwise, and the raw detail on the
 * following lines when `verbose` is set.
 *
 * @category getters
 * @since 1.0.0-rc.1
 */
export const operatorLine = (error: unknown, verbose: boolean): string => {
  const stated = operatorSentence(error)
  const line = stated === unknownSentence ? stated : `${displayName(error as Error)}: ${stated}`
  return verbose && stated === unknownSentence ? `${line}\n${operatorDetail(error)}` : line
}

const MAX_DETAIL_DEPTH = 8

const rawDetail = (error: unknown, depth: number): string => {
  try {
    if (error instanceof Error) {
      const head = `${error.name}: ${error.message}`
      const stack = typeof error.stack === "string" && error.stack.length > 0 ? error.stack : head
      const text = stack.includes(error.message) ? stack : `${head}\n${stack}`
      const cause = (error as { readonly cause?: unknown }).cause
      return cause === undefined || depth + 1 >= MAX_DETAIL_DEPTH
        ? text
        : `${text}\nCaused by: ${rawDetail(cause, depth + 1)}`
    }
    if (typeof error === "string") return error
    const json = JSON.stringify(error)
    return json === undefined ? String(error) : json
  } catch {
    return "Unprintable error"
  }
}

/**
 * The raw text behind a failure, for `--verbose` only: its stack and cause
 * chain, redacted and made inert for a terminal. Never throws.
 *
 * @category getters
 * @since 1.0.0-rc.1
 */
export const operatorDetail = (error: unknown): string => {
  try {
    return terminalSafeLines(String(Redaction.redact(rawDetail(error, 0))))
  } catch {
    return "Unprintable error"
  }
}
