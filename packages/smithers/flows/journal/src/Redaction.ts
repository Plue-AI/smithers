/**
 * Payload redaction for durable journal writes.
 *
 * The journal is permanent and broadly readable: every entry is replayed to
 * sync subscribers and to time-travel consumers. A secret that reaches
 * `payload_json` is therefore not a transient leak, so redaction happens once,
 * on the journal write path, rather than at each reader.
 *
 * Redaction is an **observability** concern and is confined to journal events
 * and export/display surfaces. It is deliberately not applied to executable
 * state, `flows_runs.state_json`, attempt checkpoints, errors, outcomes, and
 * cache results, because those are decoded and re-entered on resume: a
 * placeholder there resumes the flow with the wrong data, and replacing a
 * non-string value with a placeholder string makes the persisted state fail
 * schema decode outright, leaving the run undrivable (issue #72). A value
 * that must never reach durable executable state is a `Redacted` field in the
 * caller's own schema, not a name-suffix guess made at the storage seam.
 *
 * The rule set is a best-effort textual net over credential shapes seen in
 * real bug reports, plus structural redaction by sensitive field name. It is
 * finite, so a value that must never persist belongs in a `Redacted` field of
 * the caller's own schema. See https://journal.smithers.sh/concepts/redaction/
 * for the rule set and how to replace it.
 *
 * @since 0.1.0
 */

import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

/** JSON text carrying an arbitrary decoded value. */
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown)

/**
 * A textual redaction rule.
 *
 * `replace` is the substitution for a matched span; when omitted the whole
 * match is replaced by the placeholder.
 *
 * `rewrite`, when set, rewrites the text itself instead. It is for a rule
 * whose extent is not regular: where a credential's value ends depends on
 * quotes, escapes and brackets a regular expression cannot count. `pattern`
 * then names what the rule looks for, and text `pattern` does not match is
 * left unchanged without calling `rewrite`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Rule {
  readonly id: string
  readonly pattern: RegExp
  readonly replace?: string | undefined
  readonly rewrite?: ((text: string) => string) | undefined
}

/**
 * The placeholder written in place of a redacted value.
 *
 * @since 0.1.0
 * @category constants
 */
export const placeholder = "[REDACTED]"

const isQuote = (char: string | undefined): boolean => char === "\"" || char === "'" || char === "`"

const closers: Readonly<Record<string, string>> = { "{": "}", "[": "]", "(": ")" }

/**
 * Whether the last {@link skipQuoted} or {@link skipContainer} found its
 * closer. Both return the end of the text for a value that never closes, and
 * for one that closes on the text's last character, so the end alone cannot
 * say which.
 */
let lastClosed = false

/**
 * The index just past the quote that closes the string opened at `open`. A
 * quote nested n strings deep sits behind `depth` = 2^n - 1 backslashes, and
 * the quote that closes it has that count modulo 2^(n+1). A string that is
 * never closed, cut by a bound or by its producer, runs to the end of the
 * text. A caller that knows the backslashes were doubled again passes a larger
 * `modulus`.
 */
const skipQuoted = (
  text: string,
  open: number,
  depth: number,
  modulus = 2 * (depth + 1),
  limit = text.length
): number => {
  let end = open + 1
  while (end < limit) {
    if (text[end] === text[open]) {
      let slashes = 0
      for (let i = end - 1; i > open && text[i] === "\\"; i--) slashes++
      if (slashes % modulus === depth) {
        lastClosed = true
        return end + 1
      }
    }
    end++
  }
  lastClosed = false
  return end
}

/**
 * The index just past the bracket that balances the one at `open`, skipping
 * quoted strings at any escape depth. An unbalanced container runs to the end
 * of the text.
 */
const skipContainer = (text: string, open: number, limit = text.length): number => {
  const pending: Array<string> = []
  let end = open
  while (end < limit) {
    const char = text[end]!
    if (isQuote(char)) {
      let depth = 0
      while (text[end - 1 - depth] === "\\") depth++
      end = skipQuoted(text, end, depth, 2 * (depth + 1), limit)
      if (!lastClosed) return end
      continue
    }
    const closer = closers[char]
    if (closer !== undefined) pending.push(closer)
    else if (char === pending.at(-1)) {
      pending.pop()
      if (pending.length === 0) {
        lastClosed = true
        return end + 1
      }
    }
    end++
  }
  lastClosed = false
  return end
}

/** A bracket or string still open at some point of the text: a bracket by its closer, a string by its quote and escape depth. */
interface Open {
  readonly close: string
  readonly depth?: number
}

/**
 * The escape depth of a quote behind `slashes` backslashes: 2^k - 1 for its k
 * trailing escaped levels, so `\\"` (an escaped backslash, then a quote) is
 * depth 0 and `\\\"` is depth 1.
 */
const escapeDepth = (slashes: number): number => (slashes ^ (slashes + 1)) >> 1

// `Array.prototype.findLastIndex` is ES2023; consumers compile this source
// against ES2022 declarations.
const lastIndex = (stack: ReadonlyArray<Open>, matches: (open: Open) => boolean): number => {
  for (let index = stack.length - 1; index >= 0; index--) if (matches(stack[index]!)) return index
  return -1
}

const innermostString = (stack: ReadonlyArray<Open>): number => lastIndex(stack, (open) => open.depth !== undefined)

/**
 * Updates `stack` with the brackets and strings that `text[from, to)` opens
 * and closes. A quote closes the innermost open string it can close at that
 * string's escape depth, and otherwise opens a string at its own depth. The
 * other quote characters inside a string are content (`"don't"`).
 */
const track = (stack: Array<Open>, text: string, from: number, to: number): void => {
  for (let i = from; i < to; i++) {
    const char = text[i]!
    if (isQuote(char)) {
      let slashes = 0
      while (text[i - 1 - slashes] === "\\") slashes++
      const inner = innermostString(stack)
      if (inner === -1) {
        stack.push({ close: char, depth: escapeDepth(slashes) })
        continue
      }
      if (stack[inner]!.close !== char) continue
      const closes = lastIndex(
        stack,
        (open) => open.depth !== undefined && slashes % (2 * (open.depth + 1)) === open.depth
      )
      if (closes === -1) stack.push({ close: char, depth: escapeDepth(slashes) })
      else stack.length = closes
      continue
    }
    const closer = closers[char]
    if (closer !== undefined) stack.push({ close: closer })
    else if (stack.at(-1)?.depth === undefined && char === stack.at(-1)?.close) stack.pop()
  }
}

/**
 * Whether the closer at `end` closes the bracket open before the name: it and
 * any closers right after it balance the enclosing brackets, and a separator
 * or the end of the text follows (`[{token:abc}]`, not `Tr0ub4dor)]&3`).
 */
