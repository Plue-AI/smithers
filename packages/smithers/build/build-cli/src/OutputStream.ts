/**
 * Bounded, redacted live views of subprocess output; captured results stay untouched.
 * @since 1.0.0
 */

import * as Redaction from "@smthrs/journal/Redaction"
import { StringDecoder } from "node:string_decoder"
import { stripVTControlCharacters } from "node:util"
import * as Environment from "./Environment.ts"

/**
 * A per-process observer, with independent UTF-8 decoders for the two pipes.
 * @category models
 * @since 1.0.0
 */
export interface Observer {
  readonly onStdout: (chunk: Uint8Array) => void
  readonly onStderr: (chunk: Uint8Array) => void
  readonly close: () => void
}

/**
 * Shared progress-only redaction with the diagnostic rules, including known
 * values from credential-named variables.
 * @category constructors
 * @since 1.0.0
 */
export const redactor = (
  environment?: Readonly<Record<string, string | undefined>>,
  sensitiveNames?: ReadonlyArray<string>
): (text: string) => string => {
  const known = knownSecrets(environment, sensitiveNames)
  return (text) => {
    let clean = strip(text)
    if (known !== undefined) clean = clean.replace(known, "[REDACTED]")
    return String(Redaction.redactDiagnostic(clean))
  }
}

/** Strips terminal controls other than tab and newline. */
const strip = (text: string): string =>
  stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")

// The values of credential-named variables, as one pattern that matches the
// longest first.
const knownSecrets = (
  environment: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment(),
  sensitiveNames: ReadonlyArray<string> = []
): RegExp | undefined => {
  const sensitive = new Set(sensitiveNames)
  // These are documented process/mode switches, despite their credential-like
  // suffixes. An explicit sensitiveNames entry still overrides this list.
  const publicConfiguration = new Set(["CLAUDE_CODE_CHILD_SESSION", "SMITHERS_OPENAI_AUTH"])
  const values = [
    ...new Set(
      Object.entries(environment)
        .filter(([name, value]) =>
          value !== undefined && value !== "" &&
          (sensitive.has(name) || (!publicConfiguration.has(name) && Redaction.isSensitiveKey(name)))
        )
        .flatMap(([, value]) => [value!, ...value!.split(/\r?\n/).filter((part) => part !== "")])
    )
  ]
    .sort((left, right) => right.length - left.length)
  // Replace once so a short real secret cannot rewrite another secret's
  // replacement marker. Short credentials remain protected, even in tokens.
  return values.length === 0
    ? undefined
    : new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
}

/**
 * Complete lines are redacted before truncation or display, including split secrets
 * and values spanning lines (a PEM block, a `util.inspect` concatenation).
 * The shared line redactor bounds an overlong line and shows only
 * `Redaction.omittedLine` for it.
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: {
  readonly write: (stream: "stdout" | "stderr", text: string) => void
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly sensitiveNames?: ReadonlyArray<string> | undefined
  readonly maximumLines?: number | undefined
}): Observer => {
  const known = knownSecrets(options.environment, options.sensitiveNames)
  // Known values are a rule of the line redactor, so a value split across
  // chunks is still matched on its whole line.
  const rules = known === undefined
    ? Redaction.diagnosticRules
    : [{ id: "known-secret", pattern: known }, ...Redaction.diagnosticRules]
  const maximumLines = options.maximumLines ?? 200
  let printed = 0
  let closed = false
  const emit = (stream: "stdout" | "stderr", redacted: () => ReadonlyArray<string>): void => {
    if (printed > maximumLines) return
    try {
      for (const clean of redacted()) {
        if (printed > maximumLines) return
        if (printed === maximumLines) {
          printed += 1
          options.write(stream, "… live output limit reached; captured task output is unchanged\n")
          return
        }
        printed += 1
        options.write(stream, `${clean.slice(0, 1600)}${clean.length > 1600 ? " …" : ""}\n`)
      }
    } catch {
      // Progress observers cannot alter process success or captured output.
    }
  }
  const pipe = (stream: "stdout" | "stderr") => {
    const decoder = new StringDecoder("utf8")
    // The redactor owns the line still arriving: it holds a value that spans
    // lines until it closes and bounds an overlong line itself.
    const redactor = Redaction.lineRedactor(rules)
    const consume = (text: string): void => {
      const segments = strip(text).split("\n")
      const last = segments.pop()!
      for (const segment of segments) emit(stream, () => redactor.line(segment))
      if (last !== "") redactor.part(last)
    }
    return {
      write: (chunk: Uint8Array) => {
        if (!closed && printed <= maximumLines) consume(decoder.write(chunk))
      },
      close: () => {
        consume(decoder.end())
        emit(stream, redactor.flush)
      }
    }
  }
  const stdout = pipe("stdout")
  const stderr = pipe("stderr")
  return {
    onStdout: stdout.write,
    onStderr: stderr.write,
    close: () => {
      if (closed) return
      closed = true
      stdout.close()
      stderr.close()
    }
  }
}
