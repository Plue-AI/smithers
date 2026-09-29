/**
 * Renders an arbitrary failure value as one bounded, redacted diagnostic
 * string. The engine writes it to the log line that names an undeclared
 * failure, and the flow proxy logs it in place of the defect it dies with, so
 * a secret an implementation error carries never reaches a log file or a
 * remote caller verbatim.
 *
 * @since 1.0.0
 */

/**
 * A body failure rendered for one log line, bounded so an oversized payload
 * cannot flood the log the operator is reading it from.
 *
 * @private
 */
const diagnosticTextLimit = 512

/**
 * Field names whose value is a credential, in a message (`name=value`,
 * `"name":"value"`) or as an own property of a rendered failure.
 *
 * @private
 */
const secretName = "token|secret(?:[-_]?(?:access[-_]?)?key)?|password|api[-_]?key|credentials?|private[-_]?key"

const secretField = new RegExp(secretName, "i")

/**
 * Header names whose whole value is a credential whatever its scheme (`Basic`,
 * `Digest`, a cookie list).
 *
 * @private
 */
const headerName = "(?:proxy-)?authorization|(?:set-)?cookies?"

const separator = "[\"'\\\\]*\\s*(?:=>|[=:])\\s*"

const anyKey = new RegExp(`(?:${secretName}|${headerName})${separator}`, "gi")

// A credential or header name and its separator ending the text before a
// quote: that quote opens the name's value, whatever string encloses it.
const keyBefore = new RegExp(`(?:${secretName}|${headerName})${separator}$`, "i")

// Returns the index just past the quote that closes the string opened at
// `open`. A quote nested n strings deep sits behind `depth` = 2^n - 1
// backslashes, and the quote that closes it has that count modulo 2^(n+1). An
// unclosed string runs to the end of the text. A caller that knows the
// backslashes were doubled again passes a larger `modulus`.
const skipQuoted = (text: string, open: number, depth: number, modulus = 2 * (depth + 1)): number => {
  let end = open + 1
  while (end < text.length) {
    if (text[end] === text[open]) {
      let slashes = 0
      for (let i = end - 1; i > open && text[i] === "\\"; i--) slashes++
      if (slashes % modulus === depth) return end + 1
    }
    end++
  }
  return end
}

const closers: Readonly<Record<string, string>> = { "{": "}", "[": "]", "(": ")" }

// Returns the index just past the bracket that balances the one at `open`,
// skipping quoted strings at any escape depth. An unbalanced container runs
// to the end of the text.
const skipContainer = (text: string, open: number): number => {
  const pending: Array<string> = []
  let end = open
  while (end < text.length) {
    const char = text[end]!
    if (char === "\"" || char === "'") {
      let depth = 0
      while (text[end - 1 - depth] === "\\") depth++
      end = skipQuoted(text, end, depth)
      continue
    }
    const closer = closers[char]
    if (closer !== undefined) pending.push(closer)
    else if (char === pending.at(-1)) {
      pending.pop()
      if (pending.length === 0) return end + 1
    }
    end++
  }
  return end
}

// Whether the whitespace at `end` continues the bare value that began at
// `start`: `util.inspect` separates a constructor from its contents (`Foo {`,
// `Map(1) {`, `[Object: null prototype] {`, `new Password(`).
const continuesAcrossSpace = (text: string, start: number, end: number): number | undefined => {
  const run = text.slice(start, end)
  let next = end
  while (/\s/.test(text[next] ?? "")) next++
  if (run === "new") return next
  const prefix = /^[\w$.]+$/.test(run) || /[)\]]$/.test(run)
  return prefix && closers[text[next] ?? ""] !== undefined ? next : undefined
}

/**
 * A bracket or string still open at some point of the text: a bracket by the
 * closer that ends it, a string by its quote and escape depth.
 *
 * @private
 */
interface Open {
  readonly close: string
  readonly depth?: number
}

// The escape depth of a quote behind `slashes` backslashes: 2^k - 1 for its k
// trailing escaped levels, so `\\\\"` (an escaped backslash, then a quote) is
// depth 0 and `\\\\\\"` is depth 1.
const escapeDepth = (slashes: number): number => (slashes ^ (slashes + 1)) >> 1

// `Array.prototype.findLastIndex` is ES2023; consumers compile this source
// against ES2022 declarations.
const lastIndex = (stack: ReadonlyArray<Open>, matches: (open: Open) => boolean): number => {
  for (let index = stack.length - 1; index >= 0; index--) if (matches(stack[index]!)) return index
  return -1
}

const innermostString = (stack: ReadonlyArray<Open>): number => lastIndex(stack, (open) => open.depth !== undefined)

