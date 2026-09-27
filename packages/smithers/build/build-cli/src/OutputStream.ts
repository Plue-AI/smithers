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
 * Shared progress-only redaction, including known values from credential-named variables.
 * @category constructors
 * @since 1.0.0
 */
export const redactor = (
  environment: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment(),
  sensitiveNames: ReadonlyArray<string> = []
): (text: string) => string => {
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
  const known = values.length === 0
    ? undefined
    : new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
  return (text) => {
    let clean = stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    if (known !== undefined) clean = clean.replace(known, "[REDACTED]")
    return String(Redaction.redact(clean))
  }
}

/**
 * Complete lines are redacted before truncation or display, including split secrets.
 * Overlong unterminated lines are discarded, never partially revealed.
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: {
  readonly write: (stream: "stdout" | "stderr", text: string) => void
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly sensitiveNames?: ReadonlyArray<string> | undefined
  readonly maximumLines?: number | undefined
}): Observer => {
  const redact = redactor(options.environment, options.sensitiveNames)
  const maximumLines = options.maximumLines ?? 200
  let printed = 0
  let closed = false
  const emit = (stream: "stdout" | "stderr", line: string): void => {
    if (printed > maximumLines) return
    try {
      if (printed === maximumLines) {
        printed += 1
        options.write(stream, "… live output limit reached; captured task output is unchanged\n")
        return
      }
      const clean = redact(line)
      printed += 1
      options.write(stream, `${clean.slice(0, 1600)}${clean.length > 1600 ? " …" : ""}\n`)
    } catch {
      // Progress observers cannot alter process success or captured output.
    }
  }
  const pipe = (stream: "stdout" | "stderr") => {
    const decoder = new StringDecoder("utf8")
    let pending = ""
    let discarding = false
    const consume = (text: string): void => {
      for (const segment of text.split(/(?<=\n)/)) {
        const complete = segment.endsWith("\n")
        if (!discarding) {
          pending += segment
          if (pending.length > 32 * 1024) {
            pending = ""
            discarding = true
          }
        }
        if (complete) {
          emit(stream, discarding ? "[overlong output line omitted]" : pending.replace(/\r?\n$/, ""))
          pending = ""
          discarding = false
        }
      }
    }
    return {
      write: (chunk: Uint8Array) => {
        if (!closed && printed <= maximumLines) consume(decoder.write(chunk))
      },
      close: () => {
        consume(decoder.end())
        if (discarding || pending !== "") emit(stream, discarding ? "[overlong output line omitted]" : pending)
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
