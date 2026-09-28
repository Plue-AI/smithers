/**
 * `!command` and `!!command`: a shell command the person runs, not the agent.
 *
 * Output streams as it arrives with ANSI stripped. `!` puts the result in
 * the next turn's context using pi's template; `!!` keeps it out.
 */
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { accessSync, appendFileSync, constants, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import * as Output from "./shell-output.ts"
import { stopGroup } from "./subprocess.ts"

/** The kept tail, and past it the full output goes to a file (pi's limits). */
export const maxLines = 2000
export const maxBytes = 50 * 1024

export interface Result {
  readonly command: string
  readonly output: string
  readonly exitCode: number | null
  readonly cancelled: boolean
  /** Where the untruncated output went, when the tail was cut. */
  readonly fullOutputPath?: string
}

export interface Running {
  readonly done: Promise<Result>
  readonly cancel: () => void
}

/** `!!cmd` → excluded, `!cmd` → included, anything else → not a shell line. */
export const parse = (line: string): { readonly command: string; readonly excluded: boolean } | undefined => {
  if (line.startsWith("!!")) return { command: line.slice(2).trim(), excluded: true }
  if (line.startsWith("!")) return { command: line.slice(1).trim(), excluded: false }
  return undefined
}

/** Terminal output as plain text: escapes removed, carriage returns normalized. */
export const clean = Output.clean

/** The last `maxLines` lines within `maxBytes`, and whether anything was cut. */
export const tail = (text: string): { readonly text: string; readonly truncated: boolean } => {
  let lines = text.split("\n")
  let truncated = false
  if (lines.length > maxLines) {
    lines = lines.slice(-maxLines)
    truncated = true
  }
  let kept = lines.join("\n")
  if (Buffer.byteLength(kept) > maxBytes) {
    const bytes = Buffer.from(kept)
    let start = bytes.length - maxBytes
    while ((bytes[start]! & 0xc0) === 0x80) start++
    kept = bytes.subarray(start).toString("utf8")
    kept = kept.slice(kept.indexOf("\n") + 1)
    truncated = true
  }
  return { text: kept, truncated }
}

/**
 * Masks the values of credential-named environment variables. The command
 * runs with the person's own environment, but its output is shown, saved to
 * the session and, for `!`, sent to the model.
 */
export const redact = Output.redact

/** Output kept in memory while a command runs; past it, only the tail stays and the rest streams to a file. */
const memory = 4 * maxBytes
/** Output reaches the screen at most this often. */
export const flushMs = 50
/** Give a stopped command time to clean up before killing its remaining process group. */
export const cancelGraceMs = 1000

/** Bash from PATH, when SHELL names no shell. */
const bashOnPath = (path: string | undefined): string | undefined => {
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "") continue
    const candidate = join(dir, "bash")
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here or not executable: try the next PATH entry.
    }
  }
  return undefined
}

export const run = (options: {
  readonly command: string
  readonly cwd: string
  readonly onOutput: (text: string) => void
  readonly env?: NodeJS.ProcessEnv
  /** Where over-limit output goes; the temp directory unless a test says otherwise. */
  readonly spillDir?: string
}): Running => {
  const env = options.env ?? process.env
  const shell = env.SHELL || bashOnPath(env.PATH) || "/bin/sh"
  const child = spawn(shell, ["-c", options.command], {
    cwd: options.cwd,
    env: { ...env, TERM: "dumb" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  })
  let kept = ""
  let bytes = 0
  let spill: string | undefined
  let unwritable = false
  let pending = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  let settled = false
  let stopping: Promise<void> | undefined
  const spillDir = options.spillDir ?? tmpdir()
  /** A full-output file that cannot be written costs only the file; the command and its tail go on. */
  const written = (write: () => void): boolean => {
    try {
      write()
      return true
    } catch {
      return false
    }
  }
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (pending === "") return
    const text = pending
    pending = ""
    options.onOutput(text)
  }
  const receive = (text: string) => {
    if (text === "") return
    bytes += Buffer.byteLength(text)
    if (spill === undefined && bytes > maxBytes && !unwritable) {
      const path = join(spillDir, `smithers-bash-${randomUUID()}.log`)
      if (written(() => writeFileSync(path, kept + text, { mode: 0o600 }))) spill = path
      else unwritable = true
    } else if (spill !== undefined && !written(() => appendFileSync(spill!, text))) {
      spill = undefined
      unwritable = true
    }
    kept = (kept + text).slice(-memory)
    if (kept.charCodeAt(0) >= 0xdc00 && kept.charCodeAt(0) <= 0xdfff) kept = kept.slice(1)
    pending += text
    timer ??= setTimeout(flush, flushMs)
  }
  const redactor = Output.redactor(env)
  for (const pipe of [child.stdout, child.stderr]) {
    const decoder = Output.decoder()
    pipe.on("data", (chunk: Buffer) => receive(redactor.write(decoder.write(chunk))))
    pipe.on("end", () => receive(redactor.write(decoder.end())))
  }
  const done = new Promise<Result>((resolve) => {
    const settle = async (exitCode: number | null) => {
      if (settled) return
      settled = true
      await stopping
      receive(redactor.end())
      flush()
      const cut = tail(kept)
      let fullOutputPath = spill
      if (cut.truncated && fullOutputPath === undefined && !unwritable) {
        const path = join(spillDir, `smithers-bash-${randomUUID()}.log`)
        if (written(() => writeFileSync(path, kept, { mode: 0o600 }))) fullOutputPath = path
      }
      resolve({
        command: options.command,
        output: cut.text.replace(/\n+$/, ""),
        exitCode,
        cancelled,
        ...(fullOutputPath === undefined ? {} : { fullOutputPath })
      })
    }
    child.on("close", (code) => settle(code))
    child.on("error", (error) => {
      receive(redactor.write(clean(`${error.message}\n`)))
      settle(127)
    })
  })
  return {
    done,
    cancel: () => {
      if (settled || cancelled) return
      cancelled = true
      if (child.pid !== undefined) {
        stopping = stopGroup(child.pid, cancelGraceMs).catch((error) => {
          receive(redactor.write(clean(`Could not stop process group: ${String(error)}\n`)))
        })
      }
    }
  }
}

/** What a session file keeps: a `!!` command's output stays out, like it stays out of the context. */
export const persisted = (result: Result, excluded: boolean): Result => {
  if (!excluded) return result
  const { fullOutputPath: _path, ...rest } = result
  return { ...rest, output: "" }
}

/** What the agent reads about a `!` command (pi's `bashExecution` template). */
export const contextText = (result: Result): string => {
  let text = `Ran \`${result.command}\`\n\`\`\`\n${result.output === "" ? "(no output)" : result.output}\n\`\`\``
  if (result.cancelled) text += "\n\n(command cancelled)"
  else if (result.exitCode !== null && result.exitCode !== 0) text += `\n\nCommand exited with code ${result.exitCode}`
  if (result.fullOutputPath !== undefined) text += `\n\n[Output truncated. Full output: ${result.fullOutputPath}]`
  return text
}