// Updates `stack` with the brackets and strings that `text[from, to)` opens
// and closes. A quote closes the innermost open string it can close at that
// string's escape depth, and otherwise opens a string at its own depth. The
// other quote character inside a string is content (`"don't"`).
const track = (stack: Array<Open>, text: string, from: number, to: number): void => {
  for (let i = from; i < to; i++) {
    const char = text[i]!
    if (char === "\"" || char === "'") {
      let slashes = 0
      while (text[i - 1 - slashes] === "\\") slashes++
      const inner = innermostString(stack)
      if (inner === -1) {
        stack.push({ close: char, depth: escapeDepth(slashes) })
        continue
      }
      // Every open string shares one quote character: the other is content.
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

// Whether the closer at `end` closes the bracket open before the key: it and
// any closers right after it balance the enclosing brackets, and a separator
// or the end of the text follows (`[{token:abc}]`, not `Tr0ub4dor)]&3`).
const closesEnclosing = (text: string, end: number, stack: ReadonlyArray<Open>): boolean => {
  let at = end
  for (let k = stack.length - 1; k >= 0 && stack[k]!.depth === undefined && text[at] === stack[k]!.close; k--) at++
  return at > end && /^(?:[\s,;"']|\\+["']|$)/.test(text.slice(at, at + 2))
}

// Returns the end of the unquoted value at `start`, read as a run of tokens:
// characters, balanced containers anywhere in it (`{bcrypt}$2a$...`,
// `Tr0ub(4dor)&3`), and quoted parameters in a header. A field value stops at
// whitespace, `,`, `;` or a quote; a header value runs to the end of its line
// unless it began as one container. `stack` is what is open before the key:
// either value stops at a quote that closes the enclosing string, and at a
// closer that closes the enclosing bracket. Any other closer is part of the
// value (`hunter2)`, `ab}}cd`).
const bareValueEnd = (
  text: string,
  start: number,
  header: boolean,
  stack: ReadonlyArray<Open>,
  nextKey: (from: number) => number
): number => {
  const inner = stack[innermostString(stack)]
  let end = start
  let limit = nextKey(start)
  if (header && closers[text[start]!] !== undefined) {
    end = skipContainer(text, start)
    if (!/^[^\s,;"'\\)\]}]/.test(text[end] ?? " ")) return end
  }
  while (end < text.length) {
    // A credential name at the top level of the value ends it; one inside a
    // container or quoted parameter the value consumed is redacted with it.
    if (end >= limit) {
      if (end === limit) break
      limit = nextKey(end)
      continue
    }
    const char = text[end]!
    if (closers[char] !== undefined) {
      end = skipContainer(text, end)
      continue
    }
    let depth = 0
    while (text[end + depth] === "\\") depth++
    const quote = text[end + depth]
    if (quote === "\"" || quote === "'") {
      // In a header, a quote deeper than the string the header was written in
      // opens a quoted parameter (`username="admin"`); one at that string's
      // depth or shallower closes it, whatever precedes it (`Basic abc=`),
      // unless a credential name and separator precede it (`credential:"`).
      if (
        !header ||
        (inner !== undefined && quote === inner.close && depth % (2 * (inner.depth! + 1)) <= inner.depth! &&
          !keyBefore.test(text.slice(start, end)))
      ) break
      end = skipQuoted(text, end + depth, depth)
      continue
    }
    if (header ? char === "\r" || char === "\n" : /[\s,;]/.test(char)) {
      const next = header || !/\s/.test(char) ? undefined : continuesAcrossSpace(text, start, end)
      if (next === undefined) break
      end = next
      continue
    }
    if (closesEnclosing(text, end, stack)) break
    end++
  }
  return end
}

// The index of the next credential or header name at or after `from`; with
// `quoted`, only a name written right after a quote.
const nextKey = (text: string, from: number, quoted: boolean): number => {
  anyKey.lastIndex = from
  for (let match = anyKey.exec(text); match !== null; match = anyKey.exec(text)) {
    if (!quoted || /["']/.test(text[match.index - 1]!)) return match.index
  }
  return text.length
}

// Redacts the value after each name in `names`, separated by `=`, `:` or
// `=>`. A quoted value is consumed whole at any string-escape depth, and an
// unquoted one as a run of tokens. If the bounded diagnostic ends inside
// either, the rest is redacted.
const redactValues = (text: string, names: string, header: boolean): string => {
  const keys = new RegExp(`(?:${names})${separator}`, "gi")
  let output = ""
  let position = 0
  // What is open before the current value. Values are skipped, so a bracket
  // or quote inside a credential never counts.
  const stack: Array<Open> = []
  let scanned = 0
  const next = (from: number, quoted: boolean) => nextKey(text, from, quoted)
  for (let match = keys.exec(text); match !== null; match = keys.exec(text)) {
    track(stack, text, scanned, keys.lastIndex)
    let start = keys.lastIndex
    let depth = 0
    while (text[start + depth] === "\\") depth++
    const opener = text[start + depth]
    const quote = opener === "\"" || opener === "'" ? opener : undefined
    let end: number
    if (quote !== undefined) {
      start += depth
      const inner = stack[innermostString(stack)]
      if (inner !== undefined) {
        // Inside a string written with the other quote character, every
        // backslash is doubled again: `inspect` renders `"a\"b"` as
        // `'"a\\"b"'`.
        end = skipQuoted(text, start, depth, (inner.close === quote ? 1 : 2 * (inner.depth! + 1)) * 2 * (depth + 1))
      } else {
        // No enclosing string is visible: raw text, or a string `track` cannot
        // see, such as an `inspect` backtick string with doubled backslashes.
        // Close no earlier than a doubled string would, but never past the
        // next credential name: at the undoubled close when only separators
        // precede that name (`"abc\\", password=`), else at the name.
        const undoubled = skipQuoted(text, start, depth)
        end = skipQuoted(text, start, depth, Math.max(4, 2 * (depth + 1)))
        const key = next(undoubled, false)
        if (key < end) end = /^[\s,;&]*$/.test(text.slice(undoubled, key)) ? undoubled : key
      }
    } else {
      // A bare value never runs into the next credential name, which the
      // following match or pass redacts. In a header a `name=` pair is part
      // of the value (`Cookie: csrftoken=a; sid=b`), so only a quoted name,
      // the next JSON key, ends it.
      end = bareValueEnd(text, start, header, stack, (from) => next(from, header))
    }
    const escape = quote === undefined ? "" : "\\".repeat(depth)
    output += text.slice(position, keys.lastIndex) + escape + (quote ?? "") + "[REDACTED]" +
      (quote !== undefined && text[end - 1] === quote ? escape + quote : "")
    position = end
    scanned = end
    keys.lastIndex = end
  }
  return output + text.slice(position)
}

const sanitizeDiagnosticText = (value: string): string =>
  redactValues(
    redactValues(value.slice(0, diagnosticTextLimit), headerName, true)
      .replace(/((?:bearer|basic)\s+)[^\s,;"'\\]+/gi, "$1[REDACTED]")
      // A request URL carries credentials as userinfo or as a signed query.
      .replace(/(\/\/)[^/@\s"'\\]+@/g, "$1[REDACTED]@")
      .replace(/([?&][\w.-]*(?:key|sig|signature|auth|credential)=)[^&#\s"'\\]+/gi, "$1[REDACTED]"),
    secretName,
    false
  )

const primitiveDiagnostic = (value: unknown): unknown => {
  switch (typeof value) {
    case "string":
      return sanitizeDiagnosticText(value)
    case "number":
      return Number.isFinite(value) ? value : `[${value > 0 ? "+" : "-"}non-finite number]`
    case "boolean":
      return value
    case "undefined":
      return "[undefined]"
    case "bigint":
      return `[bigint:${value.toString().slice(0, 64)}]`
    case "symbol":
      return "[symbol]"
    case "function":
      return "[function]"
    case "object":
      return value === null ? null : undefined
  }
}

const diagnosticKeys = [
  "_tag",
  "code",
  "name",
  "message",
  "value",
  "error",
  "cause",
  "failures",
  "reasons",
  "token",
  "secret",
  "password",
  "apiKey",
  "~effect/Effect/args"
] as const

const projectDiagnostic = (
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  field?: string
): unknown => {
  if (field !== undefined && secretField.test(field)) return "[REDACTED]"
  const primitive = primitiveDiagnostic(value)
  if (primitive !== undefined || value === undefined) {
    return primitive
  }
  if (depth === 0) return "[object]"
  const object = value as object
  if (seen.has(object)) return "[circular]"
  seen.add(object)
  if (Array.isArray(object)) {
    // Every Array exotic has one non-configurable numeric length data property;
    // reading its descriptor does not invoke a Proxy `get` trap or user code.
    const length = Object.getOwnPropertyDescriptor(object, "length")!.value as number
    const output: Array<unknown> = []
    const limit = Math.min(length, 8)
    for (let index = 0; index < limit; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(object, String(index))
      output.push(
        descriptor !== undefined && "value" in descriptor
          ? projectDiagnostic(descriptor.value, depth - 1, seen)
          : "[missing]"
      )
    }
    if (length > limit) output.push(`[${length - limit} more]`)
    return output
  }
  const output: Record<string, unknown> = {}
  for (const key of diagnosticKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (descriptor === undefined || !("value" in descriptor)) continue
    output[key] = projectDiagnostic(descriptor.value, depth - 1, seen, key)
  }
  return Object.keys(output).length === 0 ? "[object]" : output
}

/**
 * Renders only a fixed diagnostic vocabulary from inert own data properties.
 * It never enumerates an arbitrary object, invokes an accessor, calls a user
 * coercion hook, or retains an unbounded value. A hostile proxy can at most
 * make the renderer return the constant fallback.
 *
 * @private
 * @since 1.0.0
 */
export const renderDiagnostic = (value: unknown): string => {
  try {
    const projected = projectDiagnostic(value, 5, new WeakSet())
    return (typeof projected === "string" ? projected : JSON.stringify(projected)).slice(0, 4096)
  } catch {
    return "[unrenderable]"
  }
}
