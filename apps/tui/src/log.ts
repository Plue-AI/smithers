/** One private append-only diagnostic log; renderer output is not a durable sink. */
import * as Redaction from "@smthrs/journal/Redaction"
import { appendFileSync, chmodSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const path = (): string =>
  join(process.env.SMITHERS_TUI_SESSION_DIR ?? join(homedir(), ".smithers", "tui"), "tui.log")
const listeners = new Set<(message: string) => void>()
/** Subscribe to unexpected process failures while the terminal is mounted. */
export const subscribe = (listener: (message: string) => void): () => void => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
/** Record a failure the operator must see, and put it on the mounted terminal's status. */
export const alert = (tag: string, message: string): void => {
  write(tag, message)
  for (const listener of listeners) listener(message)
}
/**
 * A plain failure record, such as an `Unjudged`, by its fields: redacted by
 * value and key name before it is text, cycles named, and bounded.
 */
const fields = (value: object): string => {
  try {
    return JSON.stringify(Redaction.redact(value, { onTooDeep: "name" })).slice(0, 64_000)
  } catch {
    return String(value)
  }
}
/** Error.stack omits Error.cause; retain its chain without looping on cycles. */
const describe = (error: unknown, seen = new Set<unknown>()): string => {
  if (seen.has(error)) return "[circular cause]"
  if (seen.size >= 16) return "[cause chain truncated]"
  seen.add(error)
  if (!(error instanceof Error)) return typeof error === "object" && error !== null ? fields(error) : String(error)
  const own = error.stack ?? error.message
  return error.cause === undefined ? own : `${own}\nCaused by: ${describe(error.cause, seen)}`
}
/** Record the full cause, redacting credential-shaped text before writing. */
export const write = (tag: string, error: unknown): void => {
  const detail = describe(error)
  const redacted = String(Redaction.redactDiagnostic(detail))
  try {
    const file = path()
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), tag, detail: redacted }) + "\n", {
      mode: 0o600
    })
    chmodSync(file, 0o600)
  } catch {
    // A full disk must not replace the original failure with a logging failure.
  }
}
/** Observe fatal exceptions without suppressing Node's exit behavior. */
export const install = (): () => void => {
  const report = (tag: string, error: unknown) => {
    write(tag, error)
    for (const listener of listeners) listener("Terminal service failed")
  }
  const rejection = (error: unknown) => report("unhandled-rejection", error)
  const exception = (error: unknown) => report("uncaught-exception", error)
  const original = console.error
  const rendererError: typeof console.error = (...values) => {
    write("terminal.error", values.map((value) => describe(value)).join(" "))
    original(...values)
  }
  console.error = rendererError
  process.on("unhandledRejection", rejection)
  process.on("uncaughtExceptionMonitor", exception)
  return () => {
    if (console.error === rendererError) console.error = original
    process.off("unhandledRejection", rejection)
    process.off("uncaughtExceptionMonitor", exception)
  }
}
