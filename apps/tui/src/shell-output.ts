/** Stateful shell output decoding, terminal cleanup, and environment-value redaction. */
import { StringDecoder } from "node:string_decoder"

const secretName = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH/i
const secrets = (env: NodeJS.ProcessEnv): ReadonlyArray<readonly [string, string]> =>
  Object.entries(env)
    .flatMap(([name, value]) => {
      if (!secretName.test(name) || value === undefined || value.length < 8) return []
      // Output normalization must not make a CRLF or decorated secret unrecognizable.
      const displayed = clean(value)
      return [[name, value] as const, ...(displayed !== "" && displayed !== value ? [[name, displayed] as const] : [])]
    })
    .sort((a, b) => b[1].length - a[1].length)

/** A credential's complete value is replaced before any fragment reaches a sink. */
export const redactor = (env: NodeJS.ProcessEnv) => {
  const values = secrets(env)
  const names = new Map<string, string>()
  for (const [name, value] of values) if (!names.has(value)) names.set(value, name)
  const pattern = values.length === 0 ? undefined : new RegExp(
    [...names.keys()].map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "g"
  )
  let pending = ""
  const take = (text: string, final: boolean): string => {
    if (pattern === undefined) return text
    pending += text
    let end = pending.length
    if (!final) {
      for (const [, value] of values) {
        for (let length = Math.min(value.length - 1, pending.length); length > 0; length--) {
          if (pending.endsWith(value.slice(0, length))) {
            end = Math.min(end, pending.length - length)
            break
          }
        }
      }
      // A complete match wins over a partial candidate starting inside it.
      // Cutting that match in half would reveal its prefix on this write.
      pattern.lastIndex = 0
      for (const match of pending.matchAll(pattern)) {
        if (match.index >= end) break
        end = Math.max(end, match.index + match[0].length)
      }
    }
    const ready = pending.slice(0, end)
    pending = pending.slice(end)
    pattern.lastIndex = 0
    return ready.replace(pattern, (value) => `[redacted $${names.get(value)}]`)
  }
  return { write: (text: string) => take(text, false), end: () => take("", true) }
}

export const redact = (text: string, env: NodeJS.ProcessEnv): string => {
  const stream = redactor(env)
  return stream.write(text) + stream.end()
}

/** ANSI state is bounded even when an unfinished control string never terminates. */
const cleaner = () => {
  let state: "text" | "escape" | "intermediate" | "csi" | "osc" | "string" | "osc-escape" | "string-escape" = "text"
  let carriageReturn = false
  return (text: string): string => {
    let result = ""
    for (const character of text) {
      if (state === "osc" || state === "string" || state === "osc-escape" || state === "string-escape") {
        if (
          character === "\x9c" || (character === "\x07" && state.startsWith("osc")) ||
          (character === "\\" && state.endsWith("-escape"))
        ) state = "text"
        else if (character === "\x1b") state = state.startsWith("osc") ? "osc-escape" : "string-escape"
        else state = state.startsWith("osc") ? "osc" : "string"
        continue
      }
      if (character === "\x1b") {
        state = "escape"
        continue
      }
      if (state === "escape") {
        state = character === "[" ? "csi" : character === "]" ? "osc" : "PX^_".includes(character)
          ? "string" :
          character >= " " && character <= "/"
          ? "intermediate"
          : "text"
        continue
      }
      if (state === "csi" || state === "intermediate") {
        if (character >= (state === "csi" ? "@" : "0") && character <= "~") state = "text"
        continue
      }
      if (character === "\x9b") {
        state = "csi"
        continue
      }
      if (character === "\x9d") {
        state = "osc"
        continue
      }
      if (["\x90", "\x98", "\x9e", "\x9f"].includes(character)) {
        state = "string"
        continue
      }
      if (character === "\n" && carriageReturn) {
        carriageReturn = false
        continue
      }
      carriageReturn = character === "\r"
      result += carriageReturn ? "\n" : character
    }
    return result
  }
}

export const clean = (text: string): string => cleaner()(text)

/** One decoder/cleaner per pipe: stdout cannot complete a partial stderr character. */
export const decoder = () => {
  const utf8 = new StringDecoder("utf8")
  const plain = cleaner()
  return {
    write: (bytes: Buffer) => plain(utf8.write(bytes)),
    end: () => plain(utf8.end())
  }
}