const closesEnclosing = (text: string, end: number, stack: ReadonlyArray<Open>): boolean => {
  let at = end
  for (let k = stack.length - 1; k >= 0 && stack[k]!.depth === undefined && text[at] === stack[k]!.close; k--) at++
  return at > end && /^(?:[\s,;"'`]|\\+["'`]|$)/.test(text.slice(at, at + 2))
}

/** Credential words a name ends in. */
const credentialWord = "(?:KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL)S?"

/**
 * A name's separator: `=`, `:` or `=>`, after any quote that closes the name.
 * In a durable row it stays on the name's line; a diagnostic also reads a
 * value on the next line (`password:` then the value), which is how a stream
 * redactor sees it arrive.
 */
const separator = (space: string): string => String.raw`(?:\\*["'\x60])?${space}(?:=>|[=:])${space}`

/**
 * A credential name and its separator. Start once per identifier, including
 * leading underscores, so a name containing many underscores cannot force
 * repeated scans of its suffix. The name may close a quote of its own
 * (`'password':`, `\"token\":`), so a key in a Python repr, an inspected
 * `Map` or escaped JSON meets the rule too.
 */
const credentialName = String.raw`(?<![A-Za-z0-9_-])([A-Za-z0-9_-]*${credentialWord})`

const credentialNames = new RegExp(credentialName + separator("[ \\t]*"), "gi")

const diagnosticNames = new RegExp(credentialName + separator(String.raw`\s*`), "gi")

/** Header names whose whole value is a credential whatever its scheme. */
const headerNames = new RegExp(
  String.raw`((?:proxy-)?authorization|(?:set-)?cookies?)${separator(String.raw`\s*`)}`,
  "gi"
)

/** Any credential or header name, to stop a bare value before the next pair. */
const anyName = new RegExp(`${credentialNames.source}|${headerNames.source}`, "gi")

/** A credential or header name and its separator ending the text before a quote. */
const nameBefore = new RegExp(`(?:${credentialNames.source}|${headerNames.source})$`, "i")

/**
 * The index of the next credential or header name at or after `from`; with
 * `quoted`, only a name written right after a quote.
 */
const nextName = (text: string, from: number, quoted: boolean): number => {
  // No name starts between a search's start and what it found, so a later
  // search from inside that span has the same answer. Values are read left to
  // right, so this keeps every search over one text linear in total.
  const cached = nameSearches[quoted ? 1 : 0]!
  if (cached.text === text && from >= cached.from && from <= cached.found) return cached.found
  let found = text.length
  anyName.lastIndex = from
  for (let match = anyName.exec(text); match !== null; match = anyName.exec(text)) {
    if (!quoted || isQuote(text[match.index - 1])) {
      found = match.index
      break
    }
  }
  nameSearches[quoted ? 1 : 0] = { text, from, found }
  return found
}

/** The last search for any name and for a quoted name. */
const nameSearches = [{ text: "", from: 0, found: 0 }, { text: "", from: 0, found: 0 }]

/**
 * How far a value may run.
 *
 * A diagnostic is read once, so it errs toward hiding: a bare value runs over
 * several words to the end of its line, and a string or container the text
 * never closes runs to the end of the text, which is how a value cut by a
 * bound still ends redacted. A journal row is permanent, so there a bare value
 * is one token, `Foo {`, `[Object: null prototype] {` and `new X(` included,
 * and an unclosed string or container stops at the end of its line: a stray
 * backtick in an agent's Markdown must not erase the rest of the row.
 */
interface Scope {
  readonly header: boolean
  readonly diagnostic: boolean
}

/** The end of the line `index` is on. */
const lineEnd = (text: string, index: number): number => {
  // Every index up to a line's end shares that end, so the last answer serves
  // each later value on the same line.
  if (lastLine.text === text && index >= lastLine.from && index <= lastLine.end) return lastLine.end
  newline.lastIndex = index
  const end = newline.exec(text)?.index ?? text.length
  lastLine = { text, from: index, end }
  return end
}

const newline = /[\r\n]/g

let lastLine = { text: "", from: 0, end: 0 }

/**
 * Whether the whitespace at `end` continues the one-token value that began at
 * `start`: `util.inspect` separates a constructor or a marker from its
 * contents (`Foo {`, `Map(1) {`, `[Object: null prototype] {`, `<ref *1> {`,
 * `new Password(`).
 */
const continuesAcrossSpace = (text: string, start: number, end: number): number | undefined => {
  const run = text.slice(start, end)
  let next = end
  while (text[next] === " " || text[next] === "\t") next++
  if (run === "new") return next
  const prefix = /^[\w$.]+$/.test(run) || /[)\]>]$/.test(run)
  return prefix && closers[text[next] ?? ""] !== undefined ? next : undefined
}

/**
 * Whether the `,`, `;` or `&` at `end` separates pairs rather than sitting
 * inside a value (`Zq7;Syn,thetic`, `Tr0ub(4dor)&3`): a space or another name
 * follows it, and for `&`, a query parameter (`&page=2`).
 */
const separatesPairs = (text: string, end: number): boolean =>
  text[end] === "&"
    ? /^&[A-Za-z_][\w.-]*=/.test(text.slice(end, end + 64))
    : /^[,;](?:\s|$|\s*\\*["'`]?[A-Za-z_][\w.-]*\\*["'`]?\s*(?:=>|[=:]))/.test(text.slice(end, end + 64))

/**
 * The end of the bare value at `start`, read as a run of tokens: words,
 * balanced containers anywhere in it (`{bcrypt}$2a$...`, `Tr0ub(4dor)&3`,
 * `Some("x")`), inspect markers (`<Buffer 73 65>`, `<ref *1>`), and quoted
 * parts. `stack` is what is open before the name: the value stops at a quote
 * that closes the enclosing string, at a closer that closes the enclosing
 * bracket, and before the next credential name.
 */
const bareValueEnd = (
  text: string,
  start: number,
  scope: Scope,
  stack: ReadonlyArray<Open>
): number => {
  const inner = stack[innermostString(stack)]
  // A durable value never reads an unclosed quote past its line, nor a
  // bracket past a 4 KiB window, and one it cannot close stops at its line:
  // each unbalanced bracket costs a bounded scan, not the rest of the text.
  const bound = scope.diagnostic ? text.length : lineEnd(text, start)
  const window = scope.diagnostic ? text.length : Math.min(text.length, start + 4096)
  // Never before the opener: a closed container may already have carried the
  // value past its first line.
  const unclosed = (open: number, end: number): number => Math.max(open, Math.min(end, bound))
  // A durable container first reads its own line. A pretty-printer only
  // continues one on the next line after the opener or a member's comma
  // (`apiKey: {`, `credentials: { a: 1,`), so only then does the scan read on
  // through the window.
  const container = (open: number): number => {
    if (scope.diagnostic) return skipContainer(text, open, window)
    const end = skipContainer(text, open, bound)
    return lastClosed || !/[[{(,]\s*$/.test(text.slice(open, bound)) ? end : skipContainer(text, open, window)
  }
  let end = start
  // The value's own first token is never the next name: in
  // `api_key=lowercase-secret:end` the value only looks like a `name:` pair.
  let limit = nextName(text, start + 1, scope.header)
  // A header value that is one container ends with it: `"cookie":["sid=a"],`.
  if (scope.header && closers[text[start]!] !== undefined) {
    end = container(start)
    if (!/^[^\s,;"'`\\)\]}]/.test(text[end] ?? " ")) return lastClosed ? end : unclosed(start, end)
  }
  while (end < text.length) {
    if (end >= limit) {
      if (end === limit) break
      limit = nextName(text, end, scope.header)
      continue
    }
    const char = text[end]!
    if (closers[char] !== undefined) {
      const open = end
      end = container(open)
      // An unbalanced container runs on, spaces included.
      if (!lastClosed) return unclosed(open, end)
      continue
    }
    if (char === "<") {
      angleClose.lastIndex = end
      const close = angleClose.exec(text)?.index
      if (close !== undefined && text[close] === ">") {
        end = close + 1
        continue
      }
    }
    let depth = 0
    while (text[end + depth] === "\\") depth++
    const quote = text[end + depth]
    if (isQuote(quote)) {
      // A quote at the enclosing string's depth or shallower closes it,
      // whatever precedes it (`Basic abc=`), unless a credential name and
      // separator precede it (`credential:"`). Inside a bracket, a field's
      // value ends at a quote (`{\"token\":abc\"}`). Any other quote opens a
      // quoted part of the value (`username="admin"`, `it's`).
      const closesString = inner !== undefined && quote === inner.close &&
        depth % (2 * (inner.depth! + 1)) <= inner.depth! &&
        !nameBefore.test(text.slice(Math.max(start, end - 256), end))
      if (closesString || (!scope.header && inner === undefined && stack.length > 0)) break
      // A quote between two word characters is an apostrophe (`it's`).
      if (depth === 0 && /\w/.test(text[end - 1] ?? "") && /\w/.test(text[end + 1] ?? "")) {
        end++
        continue
      }
      const open = end
      end = skipQuoted(text, end + depth, depth, 2 * (depth + 1), bound)
      if (!lastClosed) return unclosed(open, end)
      continue
    }
    if (char === "\r" || char === "\n") break
    // Inside a bracket a `,` or `;` separates members; in raw text it does
    // when a space or another name follows.
    if (
      !scope.header &&
      ((char === "&" && separatesPairs(text, end)) ||
        ((char === "," || char === ";") && (stack.length > 0 || separatesPairs(text, end))))
    ) break
    if (!scope.header && !scope.diagnostic && (char === " " || char === "\t")) {
      const next = continuesAcrossSpace(text, start, end)
      if (next === undefined) break
      end = next
      continue
    }
    if (closesEnclosing(text, end, stack)) break
    end++
  }
  while (end > start && /\s/.test(text[end - 1]!)) end--
  return end
}

/**
 * Whether a name ending in `key` or `keys` is not a credential's: it counts
 * only where {@link isSensitiveKey} agrees, as it does for the same name as an
 * object key (`apiKeys` counts; `keys`, `sortKeys`, `idempotencyKey` and
 * `monkey` do not).
 */
const plainKeyName = (name: string): boolean => /keys?$/i.test(name) && !isSensitiveKey(name)

/**
 * Whether a name that matched a credential word names a credential: not a
 * {@link plainKeyName}, and not a count under a plural `tokens` name
 * (`max_tokens: 4096`), which is accounting.
 */
const namesCredential = (name: string, value: string): boolean =>
  !plainKeyName(name) &&
  !(/tokens$/i.test(name) && /^["'`]?\d+(?![\w.])/.test(value))

/** The `>` that closes an inspect marker, or the line end that means there is none. */
const angleClose = /[>\r\n]/g

/** The `+` with which `util.inspect` continues a long string on the next line. */
const continuation = /\s*\+\s*/y

/** A value an earlier pass already replaced. */
const alreadyRedacted = /^\[REDACTED\]$/

/**
 * Redacts the value after each name `names` matches. A quoted value is
 * consumed whole at any string-escape depth, with the pieces `util.inspect`
 * joins with `+` across lines, and its quotes are kept around the
 * placeholder; a bare value is consumed as a run of tokens. A name that ends
 * in `key` counts only where {@link isSensitiveKey} agrees, so `sortKey` and
 * `idempotencyKey` keep their values, and a count under a plural `tokens`
 * name, `max_tokens: 4096`, is accounting and is kept too.
 */
const redactValues = (text: string, names: RegExp, scope: Scope): string => {
  const keys = new RegExp(names.source, names.flags)
  let output = ""
  let position = 0
  // What is open before the current value. Values are skipped, so a bracket
  // or quote inside a credential never counts.
  const stack: Array<Open> = []
  let scanned = 0
  for (let match = keys.exec(text); match !== null; match = keys.exec(text)) {
    const name = match[1]!
    if (!scope.header && plainKeyName(name)) continue
    track(stack, text, scanned, keys.lastIndex)
    scanned = keys.lastIndex
    let start = keys.lastIndex
    let depth = 0
    while (text[start + depth] === "\\") depth++
    const opener = text[start + depth]
    const quote = isQuote(opener) ? opener! : undefined
    let end: number
    if (quote !== undefined) {
      start += depth
      const inner = stack[innermostString(stack)]
      if (inner !== undefined) {
        // Inside a string written with another quote character, every
        // backslash is doubled again: `inspect` renders `"a\"b"` as
        // `'"a\\"b"'`.
        end = skipQuoted(text, start, depth, (inner.close === quote ? 1 : 2 * (inner.depth! + 1)) * 2 * (depth + 1))
      } else {
        // No enclosing string is visible: raw text, or a string `track` cannot
        // see. Close no earlier than a doubled string would, but never past the
        // next credential name: at the undoubled close when only separators
        // precede that name (`"abc\\", password=`), else at the name.
        const undoubled = skipQuoted(text, start, depth)
        end = skipQuoted(text, start, depth, Math.max(4, 2 * (depth + 1)))
        const next = nextName(text, undoubled, false)
        if (next < end) end = /^[\s,;&]*$/.test(text.slice(undoubled, next)) ? undoubled : next
      }
      const closed = end - start > 1 && text[end - 1] === quote
      if (!closed && !scope.diagnostic) end = Math.min(end, lineEnd(text, start))
      // `util.inspect` continues a long string on the next line with `+`.
      if (depth === 0) {
        for (continuation.lastIndex = end; continuation.test(text); continuation.lastIndex = end) {
          const piece = continuation.lastIndex
          if (!isQuote(text[piece])) break
          end = skipQuoted(text, piece, 0)
        }
      }
      if (alreadyRedacted.test(text.slice(start + 1, end - (text[end - 1] === quote ? 1 + depth : 0)))) continue
    } else {
      end = bareValueEnd(text, start, scope, stack)
      // A placeholder then a space is a value an earlier pass already bounded:
      // what follows it is the next part of the line, `{"statusCode":401}`.
      const bounded = text.startsWith(placeholder, start) && /\s/.test(text[start + placeholder.length] ?? "")
      const kept = end === start || bounded || alreadyRedacted.test(text.slice(start, end)) ||
        (/tokens$/i.test(name) && /^\d+(?![\w.])/.test(text.slice(start, end))) ||
        // A Bearer or Basic value the default rules already replaced keeps its scheme.
        (scope.header && /^(?:bearer|basic)\s+\[REDACTED/i.test(text.slice(start, start + 24)))
      if (kept) continue
    }
    const escape = quote === undefined ? "" : "\\".repeat(depth)
    const closed = quote !== undefined && end - start > 1 && text[end - 1] === quote
    output += text.slice(position, keys.lastIndex) + escape + (quote ?? "") + placeholder +
      (closed ? escape + quote : "")
    position = end
    scanned = end
    keys.lastIndex = end
  }
  return output + text.slice(position)
}

/**
 * What separates a flag from its value: whitespace on a command line, or
 * `", "` between two elements of a JSON or inspected array.
 */
const argumentSeparator = String.raw`(?:\s+|["'\x60]\s*,\s*["'\x60])`

/** A credential flag and the separator before its value. */
const credentialFlag = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])(--?[A-Za-z0-9_-]*${credentialWord})${argumentSeparator}`,
  "gi"
)

/** `-p` and the separator before its value, unless the value is a path or a long option. */
const shortPasswordFlag = new RegExp(
  String.raw`(?<![^\s"'\x60,[(])-p${argumentSeparator}(?!(?:\.{0,2}|~)\/|--)`,
  "g"
)

/**
 * A flag that always takes a password, and the separator before it: `plink
 * -pw`, openssl's `-pass`, `-passin` and `-passout` (`pass:secret`), `-passwd`.
 */
const passwordFlag = new RegExp(
  String.raw`(?<![^\s"'\x60,[(])-p(?:w|ass(?:in|out|wd)?)${argumentSeparator}`,
  "g"
)

/** `-p` with a value attached, unless the word is a known single-dash option. */
const attachedPasswordFlag = new RegExp(
  String
    .raw`(?<![^\s"'\x60,[(])-p(?!(?:rint\w*|rune|erm|ath|threads?|edantic[\w-]*|ipe|ie|g|retty|lain|rogress|rofile|arents|reserve|ass(?:in|out|wd)?|w)(?![^\s"'\x60,\]]))(?=[^\s,\]])`,
  "g"
)

/** `-u` or `--user` and the separator before its value. */
const userFlag = new RegExp(String.raw`(?<![^\s"'\x60,[(])(?:-u|--user)(?:=|${argumentSeparator})`, "g")

/** The placeholder alone, bare, quoted or escaped: a second pass leaves it alone. */
const redactedArgument = /^(?:\\*(["'`]))?\[REDACTED\](?:\\*\1)?$/

/**
 * The end of the unquoted argument at `start`. It runs to whitespace or a
 * quote, and on through a quoted part written against it (`abc'def'`, which a
 * shell reads as one argument) when that part closes before any whitespace
 * and holds none of `,:{}[]`. Any other quote ends it: the close of a string
 * the command line sits in (`{"cmd":"mysql -p abc","next":1}`).
 */
const wordEnd = (text: string, start: number): number => {
  let end = start
  while (end < text.length && !/\s/.test(text[end]!)) {
    const quote = text[end]!
    if (!isQuote(quote)) {
      end++
      continue
    }
    let close = end + 1
    while (close < text.length && !/[\s"'`,:{}[\]]/.test(text[close]!)) close++
    if (close === end + 1 || text[close] !== quote) break
    end = close + 1
  }
  return end
}

/**
 * Redacts the value after each flag `flags` matches: a quoted value, or one
 * argv word, which ends at whitespace or a quote, so the same rule reads a
 * command line joined by spaces, a JSON array and an inspected array. A comma
 * or a `]` is part of a password on a command line (`-p abc,def`); in an
 * array the element's closing quote ends it first.
 */
const redactArguments = (
  text: string,
  flags: RegExp,
  /** Whether this flag and value are a credential at all. */
  accept?: (match: RegExpExecArray, value: string) => boolean
): string => {
  const pattern = new RegExp(flags.source, flags.flags)
  let output = ""
  let position = 0
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const start = pattern.lastIndex
    let depth = 0
    while (text[start + depth] === "\\") depth++
    let end = start
    if (isQuote(text[start + depth])) end = skipQuoted(text, start + depth, depth)
    else end = wordEnd(text, start)
    const value = text.slice(start, end)
    if (end === start || redactedArgument.test(value) || accept?.(match, value) === false) continue
    output += text.slice(position, start) + placeholder
    position = end
    pattern.lastIndex = end
  }
  return output + text.slice(position)
}

const durable: Scope = { header: false, diagnostic: false }

/**
 * Best-effort textual rules for credential shapes observed in real reports.
 * Every replacement reaches a fixed point so replaying or exporting an entry
 * cannot mutate it again.
 *
 * @since 0.1.0
 * @category constants
 */
export const defaultRules: ReadonlyArray<Rule> = [
  {
    id: "private-key-block",
    // Stop an unterminated block at the next header so repeated headers cannot
    // each rescan the remaining input. A valid PEM body contains no headers.
    // A block with no footer is a key a bound or a producer truncated, and its
    // body is as secret as a whole one's, so it runs to the next header or to
    // the end of the text. It runs first: a block inside URL userinfo, once
    // replaced, is userinfo the URL rule then reads whole, so a second pass
    // finds nothing left to change.
    pattern:
      /-----BEGIN[^-]*PRIVATE KEY(?: BLOCK)?-----(?:(?!-----BEGIN)[\s\S])*?(?:-----END[^-]*-----|(?=-----BEGIN)|$)/g
  },
  {
    id: "url-credentials",
    // The scheme is bounded rather than open. `-` is not a word character, so
    // `\b[a-z][a-z0-9+.-]*` starts a fresh scan after every hyphen, and on a
    // long run of that shape the rule rescanned the tail from each one: 400 kB
    // of `aaaaaaaa-` cost 11 seconds, on the path every journal write and every
    // log line takes. A scheme longer than 30 characters is not one this net is
    // for, and the cap makes each start position cost a constant.
    pattern: /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/]+):(?!\[REDACTED\]@)[^\s:@/]+@/gi,
    replace: "$1:[REDACTED]@"
  },
  {
    id: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{4,}=*/gi,
    replace: "Bearer [REDACTED_TOKEN]"
  },
  {
    id: "basic-authorization",
    pattern: /\bBasic\s+[A-Za-z0-9+/]{4,}={0,2}/gi,
    replace: "Basic [REDACTED_TOKEN]"
  },
  {
    id: "jwt",
    // Check the three segments once per token before looking for a header.
    // Starting at every `-eyJ` would rescan a malformed token's entire tail.
    // Preserve any prefix so a JWT following a hyphen still gets redacted.
    pattern:
      /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-])([A-Za-z0-9_-]*?)\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replace: "$1[REDACTED_TOKEN]"
  },
  {
    id: "api-key",
    // Not `\b`, for the reason the assignment rule below gives: an underscore
    // is a word character, so `\bsk` never fires after `ANTHROPIC_` or after
    // Effect's log-span sanitizer folds `token=` into `token_`. The lookbehind
    // excludes only letters and digits, so a key still reads as a key when an
    // underscore or a hyphen runs into it.
    pattern: /(?<![A-Za-z0-9])(?:sk|pk)[-_][A-Za-z0-9][A-Za-z0-9_-]{7,}/g,
    replace: "[REDACTED_API_KEY]"
  },
  {
    id: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
    replace: "[REDACTED]"
  },
  {
    id: "github-fine-grained-token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}(?![A-Za-z0-9_])/g,
    replace: "[REDACTED]"
  },
  {
    id: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: "[REDACTED]"
  },
  {
    id: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g,
    replace: "[REDACTED]"
  },
  {
    id: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35,}(?![0-9A-Za-z_-])/g,
    replace: "[REDACTED]"
  },
  {
    id: "assignment",
    // A credential name, `:`, `=` or `=>`, and its whole value: quoted at any
    // escape depth, a container, or several bare words. See `redactValues`.
    pattern: credentialNames,
    rewrite: (text) => redactValues(text, credentialNames, durable)
  },
  {
    id: "credential-flag",
    // `--password hunter2`, `--api-key "a b"`, or the same pair as two argv
    // elements. `--token=x` is an assignment above; this is the spelling a
    // command line separates with a space. The next word is the value even
    // when it starts with `-`: a credential flag always takes one.
    pattern: credentialFlag,
    rewrite: (text) =>
      redactArguments(text, credentialFlag, (match, value) => namesCredential(match[1]!.replace(/^-+/, ""), value))
  },
  {
    id: "cookie-session-assignment",
    pattern:
      /(?<![A-Za-z0-9-])((?:COOKIE|SESSION)S?)(\s*=\s*)(?!\[REDACTED\])("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?!["'])[^\s;,]+)/gi,
    replace: "$1$2[REDACTED]"
  }
]

/**
 * The rules for a diagnostic: {@link defaultRules} and the spellings too broad
 * for a durable row.
 *
 * A log line, a stderr message, and an error handed to a remote caller are
 * read once, so a false positive costs a word of context. A journal row is
 * permanent, so the same false positive destroys data. These rules sit on the
 * diagnostic side of that line: an authorization header in any scheme, bare
 * URL userinfo (`https://token@host`), a signed query parameter, and the value
 * of a `-p` flag, which is a password to `mysql` and `sshpass` and a path to
 * `mkdir`. A path, a port and a lowercase word attached to `-p` (`-print`,
 * `-path`) are left alone.
 *
 * @since 1.0.0
 * @category constants
 */
export const diagnosticRules: ReadonlyArray<Rule> = [
  ...defaultRules.map((rule): Rule =>
    rule.id === "assignment"
      ? {
        id: "assignment",
        pattern: diagnosticNames,
        rewrite: (text) => redactValues(text, diagnosticNames, { header: false, diagnostic: true })
      }
      : rule
  ),
  {
    id: "authorization-header",
    // The header value is a credential whatever its scheme (`Token`, a cookie
    // list, `Digest` with quoted parameters), so the value runs to the end of
    // its line or the close of the string it was written in.
    pattern: headerNames,
    rewrite: (text) => redactValues(text, headerNames, { header: true, diagnostic: true })
  },
  {
    id: "bearer-or-basic",
    // A token shorter than the default rules' minimum. A lowercase `basic` is
    // prose ("a basic example"), so only the scheme's own spellings count.
    pattern: /(\b(?:[Bb]earer|BEARER|Basic|BASIC)\s+)(?!\[REDACTED)[^\s,;"'\\]+/g,
    replace: "$1[REDACTED]"
  },
  {
    id: "password-flag",
    // The whole next argument, a path or a leading `-` included.
    pattern: passwordFlag,
    rewrite: (text) => redactArguments(text, passwordFlag)
  },
  {
    id: "sshpass-password",
    // `sshpass -p` always takes a value, even one that starts with `--`,
    // which `mysql -p --database x` reads as the next option.
    pattern: /(\bsshpass(?:\s+-[^\sp]\S*){0,8}\s+-p\s+)--(?!\[REDACTED\])[^\s"'`]*/g,
    replace: "$1[REDACTED]"
  },
  {
    id: "user-flag",
    // `curl -u user:pass`, `--user=user:pass`, quoted or not: the whole
    // argument, commas included, when it carries a `:`.
    pattern: userFlag,
    rewrite: (text) => redactArguments(text, userFlag, (_match, value) => value.includes(":"))
  },
  {
    id: "url-userinfo",
    pattern: /(\/\/)(?!\[REDACTED\]@)[^/@\s"'\\]+@/g,
    replace: "$1[REDACTED]@"
  },
  {
    id: "signed-query",
    pattern: /([?&][\w.-]*(?:key|sig|signature|auth|credential)=)(?!\[REDACTED\])[^&#\s"'\\]+/gi,
    replace: "$1[REDACTED]"
  },
  {
    id: "short-password-flag",
    // A path is kept, and so is a flag: `mysql -p --database x` prompts for
    // the password rather than taking one.
    pattern: shortPasswordFlag,
    rewrite: (text) => redactArguments(text, shortPasswordFlag)
  },
  {
    id: "attached-password-flag",
    // `-psecret`. The single-dash words that start with `p` and are not a
    // password, `find -print` and the compilers' `-pthread` among them, are kept.
    pattern: attachedPasswordFlag,
    rewrite: (text) => redactArguments(text, attachedPasswordFlag)
  }
]

/**
 * Redacts one diagnostic value with {@link diagnosticRules}: a log line, a
 * stderr message, an error handed back to a caller.
 *
 * Every diagnostic path shares this one function, and it runs on the value
 * before anything renders or bounds it. Redacting a rendering line by line, or
 * after a bound, is how a secret escaped: `util.inspect` splits a long string
 * over several lines, and a bound cuts a quoted value before its closing
 * quote. A value past {@link maxDepth} is named rather than thrown.
 *
 * @since 1.0.0
 * @category redaction
 */
export const redactDiagnostic = (value: unknown): unknown =>
  redact(value, { rules: diagnosticRules, onTooDeep: "name" })

/**
 * Credential names this module refuses to persist, matched as suffixes of the
 * separator-free lowercase form of a key.
 *
 * The list is the union of the names `packages/smithers/src/Bug.ts` redacts
 * structurally, because the journal is the PERMANENT side of that pair: a bug
 * report is one upload an operator reviews before it leaves the machine, while
 * `flows_journal_events.payload_json` is replayed verbatim to every sync
 * subscriber and time-travel consumer forever. The journal redacting less than
 * the report inverts the risk, and it did: `credential`, `credentials`, `dsn`,
 * and `connectionString` all round-tripped through a durable row in clear.
 *
 * Two families are spelled out rather than reduced to a shorter word, because
 * these are SUFFIX tests: `connectionString` does not end in `connection`, and
 * `secretKey` does not end in `secret`. A bare `key` suffix is not on the list
 * for the opposite reason: it would redact `monkey` and `turkey`.
 *
 * `signature` stays, and a field it costs is renamed rather than excused. A
 * name test cannot tell a MAC computed with a secret from a digest over public
 * input, and both are called `signature`: `WorkspaceShare` signs its claims
 * with `ShareSigner.signHmac` and that value IS the share's authorization,
 * `GrantStore` carries envelope signatures, and the GitHub, Linear and
 * Telegram webhook readers all verify a header by that name. Against those, a
 * digest whose whole purpose is to be reconciled costs nothing to rename and
 * everything to leave unreadable -- see
 * `AgentEvent.VacuousVerificationObserved.callDigest`, which was `signature`
 * and reached durable rows as the placeholder.
 */
const sensitiveKeySuffixes = [
  "auth",
  "authorization",
  "cookie",
  "apikey",
  "token",
  "password",
  "passphrase",
  "secret",
  "secretaccesskey",
  "credential",
  "dsn",
  "connection",
  "connectionstring",
  "connectionuri",
  "connectionurl",
  "secretkey",
  "privatekey",
  "sshkey",
  "signingkey",
  "signature",
  "encryptionkey",
  "session",
  "sessionkey"
]

/**
 * A trailing `key` that is a word of its own.
 *
 * Read against the ORIGINAL key, where the separators that make `key` a word
 * still exist: `key`, `api_key`, `x-api-key`, `signing-key`. This is the shape
 * `packages/smithers/src/Bug.ts` matches, and stopping here is deliberate. Treating
 * a camel-case hump as a separator too, `/[a-z0-9]Key$/`, looks equivalent and
 * is not: it redacted `idempotencyKey`, the durable identity an effect boundary
 * replays on, out of `@smthrs/engine-store`'s journal rows. A credential-named
 * key is covered by {@link sensitiveKeySuffixes} instead, where the word before
 * `key` has to be one that names a secret.
 */
const trailingKeyWord = /(?:^|[^A-Za-z0-9])key$/i

const canonicalKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "")

/** Numeric accounting fields that contain counts, never bearer material. */
const tokenCounterKeys: ReadonlySet<string> = new Set([
  "inputtoken",
  "outputtoken",
  "cachedinputtoken",
  "reasoningtoken",
  "totaltoken"
])

/**
 * A bare plural `tokens` is a count too: `Envelope.budget.tokens` is the run's
 * token ceiling, and redacting it erased every journaled budget. A singular
 * `token` stays bearer material even when it is numeric.
 */
const isTokenCount = (key: string, value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
  (tokenCounterKeys.has(canonicalKey(key)) || key.toLowerCase() === "tokens")

/**
 * Whether a field name names a credential.
 *
 * Case and separators are ignored, so `api_key`, `apiKey`, and `x-api-key` are
 * all recognised, one trailing plural `s` is stripped so `credentials` reads as
 * `credential`, and a trailing `key` counts where it is a word of its own or
 * where the word before it names a secret.
 *
 * The rule is a suffix test, not a substring test. `tokenizer`, `secretary`,
 * `monkey`, and `idempotencyKey` are ordinary field names, and replacing their
 * values would destroy data in a permanent row without protecting anything.
 * That is the one place this rule is deliberately narrower than
 * `packages/smithers/src/Bug.ts`'s substring form, which can afford the false
 * positives because its output is a single report an operator reads once.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isSensitiveKey = (key: string): boolean => {
  if (trailingKeyWord.test(key)) return true
  const canonical = canonicalKey(key)
  return sensitiveKeySuffixes.some((suffix) => canonical.endsWith(suffix))
}

const redactMember = (
  key: string,
  value: unknown,
  walk: (value: unknown) => unknown
): unknown => isSensitiveKey(key) && !isTokenCount(key, value) ? placeholder : walk(value)

/**
 * A field name with a credential in it replaced outright, not rewritten in place.
 *
 * Redacting part of a key changes what the key reads as. `secret=sk-` rewrites
 * to `secret=[REDACTED]`, which now ENDS in a sensitive name, so a second
 * application would replace a value the first one left alone and redaction
 * would stop being a fixed point. Naming the whole key holds the verdict still:
 * `[REDACTED]` matches no rule and names no credential. Two such keys collapse
 * into one and the later member wins, which is the fidelity trade every other
 * marker here makes.
 */
const redactKey = (key: string, rules: ReadonlyArray<Rule>): string => {
  const redacted = redactString(key, rules)
  return redacted === key ? key : placeholder
}

/**
 * How many times {@link redactString} re-applies the rules to reach a fixed
 * point. Rules feed each other: an assignment redacted inside URL userinfo
 * leaves userinfo the URL rule only then matches. Text no rule touches costs
 * one pass, and the default rules settle within three. Text that has not
 * settled after the last pass is replaced whole.
 */
const fixedPointPasses = 8

/**
 * A copy of `pattern` that matches wherever `pattern` does, with no
 * lookbehind, or `null`. JavaScriptCore runs a pattern that has a lookbehind
 * in its interpreter, 30 to 70 times slower than compiled: 40 kB of prose cost
 * a Bun process 300 ms per diagnostic, where Node took 1 ms. Text the copy
 * never matches is text the rule cannot change, so the rule is skipped.
 *
 * Only a one-character negative lookbehind that starts the pattern is
 * rewritten, as a character the copy consumes, which keeps a name scan
 * starting once per identifier. Anywhere else, after `\b` or inside a
 * repeated group, the consumed character would make the copy stricter than
 * the rule, so any other lookbehind or a backreference leaves the rule
 * unfiltered.
 */
const candidate = (pattern: RegExp): RegExp | null => {
  const cached = candidates.get(pattern)
  if (cached !== undefined) return cached
  const leading = /^\(\?<!\[(\^?)((?:\\.|[^\]\\])*)\]\)/.exec(pattern.source)
  const rest = leading === null ? pattern.source : pattern.source.slice(leading[0].length)
  const compiled = /\(\?<[!=]|\\(?:[1-9]|k<)/.test(rest)
    ? null
    : new RegExp(
      leading === null ? rest : `(?:^|[${leading[1] === "" ? "^" : ""}${leading[2]}])${rest}`,
      pattern.flags.replace(/[gy]/g, "")
    )
  candidates.set(pattern, compiled)
  return compiled
}

const candidates = new WeakMap<RegExp, RegExp | null>()

const applyRule = (text: string, rule: Rule): string => {
  if (candidate(rule.pattern)?.test(text) === false) return text
  return rule.rewrite === undefined ? text.replace(rule.pattern, rule.replace ?? placeholder) : rule.rewrite(text)
}

const redactString = (value: string, rules: ReadonlyArray<Rule>): string => {
  let text = value
  for (let pass = 0; pass < fixedPointPasses; pass++) {
    const next = rules.reduce(applyRule, text)
    if (next === text) return text
    text = next
  }
  // Rules that never settle would let an exported row keep changing, and
  // what they left may still hold a credential. Fail closed.
  return placeholder
}

/**
 * Maximum number of container edges traversed from a redaction root.
 *
 * Journal event schemas never approach 256 nested containers. This bound is
 * far above practical payloads while keeping traversal safely below Node's
 * call-stack limit for hostile input.
 *
 * @since 1.0.0
 * @category constants
 */
export const maxDepth = 256

/**
 * Options for {@link redact}.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly rules?: ReadonlyArray<Rule> | undefined
  /**
   * What a value nested past {@link maxDepth} does.
   *
   * `"throw"`, the default, is the journal's contract: a payload that deep is a
   * caller bug, and a durable row quietly truncated to a marker is worse than a
   * refused write. `"name"` is what a LOGGER wants, because a throw there is
   * caught one frame up and replaces EVERY argument on the line with
   * `[Unrenderable]`, so one deep member would cost the operator the whole line.
   */
  readonly onTooDeep?: "throw" | "name" | undefined
}

/**
 * How many bytes a view may hold, and how many own members {@link redact} reads
 * off it, before it stops reading them.
 *
 * Enumerating a view's own properties materialises one pair per byte, so the
 * walk costs the buffer's size even though the rendering does not. Both halves
 * of the bound carry load, and neither is a bound on its own. A size alone is
 * not, because `byteLength` was read as an ordinary property and an ordinary
 * property can be shadowed: a pooled chunk that reports the bytes it has used
 * rather than the bytes it holds is a plain pattern, not an adversarial one,
 * and a 4 MB chunk reporting 12 walked one property per byte anyway. A count
 * alone is not, because a caller can hang a million properties on a ten-byte
 * view. So the size is read from the value's own internal slot, where nothing
 * a caller writes can answer for it, and the members are counted as they are
 * walked.
 *
 * @since 0.1.0
 * @category redaction
 */
export const binaryWalkLimit = 65_536

/**
 * The byte-length getters, taken from the prototypes rather than from a value.
 *
 * `%TypedArray%.prototype`, `DataView.prototype` and `ArrayBuffer.prototype`
 * each define `byteLength` as an accessor over an internal slot, and applying
 * one to a value that has no such slot throws. Reading the size this way is
 * therefore a brand check as well as a measurement: a caller's own `byteLength`
 * property, accessor or not, never answers it.
 */
const byteLengthGetters = [
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype) as object, "byteLength")!.get!,
  Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")!.get!,
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!
] as ReadonlyArray<() => number>

/** A value's byte length from its own internal slot, or `undefined` when it has none. */
const byteLength = (node: object): number | undefined => {
  for (const getter of byteLengthGetters) {
    try {
      return Reflect.apply(getter, node, [])
    } catch {
      // Not that kind of view. Another getter answers, or none does and the
      // bytes are named without the members being read.
    }
  }
  return undefined
}

/** The prototypes every binary view inherits from. */
const binaryPrototypes: ReadonlySet<unknown> = new Set([
  Object.getPrototypeOf(Uint8Array.prototype),
  DataView.prototype,
  ArrayBuffer.prototype
])

/** How many prototypes {@link isBinary} climbs before it stops asking. */
const prototypeWalkLimit = 64

/**
 * Whether `node` is a binary view, including one held behind a proxy.
 *
 * `ArrayBuffer.isView` reads an internal slot, and a proxy has none of its own,
 * so it answers `false` for a proxy over a view. That sent a proxied 2 MB
 * buffer to the object branch, which rebuilt it one key per byte: 2,000 ms and
 * 22.9 million characters for one logged value. A proxy forwards
 * `getPrototypeOf` to its target, so the prototype chain answers where the
 * brand check cannot. The climb is capped because a proxy is free to hand back
 * a fresh object every time it is asked, which is an endless chain.
 */
const isBinary = (node: object): boolean => {
  if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer) return true
  try {
    let prototype = Object.getPrototypeOf(node) as object | null
    for (let step = 0; prototype !== null && step < prototypeWalkLimit; step++) {
      if (binaryPrototypes.has(prototype)) return true
      prototype = Object.getPrototypeOf(prototype) as object | null
    }
  } catch {
    // A revoked proxy refuses to be asked. It is not a view, and the object
    // branch names it.
  }
  return false
}

/** Own keys of a binary view that name one of its bytes rather than a property. */
const indexKey = /^(?:0|[1-9][0-9]*)$/

/** `Uint8Array 1024 bytes`, or the bare marker when the value will not say. */
const describeBinary = (node: object, size: number | undefined): string => {
  if (size === undefined) return binaryMarker
  try {
    return `${node.constructor.name} ${size} bytes`
  } catch {
    return binaryMarker
  }
}

/**
 * The key {@link redact} files a binary view's size under.
 *
 * @since 0.1.0
 * @category redaction
 */
export const binaryMarker = "[Binary]"

/**
 * What {@link redact} writes in place of a function or a class object.
 *
 * @since 0.1.0
 * @category redaction
 */
export const functionMarker = "[Function]"

/**
 * What {@link redact} writes in place of a symbol.
 *
 * @since 0.1.0
 * @category redaction
 */
export const symbolMarker = "[Symbol]"

/**
 * What {@link redact} writes past {@link maxDepth} under `onTooDeep: "name"`.
 *
 * @since 0.1.0
 * @category redaction
 */
export const depthMarker = "[Deep]"

/**
 * Returns `value` with credentials removed.
 *
 * Objects and arrays are rebuilt: a field whose name {@link isSensitiveKey}
 * is replaced wholesale, every other string is run through the textual rules,
 * and a cycle is collapsed to `"[Circular]"` so the result always encodes.
 * A number, a boolean, `null` and `undefined` are returned untouched, because
 * redacting one destroys data without protecting anything. A function and a
 * symbol are NAMED, {@link functionMarker} and {@link symbolMarker}: a body, an
 * own property and a description are all text a renderer prints, and none of it
 * can be rewritten in place.
 *
 * Traversal accepts at most {@link maxDepth} container edges. A deeper value
 * throws by default, so the journal boundary can report a typed `invalid_event`
 * instead of overflowing the runtime stack. {@link Options.onTooDeep} set to
 * `"name"` writes {@link depthMarker} in its place instead, which is what a
 * logger wants.
 *
 * @since 0.1.0
 * @category redaction
 */
export const redact = (value: unknown, options?: Options): unknown => {
  const onTooDeep = options?.onTooDeep ?? "throw"
  const rules = globalRules(options?.rules ?? defaultRules)
  /**
   * A binary view named by its type and size, with its own properties walked.
   *
   * Its bytes are not text the rules can read, and rebuilding it from its
   * entries wrote one key per byte: a 100 kB buffer rendered 1.4 MB. Handing
   * the view back untouched is not the answer either, because `redact` is the
   * journal's own write path, so a caller's `apiKey` property hung on a buffer
   * went into a durable row in clear. Name the bytes, keep walking the text.
   */
  const binary = (node: object, ancestors: WeakSet<object>, depth: number): unknown => {
    const size = byteLength(node)
    // The description is text read off the value, so it meets the rules like
    // any other text: a class name is caller data, and a view whose
    // constructor is named after a credential wrote it into a durable row.
    const entries: Array<[string, unknown]> = [[binaryMarker, redactString(describeBinary(node, size), rules)]]
    // `Object.entries` on a view materialises one pair per byte before the
    // index filter can discard them, which cost 312 ms for 1 MB on the journal
    // write path. Past the bound the bytes are named and nothing else is read,
    // so a member a caller hung on a large view is dropped rather than shown.
    // A value that will not answer from its internal slot, such as a proxy over
    // a view, is named and never enumerated at all.
    if (size !== undefined && size <= binaryWalkLimit) {
      let walked = 0
      for (const [key, field] of Object.entries(node as Record<string, unknown>)) {
        // An index is one of the bytes just named, not a property a caller set.
        if (indexKey.test(key)) continue
        // The size bounds the bytes, not the properties: a caller can hang a
        // million members on a ten-byte view, and each one costs three rule
        // scans over its name and a walk of its value.
        if (walked >= binaryWalkLimit) break
        walked++
        entries.push([
          redactKey(key, rules),
          redactMember(key, field, (value) => walk(value, ancestors, depth + 1, key))
        ])
      }
    }
    // `Object.fromEntries`, not `named[key] = …`, for the reason the object
    // branch below gives: a literal `__proto__` key would route through the
    // inherited setter and the member would vanish from the row.
    return Object.fromEntries(entries)
  }

  const walk = (node: unknown, ancestors: WeakSet<object>, depth: number, key: string): unknown => {
    if (depth > maxDepth) {
      if (onTooDeep === "name") return depthMarker
      throw new Error(`redaction depth exceeds ${maxDepth}`)
    }
    if (typeof node === "string") return redactString(node, rules)
    // A function, a class object or a symbol carries text a walk never reaches
    // (own properties, a description, a body), and the renderer prints it. None
    // of it can be redacted in place, so the value is named instead.
    if (typeof node === "function") return functionMarker
    if (typeof node === "symbol") return symbolMarker
    if (node === null || typeof node !== "object") return node
    if (isBinary(node)) return binary(node, ancestors, depth)
    if (ancestors.has(node)) return "[Circular]"
    // A journal row is bounded by its schema, but a LOGGED value is arbitrary:
    // the logger sends every non-Error value here, and a chain deep enough to
    // exhaust the stack would throw while the line is rendering, killing the
    // run the line describes. Past the cap the value is named, the way a cycle
    // is named.
    ancestors.add(node)
    try {
      const toJSON = (node as { toJSON?: unknown }).toJSON
      // JSON.stringify passes the containing key (or "" at the root) to toJSON.
      // Reuse it when walking the replacement; siblings may share this object.
      if (typeof toJSON === "function") return walk(toJSON.call(node, key), ancestors, depth, key)
      if (Array.isArray(node)) {
        // `map` invokes the input's species constructor, which can restore
        // credential fields and inspection hooks after the elements are walked.
        // Rebuild a plain array, preserving the original length and holes.
        const length = node.length
        const result = new Array<unknown>(length)
        const elements = new Array<unknown>(length)
        for (let index = 0; index < length; index++) {
          if (!(index in node)) continue
          elements[index] = node[index]
          result[index] = walk(elements[index], ancestors, depth + 1, String(index))
        }
        // An argv keeps a flag and its value in two elements, so no rule sees
        // `--password hunter2` whole. The element after a flag is a credential
        // when its name says so (`--token=x` carries its own, and a count under
        // `--max-tokens` is kept), or when the active rules redact it read
        // after the flag and the elements before it (`-p`, `-pw`, `-passin`,
        // `sshpass -p`) differently than alone.
        for (let index = 0; index + 1 < length; index++) {
          // The values the first loop read, never a second read: a proxy may
          // answer a second `get` differently.
          const flag = elements[index]
          const value = elements[index + 1]
          if (typeof flag !== "string" || typeof value !== "string" || !/^-[^=\s]+$/.test(flag)) continue
          const name = flag.replace(/^-+/, "")
          const before = elements.slice(Math.max(0, index - 3), index + 1).filter((element) =>
            typeof element === "string"
          ).join(" ")
          const consumes = (isSensitiveKey(name) && namesCredential(name, value)) ||
            redactString(`${before} ${value}`, rules) !== `${redactString(before, rules)} ${redactString(value, rules)}`
          if (consumes) result[index + 1] = placeholder
        }
        return result
      }
      // `result[key] = …` routes a literal `__proto__` key through the
      // inherited setter, so the field would silently become the result's
      // prototype instead of a member: the payload loses data and redaction
      // stops being a fixed point. `Object.fromEntries` defines own data
      // properties and has no such hole.
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map((
          [key, field]
        ) => [
          // The KEY is text too. Rewriting only values let a credential used as
          // a log annotation key reach the operator, since Effect renders an
          // annotation as `key=value`, and become an OTLP span attribute name.
          redactKey(key, rules),
          redactMember(key, field, (value) => walk(value, ancestors, depth + 1, key))
        ])
      )
    } finally {
      ancestors.delete(node)
    }
  }
  return walk(value, new WeakSet(), 0, "")
}

/**
 * A redaction function, as the journal consumes it.
 *
 * @since 0.1.0
 * @category models
 */
export type Redactor = (value: unknown) => unknown

/**
 * Builds a redactor over a rule set.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (options?: Options): Redactor => (value) => redact(value, options)

/**
 * Applies a redactor to an already-encoded JSON string, returning the
 * re-encoded result.
 *
 * For export and display surfaces that hold a column verbatim, a rendered
 * `state_json`, a support bundle, where the value is already encoded and must
 * not be decoded into the executable path. A string that does not parse is
 * returned untouched: validation is the caller's, and rejecting here would
 * turn a redaction concern into a schema error. Once parsing succeeds, a
 * throwing redactor or an encoding failure returns the valid JSON string
 * `"[REDACTED]"`; the original parsed text is never returned.
 *
 * @since 0.1.0
 * @category redaction
 */
export const redactJsonString = (json: string, redactor: Redactor): string => {
  const decoded = Schema.decodeUnknownResult(UnknownFromJsonString)(json)
  if (Result.isFailure(decoded)) return json
  const attempted = Result.try(() => Schema.encodeUnknownResult(UnknownFromJsonString)(redactor(decoded.success)))
  if (Result.isFailure(attempted)) return JSON.stringify(placeholder)
  return Result.isSuccess(attempted.success) ? attempted.success.success : JSON.stringify(placeholder)
}

/**
 * Redacts a stream one line at a time.
 *
 * @since 1.0.0
 * @category models
 */
export interface LineRedactor {
  /**
   * Takes the rest of the current line, without its newline, and returns the
   * lines now safe to emit: none while a value is still open.
   */
  readonly line: (line: string) => ReadonlyArray<string>
  /**
   * Takes part of a line whose newline has not arrived. A line longer than
   * {@link maxPartialLine} is never emitted: {@link omittedLine} stands for it.
   */
  readonly part: (text: string) => void
  /** What {@link LineRedactor.flush} would emit now, without ending the stream: for a rendered snapshot. */
  readonly peek: () => ReadonlyArray<string>
  /** Ends the stream and returns whatever is still held, redacted as one block. */
  readonly flush: () => ReadonlyArray<string>
}

/**
 * Lines a {@link lineRedactor} holds for one open value. Past this, or past
 * 64 KiB, it stops holding: it emits what it held, redacted, and withholds
 * every later line until the stream ends, when one placeholder stands for
 * them. Dropping lines from the middle instead changed which brackets and
 * quotes were open, and released a later secret in clear.
 *
 * @since 1.0.0
 * @category constants
 */
export const maxHeldLines = 256

const maxHeldBytes = 64 * 1024

/**
 * The longest line a {@link lineRedactor} reads whole. A longer line keeps
 * its first and last 16 KiB; its middle is scanned for what it leaves open
 * and dropped.
 *
 * @since 1.0.0
 * @category constants
 */
export const maxPartialLine = 32 * 1024

/**
 * What a {@link lineRedactor} emits in place of a line longer than
 * {@link maxPartialLine}.
 *
 * @since 1.0.0
 * @category constants
 */
export const omittedLine = "[overlong line omitted]"

/**
 * A next line no rule redacts alone, which an open value swallows. The value
 * is open when the redacted text no longer ENDS with it: text before it may
 * contain the same word.
 */
const continuationProbe = "\n'probe'"

/** Rules with the global flag each rule needs to replace every match. */
const globalRules = (rules: ReadonlyArray<Rule>): ReadonlyArray<Rule> =>
  rules.map((rule) =>
    rule.pattern.flags.includes("g")
      ? rule
      : { ...rule, pattern: new RegExp(rule.pattern.source, `${rule.pattern.flags}g`) }
  )

/**
 * A redactor for a stream that must be emitted line by line: a live build
 * log, a child's stderr.
 *
 * Redacting each line alone is the flaw that leaked a private key's body, and
 * the tail of every string `util.inspect` split over several lines: only the
 * line holding the name was redacted. This one asks the rules themselves
 * whether a line leaves a value open, by checking whether the value swallows
 * a probe placed on the next line, and holds lines until it closes. The held
 * block is then redacted whole, exactly as {@link redact} redacts a string.
 *
 * A line longer than {@link maxPartialLine} is read as its first and last
 * 16 KiB. Its middle is dropped, but a bracket, quote or key block the middle
 * leaves open would have opened a value the kept ends cannot show, so then
 * the rest of the stream is withheld. Such a line is never emitted, only
 * {@link omittedLine}, and neither is any block it was held in.
 *
 * `rules` defaults to {@link diagnosticRules}. The array is read on every
 * line, so a caller may add a rule, a session secret, as the stream runs.
 *
 * @since 1.0.0
 * @category constructors
 */
export const lineRedactor = (rules: ReadonlyArray<Rule> = diagnosticRules): LineRedactor => {
  const held: Array<string> = []
  let heldBytes = 0
  let heldOverlong = false
  let withheld = false
  // The line still arriving: whole up to the bound, then a head, a rolling
  // tail, and what the dropped middle leaves open.
  const edge = maxPartialLine / 2
  let head = ""
  let tail = ""
  let overlong = false
  let middle: Array<Open> = []
  let middleKey = false
  let carry = ""
  const resetPartial = () => {
    head = ""
    tail = ""
    overlong = false
    middle = []
    middleKey = false
    carry = ""
  }
  const scanDropped = (dropped: string) => {
    track(middle, dropped, 0, dropped.length)
    const seen = carry + dropped
    const begin = seen.search(/-----BEGIN[^-]*PRIVATE KEY/)
    const lastBegin = seen.lastIndexOf("-----BEGIN")
    const lastEnd = seen.lastIndexOf("-----END")
    if (begin !== -1 || lastEnd !== -1) middleKey = lastBegin > lastEnd
    carry = seen.slice(-64)
  }
  const redacted = (text: string) => redactString(text, globalRules(rules))
  const release = (): ReadonlyArray<string> => {
    const text = redacted(held.join("\n"))
    const overlongBlock = heldOverlong
    held.length = 0
    heldBytes = 0
    heldOverlong = false
    return overlongBlock ? [omittedLine] : text.split("\n")
  }
  const part = (text: string): void => {
    if (withheld) return
    if (!overlong) {
      head += text
      if (head.length <= maxPartialLine) return
      overlong = true
      tail = head.slice(edge)
      head = head.slice(0, edge)
    } else tail += text
    if (tail.length > edge) {
      scanDropped(tail.slice(0, tail.length - edge))
      tail = tail.slice(-edge)
    }
  }
  const line = (rest: string): ReadonlyArray<string> => {
    if (withheld) {
      resetPartial()
      return []
    }
    part(rest)
    let text = head
    if (overlong) {
      const risky = middle.length > 0 || middleKey
      text = `${head} ${tail}`
      resetPartial()
      if (risky) {
        const before = held.length === 0 ? [] : [placeholder]
        held.length = 0
        heldBytes = 0
        heldOverlong = false
        withheld = true
        return [...before, omittedLine]
      }
      heldOverlong = true
    } else resetPartial()
    held.push(text)
    heldBytes += text.length + 1
    if (redacted(held.join("\n") + continuationProbe).endsWith(continuationProbe)) return release()
    if (held.length <= maxHeldLines && heldBytes <= maxHeldBytes) return []
    withheld = true
    return release()
  }
  const peek = (): ReadonlyArray<string> => {
    if (withheld) return [placeholder]
    const pending = overlong ? [omittedLine] : head === "" ? [] : [head]
    if (heldOverlong) return [omittedLine]
    const text = [...held, ...(overlong ? [] : pending)]
    const out = text.length === 0 ? [] : redacted(text.join("\n")).split("\n")
    return overlong ? [...out, omittedLine] : out
  }
  return {
    line,
    part,
    peek,
    flush: () => {
      const out = head !== "" || overlong ? [...line("")] : []
      if (withheld) {
        withheld = false
        return [...out, placeholder]
      }
      return held.length === 0 ? out : [...out, ...release()]
    }
  }
}

/**
 * The identity redactor, for a caller that persists payloads verbatim by
 * choice: a trusted single-tenant store, or a suite asserting on raw input.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeNoop = (): Redactor => (value) => value
